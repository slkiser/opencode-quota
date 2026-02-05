/**
 * OpenCode Quota Toast Plugin
 *
 * Shows a minimal quota status toast without LLM invocation.
 * Triggers on session.idle, session.compacted, and question tool completion.
 * Supports GitHub Copilot and Google (via opencode-antigravity-auth).
 */

import type { Plugin } from "@opencode-ai/plugin";
import type { QuotaToastConfig } from "./lib/types.js";
import { DEFAULT_CONFIG } from "./lib/types.js";
import { loadConfig, createLoadConfigMeta, type LoadConfigMeta } from "./lib/config.js";
import { getOrFetchWithCacheControl } from "./lib/cache.js";
import { formatQuotaRows } from "./lib/format.js";
import { formatQuotaCommand } from "./lib/quota-command-format.js";
import { getProviders } from "./providers/registry.js";
import type { QuotaToastEntry, QuotaToastError } from "./lib/entries.js";
import { tool } from "@opencode-ai/plugin";
import { aggregateUsage, getSessionTokenSummary, SessionNotFoundError } from "./lib/quota-stats.js";
import type { SessionTokensData } from "./lib/entries.js";
import { formatQuotaStatsReport } from "./lib/quota-stats-format.js";
import { buildQuotaStatusReport, type SessionTokenError } from "./lib/quota-status.js";
import { refreshGoogleTokensForAllAccounts } from "./lib/google.js";

// =============================================================================
// Types
// =============================================================================

/** Minimal client type for SDK compatibility */
interface OpencodeClient {
  config: {
    get: () => Promise<{
      data?: {
        model?: string;
        experimental?: {
          quotaToast?: Partial<QuotaToastConfig>;
        };
      };
    }>;
    providers: () => Promise<{
      data?: {
        providers: Array<{ id: string }>; // minimal shape
      };
    }>;
  };
  session: {
    get: (params: { path: { id: string } }) => Promise<{
      data?: {
        parentID?: string;
      };
    }>;
    prompt: (params: {
      path: { id: string };
      body: {
        noReply?: boolean;
        parts: Array<{ type: "text"; text: string; ignored?: boolean }>;
      };
    }) => Promise<unknown>;
  };
  tui: {
    showToast: (params: {
      body: {
        message: string;
        variant: "info" | "success" | "warning" | "error";
        duration?: number;
      };
    }) => Promise<unknown>;
  };
  app: {
    log: (params: {
      body: {
        service: string;
        level: "debug" | "info" | "warn" | "error";
        message: string;
        extra?: Record<string, unknown>;
      };
    }) => Promise<unknown>;
  };
}

/** Event type for plugin hooks */
interface PluginEvent {
  type: string;
  properties: {
    sessionID?: string;
    [key: string]: unknown;
  };
}

/** Tool execute hook input */
interface ToolExecuteInput {
  tool: string;
  sessionID: string;
}

/** Slash-command execute hook input (e.g. /quota_daily) */
interface CommandExecuteInput {
  command: string;
  arguments?: string;
  sessionID: string;
}

/** Config hook shape used to register built-in commands */
interface PluginConfigInput {
  command?: Record<string, { template: string; description: string }>;
}

// =============================================================================
// Token Report Command Specification
// =============================================================================

/** Parsed YYYY-MM-DD date components (module-level for use in command specs) */
type Ymd = { y: number; m: number; d: number };

/** Token report command IDs (new primary names) */
type TokenReportCommandId =
  | "tokens_today"
  | "tokens_daily"
  | "tokens_weekly"
  | "tokens_monthly"
  | "tokens_all"
  | "tokens_session"
  | "tokens_between";

/** Legacy command IDs (backwards-compatible aliases) */
type LegacyTokenCommandId =
  | "quota_today"
  | "quota_daily"
  | "quota_weekly"
  | "quota_monthly"
  | "quota_all"
  | "quota_session"
  | "quota_between";

/** Specification for a token report command */
type TokenReportCommandSpec =
  | {
      id: Exclude<TokenReportCommandId, "tokens_between">;
      legacyId: Exclude<LegacyTokenCommandId, "quota_between">;
      template: `/${string}`;
      legacyTemplate: `/${string}`;
      description: string;
      title: string;
      metadataTitle: string;
      kind: "rolling" | "today" | "all" | "session";
      windowMs?: number;
      topModels?: number;
      topSessions?: number;
    }
  | {
      id: "tokens_between";
      legacyId: "quota_between";
      template: "/tokens_between";
      legacyTemplate: "/quota_between";
      description: string;
      titleForRange: (startYmd: Ymd, endYmd: Ymd) => string;
      metadataTitle: string;
      kind: "between";
    };

/** All token report command specifications */
const TOKEN_REPORT_COMMANDS: readonly TokenReportCommandSpec[] = [
  {
    id: "tokens_today",
    legacyId: "quota_today",
    template: "/tokens_today",
    legacyTemplate: "/quota_today",
    description: "Token + official API cost summary for today (calendar day, local timezone).",
    title: "Tokens used (Today) (/tokens_today)",
    metadataTitle: "Tokens used (Today)",
    kind: "today",
  },
  {
    id: "tokens_daily",
    legacyId: "quota_daily",
    template: "/tokens_daily",
    legacyTemplate: "/quota_daily",
    description: "Token + official API cost summary for the last 24 hours (rolling).",
    title: "Tokens used (Last 24 Hours) (/tokens_daily)",
    metadataTitle: "Tokens used (Last 24 Hours)",
    kind: "rolling",
    windowMs: 24 * 60 * 60 * 1000,
  },
  {
    id: "tokens_weekly",
    legacyId: "quota_weekly",
    template: "/tokens_weekly",
    legacyTemplate: "/quota_weekly",
    description: "Token + official API cost summary for the last 7 days (rolling).",
    title: "Tokens used (Last 7 Days) (/tokens_weekly)",
    metadataTitle: "Tokens used (Last 7 Days)",
    kind: "rolling",
    windowMs: 7 * 24 * 60 * 60 * 1000,
  },
  {
    id: "tokens_monthly",
    legacyId: "quota_monthly",
    template: "/tokens_monthly",
    legacyTemplate: "/quota_monthly",
    description: "Token + official API cost summary for the last 30 days (rolling).",
    title: "Tokens used (Last 30 Days) (/tokens_monthly)",
    metadataTitle: "Tokens used (Last 30 Days)",
    kind: "rolling",
    windowMs: 30 * 24 * 60 * 60 * 1000,
  },
  {
    id: "tokens_all",
    legacyId: "quota_all",
    template: "/tokens_all",
    legacyTemplate: "/quota_all",
    description: "Token + official API cost summary for all locally saved OpenCode history.",
    title: "Tokens used (All Time) (/tokens_all)",
    metadataTitle: "Tokens used (All Time)",
    kind: "all",
    topModels: 12,
    topSessions: 12,
  },
  {
    id: "tokens_session",
    legacyId: "quota_session",
    template: "/tokens_session",
    legacyTemplate: "/quota_session",
    description: "Token + official API cost summary for current session only.",
    title: "Tokens used (Current Session) (/tokens_session)",
    metadataTitle: "Tokens used (Current Session)",
    kind: "session",
  },
  {
    id: "tokens_between",
    legacyId: "quota_between",
    template: "/tokens_between",
    legacyTemplate: "/quota_between",
    description: "Token + cost report between two YYYY-MM-DD dates (local timezone, inclusive).",
    titleForRange: (startYmd: Ymd, endYmd: Ymd) => {
      const formatYmd = (ymd: Ymd) => {
        const y = String(ymd.y).padStart(4, "0");
        const m = String(ymd.m).padStart(2, "0");
        const d = String(ymd.d).padStart(2, "0");
        return `${y}-${m}-${d}`;
      };
      return `Tokens used (${formatYmd(startYmd)} .. ${formatYmd(endYmd)}) (/tokens_between)`;
    },
    metadataTitle: "Tokens used (Date Range)",
    kind: "between",
  },
] as const;

/** Build a lookup map from command ID (both new and legacy) to spec */
const TOKEN_REPORT_COMMANDS_BY_ID: ReadonlyMap<string, TokenReportCommandSpec> = (() => {
  const map = new Map<string, TokenReportCommandSpec>();
  for (const spec of TOKEN_REPORT_COMMANDS) {
    map.set(spec.id, spec);
    map.set(spec.legacyId, spec);
  }
  return map;
})();

/** Check if a command is a token report command */
function isTokenReportCommand(cmd: string): cmd is TokenReportCommandId | LegacyTokenCommandId {
  return TOKEN_REPORT_COMMANDS_BY_ID.has(cmd);
}

// =============================================================================
// Plugin Implementation
// =============================================================================

/**
 * Main plugin export
 */
export const QuotaToastPlugin: Plugin = async ({ client }) => {
  const typedClient = client as unknown as OpencodeClient;

  /**
   * Inject tool output directly into the session without triggering an LLM response.
   * This prevents models from summarizing/rewriting our carefully formatted reports.
   */
  async function injectRawOutput(sessionID: string, output: string): Promise<void> {
    try {
      await typedClient.session.prompt({
        path: { id: sessionID },
        body: {
          noReply: true,
          // ignored=true keeps this out of future model context while still
          // showing it to the user in the transcript.
          parts: [{ type: "text", text: output, ignored: true }],
        },
      });
    } catch (err) {
      // Log but don't fail - the tool output will still be returned
      await typedClient.app.log({
        body: {
          service: "quota-toast",
          level: "warn",
          message: "Failed to inject raw output",
          extra: { error: err instanceof Error ? err.message : String(err) },
        },
      });
    }
  }

  // Keep init fast/non-blocking so TUI never hangs. We still want the first
  // toast trigger to work reliably, so we refresh config on-demand.
  let config: QuotaToastConfig = DEFAULT_CONFIG;
  let configLoaded = false;
  let configInFlight: Promise<void> | null = null;
  let configMeta: LoadConfigMeta = createLoadConfigMeta();

  // Track last session token error for /quota_status diagnostics
  let lastSessionTokenError: SessionTokenError | undefined;

  async function refreshConfig(): Promise<void> {
    if (configInFlight) return configInFlight;

    configInFlight = (async () => {
      try {
        configMeta = createLoadConfigMeta();
        config = await loadConfig(typedClient, configMeta);
        configLoaded = true;
      } catch {
        // Leave configLoaded=false so we can retry on next trigger.
        config = DEFAULT_CONFIG;
      } finally {
        configInFlight = null;
      }
    })();

    return configInFlight;
  }

  function parseOptionalJsonArgs(input: string | undefined):
    | {
        ok: true;
        value: Record<string, unknown>;
      }
    | {
        ok: false;
        error: string;
      } {
    const raw = input?.trim() || "";
    if (!raw) return { ok: true, value: {} };
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, error: 'Arguments must be a JSON object (e.g. {"force":true}).' };
      }
      return { ok: true, value: parsed as Record<string, unknown> };
    } catch {
      return { ok: false, error: "Failed to parse JSON arguments." };
    }
  }

  /**
   * Parse a YYYY-MM-DD string. Returns null if invalid format or invalid date.
   */
  function parseYyyyMmDd(input: string): Ymd | null {
    const pattern = /^\d{4}-\d{2}-\d{2}$/;
    if (!pattern.test(input)) return null;
    const [yStr, mStr, dStr] = input.split("-");
    const y = parseInt(yStr, 10);
    const m = parseInt(mStr, 10);
    const d = parseInt(dStr, 10);
    // Validate by round-trip: construct a Date and check components match
    const date = new Date(y, m - 1, d);
    if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) {
      return null; // Invalid date (e.g., 2026-02-31)
    }
    return { y, m, d };
  }

  /**
   * Get the start of a local day (midnight) in milliseconds.
   */
  function startOfLocalDayMs(ymd: Ymd): number {
    return new Date(ymd.y, ymd.m - 1, ymd.d).getTime();
  }

  /**
   * Get the start of the next local day (midnight of the following day) in milliseconds.
   * Used for inclusive end date: untilMs = startOfNextLocalDayMs(end) (exclusive upper bound).
   */
  function startOfNextLocalDayMs(ymd: Ymd): number {
    return new Date(ymd.y, ymd.m - 1, ymd.d + 1).getTime();
  }

  /**
   * Parse /quota_between arguments. Supports:
   * - Positional: "2026-01-01 2026-01-15"
   * - JSON: {"starting_date":"2026-01-01","ending_date":"2026-01-15"}
   */
  function parseQuotaBetweenArgs(
    input: string | undefined,
  ): { ok: true; startYmd: Ymd; endYmd: Ymd } | { ok: false; error: string } {
    const raw = input?.trim() || "";
    if (!raw) {
      return {
        ok: false,
        error: "Missing arguments. Expected two dates in YYYY-MM-DD format.",
      };
    }

    let startStr: string;
    let endStr: string;

    if (raw.startsWith("{")) {
      // JSON format
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        startStr = String(parsed["starting_date"] ?? parsed["startingDate"] ?? "");
        endStr = String(parsed["ending_date"] ?? parsed["endingDate"] ?? "");
      } catch {
        return { ok: false, error: "Failed to parse JSON arguments." };
      }
    } else {
      // Positional format: split on whitespace
      const parts = raw.split(/\s+/);
      if (parts.length !== 2) {
        return {
          ok: false,
          error: "Expected exactly two dates in YYYY-MM-DD format.",
        };
      }
      [startStr, endStr] = parts;
    }

    const startYmd = parseYyyyMmDd(startStr);
    if (!startYmd) {
      return { ok: false, error: `Invalid starting date: "${startStr}". Expected YYYY-MM-DD.` };
    }
    const endYmd = parseYyyyMmDd(endStr);
    if (!endYmd) {
      return { ok: false, error: `Invalid ending date: "${endStr}". Expected YYYY-MM-DD.` };
    }

    // Check end >= start
    const startMs = startOfLocalDayMs(startYmd);
    const endMs = startOfLocalDayMs(endYmd);
    if (endMs < startMs) {
      return {
        ok: false,
        error: `Ending date (${endStr}) is before starting date (${startStr}).`,
      };
    }

    return { ok: true, startYmd, endYmd };
  }

  /**
   * Format a Ymd as YYYY-MM-DD string.
   */
  function formatYmd(ymd: Ymd): string {
    const y = String(ymd.y).padStart(4, "0");
    const m = String(ymd.m).padStart(2, "0");
    const d = String(ymd.d).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  // Best-effort async init (do not await)
  void (async () => {
    await refreshConfig();

    try {
      await typedClient.app.log({
        body: {
          service: "quota-toast",
          level: "info",
          message: "plugin initialized",
          extra: {
            configLoaded,
            configSource: configMeta.source,
            configPaths: configMeta.paths,
            enabledProviders: config.enabledProviders,
            minIntervalMs: config.minIntervalMs,
            googleModels: config.googleModels,
            showOnIdle: config.showOnIdle,
            showOnQuestion: config.showOnQuestion,
            showOnCompact: config.showOnCompact,
            showOnBothFail: config.showOnBothFail,
          },
        },
      });
    } catch {
      // ignore
    }
  })();

  // If disabled in config, it'll be picked up on first trigger; we can't
  // reliably read config synchronously without risking TUI startup.

  /**
   * Log a message (debug level)
   */
  async function log(message: string, extra?: Record<string, unknown>): Promise<void> {
    try {
      await typedClient.app.log({
        body: {
          service: "quota-toast",
          level: "debug",
          message,
          extra,
        },
      });
    } catch {
      // Ignore logging errors
    }
  }

  /**
   * Check if session is a subagent session
   */
  async function isSubagentSession(sessionID: string): Promise<boolean> {
    try {
      const response = await typedClient.session.get({ path: { id: sessionID } });
      // Subagent sessions have a parentID
      return !!response.data?.parentID;
    } catch {
      // If we can't determine, assume it's a primary session
      return false;
    }
  }

  function formatDebugInfo(params: {
    trigger: string;
    reason: string;
    currentModel?: string;
    enabledProviders: string[];
    availability?: Array<{ id: string; ok: boolean }>;
  }): string {
    const availability = params.availability
      ? params.availability.map((x) => `${x.id}=${x.ok ? "ok" : "no"}`).join(" ")
      : "unknown";

    const providers =
      params.enabledProviders.length > 0 ? params.enabledProviders.join(",") : "(none)";

    const modelPart = params.currentModel ? ` model=${params.currentModel}` : "";

    const paths = configMeta.paths.length > 0 ? configMeta.paths.join(" | ") : "(none)";

    return [
      `Quota Toast Debug (opencode-quota)`,
      `trigger=${params.trigger} reason=${params.reason}`,
      `configSource=${configMeta.source} paths=${paths}`,
      `enabled=${config.enabled} providers=${providers}${modelPart}`,
      `available=${availability}`,
    ].join("\n");
  }

  async function fetchQuotaMessage(trigger: string, sessionID?: string): Promise<string | null> {
    // Ensure we have loaded config at least once. If load fails, we keep trying
    // on subsequent triggers.
    if (!configLoaded) {
      await refreshConfig();
    }

    if (!config.enabled) {
      return config.debug
        ? formatDebugInfo({ trigger, reason: "disabled", enabledProviders: [] })
        : null;
    }

    const providers = getProviders().filter((p) => config.enabledProviders.includes(p.id));

    // Providers are opt-in; when none are enabled, do nothing.
    if (providers.length === 0) {
      return config.debug
        ? formatDebugInfo({ trigger, reason: "enabledProviders empty", enabledProviders: [] })
        : null;
    }

    let currentModel: string | undefined;
    if (config.onlyCurrentModel) {
      try {
        const configResponse = await typedClient.config.get();
        currentModel = configResponse.data?.model;
      } catch {
        currentModel = undefined;
      }
    }

    const ctx = {
      client: typedClient,
      config: {
        googleModels: config.googleModels,
        toastStyle: config.toastStyle,
      },
    };

    const filtered =
      config.onlyCurrentModel && currentModel
        ? providers.filter((p) =>
            p.matchesCurrentModel ? p.matchesCurrentModel(currentModel!) : true,
          )
        : providers;

    // availability checks are cheap, do them in parallel
    const avail = await Promise.all(
      filtered.map(async (p) => ({ p, ok: await p.isAvailable(ctx) })),
    );
    const active = avail.filter((x) => x.ok).map((x) => x.p);

    if (active.length === 0) {
      return config.debug
        ? formatDebugInfo({
            trigger,
            reason: "no enabled providers available",
            currentModel,
            enabledProviders: config.enabledProviders,
            availability: avail.map((x) => ({ id: x.p.id, ok: x.ok })),
          })
        : null;
    }

    const results = await Promise.all(active.map((p) => p.fetch(ctx)));

    const entries: QuotaToastEntry[] = results.flatMap((r) => r.entries);
    const errors: QuotaToastError[] = results.flatMap((r) => r.errors);
    const attemptedAny = results.some((r) => r.attempted);

    // Fetch session tokens if enabled and sessionID is available
    let sessionTokens: SessionTokensData | undefined;
    if (config.showSessionTokens && sessionID) {
      try {
        const summary = await getSessionTokenSummary(sessionID);
        if (summary && summary.models.length > 0) {
          sessionTokens = {
            models: summary.models,
            totalInput: summary.totalInput,
            totalOutput: summary.totalOutput,
          };
        }
        // Clear any previous error on success
        lastSessionTokenError = undefined;
      } catch (err) {
        // Capture error for /quota_status diagnostics
        if (err instanceof SessionNotFoundError) {
          lastSessionTokenError = {
            sessionID: err.sessionID,
            error: err.message,
            checkedPath: err.checkedPath,
          };
        } else {
          lastSessionTokenError = {
            sessionID,
            error: err instanceof Error ? err.message : String(err),
          };
        }
        // Toast still displays without session tokens
      }
    }

    if (entries.length > 0) {
      const formatted = formatQuotaRows({
        version: "1.0.0",
        layout: config.layout,
        entries,
        errors,
        style: config.toastStyle,
        sessionTokens,
      });

      if (!config.debug) return formatted;

      const debugFooter = `\n\n[debug] src=${configMeta.source} providers=${config.enabledProviders.join(",") || "(none)"} avail=${avail
        .map((x) => `${x.p.id}:${x.ok ? "ok" : "no"}`)
        .join(" ")}`;

      return formatted + debugFooter;
    }

    if (config.showOnBothFail && attemptedAny && errors.length > 0) {
      if (!config.debug) return "Quota unavailable";
      return (
        "Quota unavailable" +
        "\n\n" +
        formatDebugInfo({
          trigger,
          reason: "all providers failed",
          currentModel,
          enabledProviders: config.enabledProviders,
          availability: avail.map((x) => ({ id: x.p.id, ok: x.ok })),
        })
      );
    }

    return config.debug
      ? formatDebugInfo({
          trigger,
          reason: "no entries",
          currentModel,
          enabledProviders: config.enabledProviders,
          availability: avail.map((x) => ({ id: x.p.id, ok: x.ok })),
        })
      : null;
  }

  /**
   * Show quota toast for a session
   */
  async function showQuotaToast(sessionID: string, trigger: string): Promise<void> {
    // Check if subagent session
    if (await isSubagentSession(sessionID)) {
      await log("Skipping toast for subagent session", { sessionID, trigger });
      return;
    }

    // Get or fetch quota (with caching/throttling)
    // If debug is enabled, bypass caching so the toast reflects current state.
    function shouldCacheToastMessage(msg: string): boolean {
      // Cache when we have any quota row (which always includes a "NN%" token).
      // Do not cache when output is only error rows (rendered as "label: message").
      const lines = msg.split("\n");
      return lines.some((l) => /\b\d{1,3}%\b/.test(l) && !/:\s/.test(l));
    }

    const message = config.debug
      ? await fetchQuotaMessage(trigger, sessionID)
      : await getOrFetchWithCacheControl(async () => {
          const msg = await fetchQuotaMessage(trigger, sessionID);
          const cache = msg ? shouldCacheToastMessage(msg) : true;
          return { message: msg, cache };
        }, config.minIntervalMs);

    if (!message) {
      await log("No quota message to display", { trigger });
      return;
    }

    if (!config.enableToast) {
      await log("Toast disabled (enableToast=false)", { trigger });
      return;
    }

    // Show toast
    try {
      await typedClient.tui.showToast({
        body: {
          message,
          variant: "info",
          duration: config.toastDurationMs,
        },
      });
      await log("Displayed quota toast", { message, trigger });
    } catch (err) {
      await log("Failed to show toast", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function fetchQuotaCommandMessage(
    trigger: string,
    sessionID?: string,
  ): Promise<string | null> {
    if (!configLoaded) await refreshConfig();
    if (!config.enabled) return null;

    const providers = getProviders().filter((p) => config.enabledProviders.includes(p.id));
    if (providers.length === 0) return null;

    const ctx = {
      client: typedClient,
      config: {
        googleModels: config.googleModels,
        // Always format /quota in grouped mode for a more dashboard-like look.
        toastStyle: "grouped" as const,
      },
    };

    const avail = await Promise.all(
      providers.map(async (p) => ({ p, ok: await p.isAvailable(ctx as any) })),
    );
    const active = avail.filter((x) => x.ok).map((x) => x.p);
    if (active.length === 0) return null;

    const results = await Promise.all(active.map((p) => p.fetch(ctx as any)));
    const entries = results.flatMap((r) => r.entries) as any[];
    const errors = results.flatMap((r) => r.errors);

    if (entries.length === 0) return null;

    // Fetch session tokens if enabled and sessionID is available
    let sessionTokens: SessionTokensData | undefined;
    if (config.showSessionTokens && sessionID) {
      try {
        const summary = await getSessionTokenSummary(sessionID);
        if (summary && summary.models.length > 0) {
          sessionTokens = {
            models: summary.models,
            totalInput: summary.totalInput,
            totalOutput: summary.totalOutput,
          };
        }
        // Clear any previous error on success
        lastSessionTokenError = undefined;
      } catch (err) {
        // Capture error for /quota_status diagnostics
        if (err instanceof SessionNotFoundError) {
          lastSessionTokenError = {
            sessionID: err.sessionID,
            error: err.message,
            checkedPath: err.checkedPath,
          };
        } else {
          lastSessionTokenError = {
            sessionID,
            error: err instanceof Error ? err.message : String(err),
          };
        }
        // Command still returns without session tokens
      }
    }

    return formatQuotaCommand({ entries, errors, sessionTokens });
  }

  async function buildQuotaReport(params: {
    title: string;
    sinceMs?: number;
    untilMs?: number;
    sessionID: string;
    topModels?: number;
    topSessions?: number;
    filterSessionID?: string;
    /** When true, hides Window/Sessions columns and Top Sessions section */
    sessionOnly?: boolean;
  }): Promise<string> {
    const result = await aggregateUsage({
      sinceMs: params.sinceMs,
      untilMs: params.untilMs,
      sessionID: params.filterSessionID,
    });
    return formatQuotaStatsReport({
      title: params.title,
      result,
      topModels: params.topModels,
      topSessions: params.topSessions,
      focusSessionID: params.sessionID,
      sessionOnly: params.sessionOnly,
    });
  }

  async function buildStatusReport(params: {
    refreshGoogleTokens?: boolean;
    skewMs?: number;
    force?: boolean;
  }): Promise<string> {
    await refreshConfig();

    let currentModel: string | undefined;
    try {
      const configResponse = await typedClient.config.get();
      currentModel = configResponse.data?.model;
    } catch {
      currentModel = undefined;
    }

    const providers = getProviders();
    const availability = await Promise.all(
      providers.map(async (p) => {
        let ok = false;
        try {
          ok = await p.isAvailable({
            client: typedClient,
            config: { googleModels: config.googleModels },
          });
        } catch {
          ok = false;
        }
        return {
          id: p.id,
          enabled: config.enabledProviders.includes(p.id),
          available: ok,
          matchesCurrentModel:
            typeof p.matchesCurrentModel === "function" && currentModel
              ? p.matchesCurrentModel(currentModel)
              : undefined,
        };
      }),
    );

    const refresh = params.refreshGoogleTokens
      ? await refreshGoogleTokensForAllAccounts({ skewMs: params.skewMs, force: params.force })
      : null;

    return await buildQuotaStatusReport({
      configSource: configMeta.source,
      configPaths: configMeta.paths,
      enabledProviders: config.enabledProviders,
      onlyCurrentModel: config.onlyCurrentModel,
      currentModel,
      providerAvailability: availability,
      googleRefresh: refresh
        ? {
            attempted: true,
            total: refresh.total,
            successCount: refresh.successCount,
            failures: refresh.failures,
          }
        : { attempted: false },
      sessionTokenError: lastSessionTokenError,
    });
  }

  // Return hook implementations
  return {
    // Register built-in slash commands (in addition to /tool quota_*)
    config: async (input: unknown) => {
      const cfg = input as PluginConfigInput;
      cfg.command ??= {};
      // Non-token commands (quota toast and diagnostics)
      cfg.command["quota"] = {
        template: "/quota",
        description: "Show quota toast output in chat.",
      };
      cfg.command["quota_status"] = {
        template: "/quota_status",
        description:
          "Diagnostics for toast + pricing + local storage (includes unknown pricing report).",
      };

      // Register token report commands (primary /tokens_* and legacy /quota_* aliases)
      for (const spec of TOKEN_REPORT_COMMANDS) {
        // Primary command (/tokens_*)
        cfg.command[spec.id] = {
          template: spec.template,
          description: spec.description,
        };
        // Legacy alias (/quota_*) for backwards compatibility
        cfg.command[spec.legacyId] = {
          template: spec.legacyTemplate,
          description: `${spec.description} (Legacy alias for /${spec.id})`,
        };
      }
    },

    "command.execute.before": async (input: CommandExecuteInput) => {
      const cmd = input.command;
      const sessionID = input.sessionID;

      if (cmd === "quota") {
        // Separate cache for /quota so it doesn't pollute the toast cache.
        let quotaCache = (globalThis as any).__opencodeQuotaCommandCache as
          | { message: string; timestamp: number; inFlight?: Promise<string | null> }
          | undefined;
        if (!quotaCache) {
          quotaCache = { message: "", timestamp: 0 };
          (globalThis as any).__opencodeQuotaCommandCache = quotaCache;
        }

        const now = Date.now();
        const cached =
          quotaCache.timestamp && now - quotaCache.timestamp < config.minIntervalMs
            ? quotaCache.message
            : null;

        const msg = cached
          ? cached
          : await (quotaCache.inFlight ??
              (quotaCache.inFlight = (async () => {
                try {
                  return await fetchQuotaCommandMessage("command:/quota", sessionID);
                } finally {
                  quotaCache!.inFlight = undefined;
                }
              })()));

        if (msg) {
          quotaCache.message = msg;
          quotaCache.timestamp = Date.now();
        }

        if (!msg) {
          await injectRawOutput(sessionID, "Quota unavailable");
          throw new Error("__QUOTA_COMMAND_HANDLED__");
        }

        await injectRawOutput(sessionID, msg);
        throw new Error("__QUOTA_COMMAND_HANDLED__");
      }

      const untilMs = Date.now();

      // Handle token report commands generically (both /tokens_* and legacy /quota_* aliases)
      if (isTokenReportCommand(cmd)) {
        const spec = TOKEN_REPORT_COMMANDS_BY_ID.get(cmd)!;

        if (spec.kind === "between") {
          // Special handling for date range command
          const parsed = parseQuotaBetweenArgs(input.arguments);
          if (!parsed.ok) {
            await injectRawOutput(
              sessionID,
              `Invalid arguments for /${spec.id}\n\n${parsed.error}\n\nExpected: /${spec.id} YYYY-MM-DD YYYY-MM-DD\nExample: /${spec.id} 2026-01-01 2026-01-15`,
            );
            throw new Error("__QUOTA_COMMAND_HANDLED__");
          }
          const sinceMs = startOfLocalDayMs(parsed.startYmd);
          const rangeUntilMs = startOfNextLocalDayMs(parsed.endYmd); // Exclusive upper bound for inclusive end date
          const out = await buildQuotaReport({
            title: spec.titleForRange(parsed.startYmd, parsed.endYmd),
            sinceMs,
            untilMs: rangeUntilMs,
            sessionID,
          });
          await injectRawOutput(sessionID, out);
          throw new Error("__QUOTA_COMMAND_HANDLED__");
        }

        // Non-between token report commands
        let sinceMs: number | undefined;
        let filterSessionID: string | undefined;
        let sessionOnly: boolean | undefined;
        let topModels: number | undefined;
        let topSessions: number | undefined;

        switch (spec.kind) {
          case "rolling":
            sinceMs = untilMs - spec.windowMs!;
            break;
          case "today": {
            const now = new Date();
            const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            sinceMs = startOfDay.getTime();
            break;
          }
          case "session":
            filterSessionID = sessionID;
            sessionOnly = true;
            break;
          case "all":
            topModels = spec.topModels;
            topSessions = spec.topSessions;
            break;
        }

        const out = await buildQuotaReport({
          title: spec.title,
          sinceMs,
          untilMs: spec.kind === "rolling" || spec.kind === "today" ? untilMs : undefined,
          sessionID,
          filterSessionID,
          sessionOnly,
          topModels,
          topSessions,
        });
        await injectRawOutput(sessionID, out);
        throw new Error("__QUOTA_COMMAND_HANDLED__");
      }

      // Handle /quota_status (diagnostics - not a token report)
      if (cmd === "quota_status") {
        const parsed = parseOptionalJsonArgs(input.arguments);
        if (!parsed.ok) {
          await injectRawOutput(
            sessionID,
            `Invalid arguments for /quota_status\n\n${parsed.error}\n\nExample:\n/quota_status {"refreshGoogleTokens": true}`,
          );
          throw new Error("__QUOTA_COMMAND_HANDLED__");
        }

        const out = await buildStatusReport({
          refreshGoogleTokens: parsed.value["refreshGoogleTokens"] === true,
          skewMs:
            typeof parsed.value["skewMs"] === "number"
              ? (parsed.value["skewMs"] as number)
              : undefined,
          force: parsed.value["force"] === true,
        });
        await injectRawOutput(sessionID, out);
        throw new Error("__QUOTA_COMMAND_HANDLED__");
      }
    },

    tool: {
      quota_daily: tool({
        description: "Token + official API cost summary for the last 24 hours (rolling).",
        args: {},
        async execute(_args, context) {
          const untilMs = Date.now();
          const sinceMs = untilMs - 24 * 60 * 60 * 1000;
          const out = await buildQuotaReport({
            title: "Tokens used (Last 24 Hours) (/tokens_daily)",
            sinceMs,
            untilMs,
            sessionID: context.sessionID,
          });
          context.metadata({ title: "Tokens used (Last 24 Hours)" });
          await injectRawOutput(context.sessionID, out);
          return ""; // Empty return - output already injected with noReply
        },
      }),

      quota_weekly: tool({
        description: "Token + official API cost summary for the last 7 days (rolling).",
        args: {},
        async execute(_args, context) {
          const untilMs = Date.now();
          const sinceMs = untilMs - 7 * 24 * 60 * 60 * 1000;
          const out = await buildQuotaReport({
            title: "Tokens used (Last 7 Days) (/tokens_weekly)",
            sinceMs,
            untilMs,
            sessionID: context.sessionID,
          });
          context.metadata({ title: "Tokens used (Last 7 Days)" });
          await injectRawOutput(context.sessionID, out);
          return ""; // Empty return - output already injected with noReply
        },
      }),

      quota_monthly: tool({
        description: "Token + official API cost summary for the last 30 days (rolling).",
        args: {},
        async execute(_args, context) {
          const untilMs = Date.now();
          const sinceMs = untilMs - 30 * 24 * 60 * 60 * 1000;
          const out = await buildQuotaReport({
            title: "Tokens used (Last 30 Days) (/tokens_monthly)",
            sinceMs,
            untilMs,
            sessionID: context.sessionID,
          });
          context.metadata({ title: "Tokens used (Last 30 Days)" });
          await injectRawOutput(context.sessionID, out);
          return ""; // Empty return - output already injected with noReply
        },
      }),

      quota_all: tool({
        description: "Token + official API cost summary for all locally saved OpenCode history.",
        args: {},
        async execute(_args, context) {
          const out = await buildQuotaReport({
            title: "Tokens used (All Time) (/tokens_all)",
            sessionID: context.sessionID,
            topModels: 12,
            topSessions: 12,
          });
          context.metadata({ title: "Tokens used (All Time)" });
          await injectRawOutput(context.sessionID, out);
          return ""; // Empty return - output already injected with noReply
        },
      }),

      quota_status: tool({
        description:
          "Diagnostics for toast + pricing + local storage (includes unknown pricing report).",
        args: {
          refreshGoogleTokens: tool.schema
            .boolean()
            .optional()
            .describe("If true, refresh Google Antigravity access tokens before reporting"),
          skewMs: tool.schema
            .number()
            .int()
            .min(0)
            .optional()
            .describe("Refresh tokens expiring within this window (ms). Default: 120000"),
          force: tool.schema
            .boolean()
            .optional()
            .describe("If true, refresh even if cached token looks valid"),
        },
        async execute(args, context) {
          const out = await buildStatusReport({
            refreshGoogleTokens: args.refreshGoogleTokens,
            skewMs: args.skewMs,
            force: args.force,
          });
          context.metadata({ title: "Quota Status" });
          await injectRawOutput(context.sessionID, out);
          return ""; // Empty return - output already injected with noReply
        },
      }),

      quota_today: tool({
        description: "Token + official API cost summary for today (calendar day, local timezone).",
        args: {},
        async execute(_args, context) {
          const now = new Date();
          const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          const sinceMs = startOfDay.getTime();
          const untilMs = now.getTime();
          const out = await buildQuotaReport({
            title: "Tokens used (Today) (/tokens_today)",
            sinceMs,
            untilMs,
            sessionID: context.sessionID,
          });
          context.metadata({ title: "Tokens used (Today)" });
          await injectRawOutput(context.sessionID, out);
          return ""; // Empty return - output already injected with noReply
        },
      }),

      quota_session: tool({
        description: "Token + official API cost summary for current session only.",
        args: {},
        async execute(_args, context) {
          const out = await buildQuotaReport({
            title: "Tokens used (Current Session) (/tokens_session)",
            sessionID: context.sessionID,
            filterSessionID: context.sessionID,
            sessionOnly: true,
          });
          context.metadata({ title: "Tokens used (Current Session)" });
          await injectRawOutput(context.sessionID, out);
          return ""; // Empty return - output already injected with noReply
        },
      }),

      quota_between: tool({
        description:
          "Token + official API cost summary between two YYYY-MM-DD dates (local timezone, inclusive).",
        args: {
          startingDate: tool.schema
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .describe("Starting date in YYYY-MM-DD format (local timezone)"),
          endingDate: tool.schema
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .describe("Ending date in YYYY-MM-DD format (local timezone, inclusive)"),
        },
        async execute(args, context) {
          const startYmd = parseYyyyMmDd(args.startingDate);
          if (!startYmd) {
            await injectRawOutput(
              context.sessionID,
              `Invalid starting date: "${args.startingDate}". Expected YYYY-MM-DD.`,
            );
            return "";
          }
          const endYmd = parseYyyyMmDd(args.endingDate);
          if (!endYmd) {
            await injectRawOutput(
              context.sessionID,
              `Invalid ending date: "${args.endingDate}". Expected YYYY-MM-DD.`,
            );
            return "";
          }
          const startMs = startOfLocalDayMs(startYmd);
          const endMs = startOfLocalDayMs(endYmd);
          if (endMs < startMs) {
            await injectRawOutput(
              context.sessionID,
              `Ending date (${args.endingDate}) is before starting date (${args.startingDate}).`,
            );
            return "";
          }
          const sinceMs = startMs;
          const untilMs = startOfNextLocalDayMs(endYmd); // Exclusive upper bound for inclusive end date
          const startStr = formatYmd(startYmd);
          const endStr = formatYmd(endYmd);
          const out = await buildQuotaReport({
            title: `Tokens used (${startStr} .. ${endStr}) (/tokens_between)`,
            sinceMs,
            untilMs,
            sessionID: context.sessionID,
          });
          context.metadata({ title: "Tokens used (Date Range)" });
          await injectRawOutput(context.sessionID, out);
          return ""; // Empty return - output already injected with noReply
        },
      }),
    },

    // Event hook for session.idle and session.compacted
    event: async ({ event }: { event: PluginEvent }) => {
      const sessionID = event.properties.sessionID;
      if (!sessionID) return;

      if (event.type === "session.idle" && config.showOnIdle) {
        await showQuotaToast(sessionID, "session.idle");
      } else if (event.type === "session.compacted" && config.showOnCompact) {
        await showQuotaToast(sessionID, "session.compacted");
      }
    },

    // Tool execute hook for question tool
    "tool.execute.after": async (input: ToolExecuteInput) => {
      if (input.tool === "question" && config.showOnQuestion) {
        await showQuotaToast(input.sessionID, "question");
      }
    },
  };
};
