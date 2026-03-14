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
import { formatQuotaCommandBody } from "./lib/quota-command-format.js";
import { getProviders } from "./providers/registry.js";
import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
  QuotaToastError,
  SessionTokensData,
} from "./lib/entries.js";
import { tool } from "@opencode-ai/plugin";
import { aggregateUsage } from "./lib/quota-stats.js";
import { fetchSessionTokensForDisplay } from "./lib/session-tokens.js";
import { formatQuotaStatsReport } from "./lib/quota-stats-format.js";
import { buildQuotaStatusReport, type SessionTokenError } from "./lib/quota-status.js";
import { maybeRefreshPricingSnapshot } from "./lib/modelsdev-pricing.js";
import { refreshGoogleTokensForAllAccounts } from "./lib/google.js";
import { getQuotaProviderDisplayLabel } from "./lib/provider-metadata.js";
import {
  DEFAULT_ALIBABA_AUTH_CACHE_MAX_AGE_MS,
  isAlibabaModelId,
  resolveAlibabaCodingPlanAuthCached,
} from "./lib/alibaba-auth.js";
import {
  isQwenCodeModelId,
  resolveQwenLocalPlanCached,
} from "./lib/qwen-auth.js";
import {
  recordAlibabaCodingPlanCompletion,
  recordQwenCompletion,
} from "./lib/qwen-local-quota.js";
import {
  parseOptionalJsonArgs,
  parseQuotaBetweenArgs,
  startOfLocalDayMs,
  startOfNextLocalDayMs,
  formatYmd,
  type Ymd,
} from "./lib/command-parsing.js";
import { handled } from "./lib/command-handled.js";
import { renderCommandHeading } from "./lib/format-utils.js";

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
        modelID?: string;
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
interface ToolExecuteAfterInput {
  tool: string;
  sessionID: string;
  callID: string;
}

/** Tool execute hook output */
interface ToolExecuteAfterOutput {
  title: string;
  output: string;
  metadata: unknown;
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

/** Token report command IDs */
type TokenReportCommandId =
  | "tokens_today"
  | "tokens_daily"
  | "tokens_weekly"
  | "tokens_monthly"
  | "tokens_all"
  | "tokens_session"
  | "tokens_between";

/** Specification for a token report command */
type TokenReportCommandSpec =
  | {
      id: Exclude<TokenReportCommandId, "tokens_between">;
      template: `/${string}`;
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
      template: "/tokens_between";
      description: string;
      titleForRange: (startYmd: Ymd, endYmd: Ymd) => string;
      metadataTitle: string;
      kind: "between";
    };

/** All token report command specifications */
const TOKEN_REPORT_COMMANDS: readonly TokenReportCommandSpec[] = [
  {
    id: "tokens_today",
    template: "/tokens_today",
    description: "Token + official API cost summary for today (calendar day, local timezone).",
    title: "Tokens used (Today) (/tokens_today)",
    metadataTitle: "Tokens used (Today)",
    kind: "today",
  },
  {
    id: "tokens_daily",
    template: "/tokens_daily",
    description: "Token + official API cost summary for the last 24 hours (rolling).",
    title: "Tokens used (Last 24 Hours) (/tokens_daily)",
    metadataTitle: "Tokens used (Last 24 Hours)",
    kind: "rolling",
    windowMs: 24 * 60 * 60 * 1000,
  },
  {
    id: "tokens_weekly",
    template: "/tokens_weekly",
    description: "Token + official API cost summary for the last 7 days (rolling).",
    title: "Tokens used (Last 7 Days) (/tokens_weekly)",
    metadataTitle: "Tokens used (Last 7 Days)",
    kind: "rolling",
    windowMs: 7 * 24 * 60 * 60 * 1000,
  },
  {
    id: "tokens_monthly",
    template: "/tokens_monthly",
    description: "Token + official API cost summary for the last 30 days (rolling).",
    title: "Tokens used (Last 30 Days) (/tokens_monthly)",
    metadataTitle: "Tokens used (Last 30 Days)",
    kind: "rolling",
    windowMs: 30 * 24 * 60 * 60 * 1000,
  },
  {
    id: "tokens_all",
    template: "/tokens_all",
    description: "Token + official API cost summary for all locally saved OpenCode history.",
    title: "Tokens used (All Time) (/tokens_all)",
    metadataTitle: "Tokens used (All Time)",
    kind: "all",
    topModels: 12,
    topSessions: 12,
  },
  {
    id: "tokens_session",
    template: "/tokens_session",
    description: "Token + official API cost summary for current session only.",
    title: "Tokens used (Current Session) (/tokens_session)",
    metadataTitle: "Tokens used (Current Session)",
    kind: "session",
  },
  {
    id: "tokens_between",
    template: "/tokens_between",
    description: "Token + cost report between two YYYY-MM-DD dates (local timezone, inclusive).",
    titleForRange: (startYmd: Ymd, endYmd: Ymd) => {
      return `Tokens used (${formatYmd(startYmd)} .. ${formatYmd(endYmd)}) (/tokens_between)`;
    },
    metadataTitle: "Tokens used (Date Range)",
    kind: "between",
  },
] as const;

/** Build a lookup map from command ID to spec */
const TOKEN_REPORT_COMMANDS_BY_ID: ReadonlyMap<TokenReportCommandId, TokenReportCommandSpec> =
  (() => {
    const map = new Map<TokenReportCommandId, TokenReportCommandSpec>();
    for (const spec of TOKEN_REPORT_COMMANDS) {
      map.set(spec.id, spec);
    }
    return map;
  })();

/** Check if a command is a token report command */
function isTokenReportCommand(cmd: string): cmd is TokenReportCommandId {
  return TOKEN_REPORT_COMMANDS_BY_ID.has(cmd as TokenReportCommandId);
}

// =============================================================================
// Plugin Implementation
// =============================================================================

const LOCAL_REQUEST_PLAN_PROVIDER_IDS = new Set(["qwen-code", "alibaba-coding-plan"]);

type QuotaCommandCacheEntry = {
  body: string;
  timestamp: number;
  inFlight?: Promise<string | null>;
};

/**
 * Main plugin export
 */
export const QuotaToastPlugin: Plugin = async ({ client }) => {
  const typedClient = client as unknown as OpencodeClient;
  const TOOL_FAILURE_STATUSES = new Set(["error", "failed", "failure", "cancelled", "canceled"]);
  const TOOL_SUCCESS_STATUSES = new Set(["success", "ok", "completed", "complete"]);

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

  type ProviderFetchCacheEntry = {
    timestamp: number;
    result?: QuotaProviderResult;
    inFlight?: Promise<QuotaProviderResult>;
  };

  const providerFetchCache = new Map<string, ProviderFetchCacheEntry>();

  function getQuotaCommandCache(): QuotaCommandCacheEntry {
    let quotaCache = (globalThis as any).__opencodeQuotaCommandCache as
      | QuotaCommandCacheEntry
      | undefined;
    if (!quotaCache) {
      quotaCache = { body: "", timestamp: 0 };
      (globalThis as any).__opencodeQuotaCommandCache = quotaCache;
    }
    return quotaCache;
  }

  function clearQuotaCommandCache(): void {
    const quotaCache = (globalThis as any).__opencodeQuotaCommandCache as
      | QuotaCommandCacheEntry
      | undefined;
    if (!quotaCache) return;
    quotaCache.body = "";
    quotaCache.timestamp = 0;
    quotaCache.inFlight = undefined;
  }

  function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  }

  function evaluateToolOutcome(candidate: Record<string, unknown>): boolean | null {
    if (typeof candidate.ok === "boolean") return candidate.ok;
    if (typeof candidate.success === "boolean") return candidate.success;

    const statusRaw = candidate.status;
    if (typeof statusRaw === "string") {
      const status = statusRaw.toLowerCase();
      if (TOOL_FAILURE_STATUSES.has(status)) return false;
      if (TOOL_SUCCESS_STATUSES.has(status)) return true;
    }

    if (candidate.error !== undefined && candidate.error !== null) return false;

    const exitCode = candidate.exitCode;
    if (typeof exitCode === "number" && Number.isFinite(exitCode)) {
      return exitCode === 0;
    }

    return null;
  }

  function isSuccessfulQuestionExecution(output: ToolExecuteAfterOutput): boolean {
    const metadata = asRecord(output.metadata);
    const metadataOutcome = metadata ? evaluateToolOutcome(metadata) : null;
    if (metadataOutcome !== null) return metadataOutcome;

    const result = metadata ? asRecord(metadata.result) : null;
    const resultOutcome = result ? evaluateToolOutcome(result) : null;
    if (resultOutcome !== null) return resultOutcome;

    // Fallback: keep behavior permissive if runtime omits explicit success state.
    const title = output.title.trim().toLowerCase();
    if (title.startsWith("error") || title.includes("failed")) return false;

    return true;
  }

  function makeProviderFetchCacheKey(providerId: string, ctx: QuotaProviderContext): string {
    const style = ctx.config.toastStyle ?? "classic";
    const googleModels = ctx.config.googleModels.join(",");
    const alibabaCodingPlanTier = ctx.config.alibabaCodingPlanTier;
    const onlyCurrentModel = ctx.config.onlyCurrentModel ? "yes" : "no";
    const currentModel = ctx.config.currentModel ?? "";
    return `${providerId}|style=${style}|googleModels=${googleModels}|alibabaTier=${alibabaCodingPlanTier}|onlyCurrentModel=${onlyCurrentModel}|currentModel=${currentModel}`;
  }

  async function fetchProviderWithCache(params: {
    provider: QuotaProvider;
    ctx: QuotaProviderContext;
    ttlMs: number;
  }): Promise<QuotaProviderResult> {
    const { provider, ctx, ttlMs } = params;

    // Local request-plan providers should update per completion for accurate rolling counters.
    if (LOCAL_REQUEST_PLAN_PROVIDER_IDS.has(provider.id)) {
      return await provider.fetch(ctx);
    }

    const cacheKey = makeProviderFetchCacheKey(provider.id, ctx);
    const now = Date.now();
    const existing = providerFetchCache.get(cacheKey);

    if (
      existing?.result &&
      existing.timestamp > 0 &&
      ttlMs > 0 &&
      now - existing.timestamp < ttlMs
    ) {
      return existing.result;
    }

    if (existing?.inFlight) {
      return existing.inFlight;
    }

    const promise = (async () => {
      try {
        const result = await provider.fetch(ctx);
        if (result.attempted) {
          providerFetchCache.set(cacheKey, { timestamp: Date.now(), result });
        } else {
          providerFetchCache.delete(cacheKey);
        }
        return result;
      } catch (err) {
        providerFetchCache.delete(cacheKey);
        throw err;
      }
    })();

    providerFetchCache.set(cacheKey, {
      timestamp: existing?.timestamp ?? 0,
      result: existing?.result,
      inFlight: promise,
    });

    return promise;
  }

  async function shouldBypassToastCacheForLocalRequestPlan(
    trigger: string,
    sessionID: string,
  ): Promise<boolean> {
    if (trigger !== "question") return false;

    const currentModel = await getCurrentModel(sessionID);
    if (isQwenCodeModelId(currentModel)) {
      const plan = await resolveQwenLocalPlanCached();
      return (
        plan.state === "qwen_free" &&
        (config.enabledProviders === "auto" || config.enabledProviders.includes("qwen-code"))
      );
    }

    if (isAlibabaModelId(currentModel)) {
      const plan = await resolveAlibabaCodingPlanAuthCached({
        maxAgeMs: DEFAULT_ALIBABA_AUTH_CACHE_MAX_AGE_MS,
        fallbackTier: config.alibabaCodingPlanTier,
      });
      return (
        plan.state === "configured" &&
        (config.enabledProviders === "auto" ||
          config.enabledProviders.includes("alibaba-coding-plan"))
      );
    }

    return false;
  }

  async function shouldBypassQuotaCommandCache(sessionID?: string): Promise<boolean> {
    if (config.debug || !sessionID) return config.debug;
    return await shouldBypassToastCacheForLocalRequestPlan("question", sessionID);
  }

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

  async function kickPricingRefresh(params: {
    reason: "init" | "tokens" | "status";
    maxWaitMs?: number;
  }): Promise<void> {
    try {
      const refreshPromise = maybeRefreshPricingSnapshot({ reason: params.reason });
      const guardedRefreshPromise = refreshPromise.catch(() => undefined);
      if (!params.maxWaitMs || params.maxWaitMs <= 0) {
        void guardedRefreshPromise;
        return;
      }

      await Promise.race([
        guardedRefreshPromise,
        new Promise<void>((resolve) => {
          setTimeout(resolve, params.maxWaitMs);
        }),
      ]);
    } catch (error) {
      await log("Pricing refresh failed", {
        reason: params.reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Best-effort async init (do not await)
  void (async () => {
    await refreshConfig();
    if (config.enabled) {
      void kickPricingRefresh({ reason: "init" });
    }

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

  /**
   * Get the current model from the active session.
   *
   * Only uses session-scoped model lookup. Does NOT fall back to
   * client.config.get() because that returns the global/default model
   * which can be stale across sessions.
   */
  async function getCurrentModel(sessionID?: string): Promise<string | undefined> {
    if (!sessionID) return undefined;
    try {
      const sessionResp = await typedClient.session.get({ path: { id: sessionID } });
      return sessionResp.data?.modelID;
    } catch {
      return undefined;
    }
  }

  function formatDebugInfo(params: {
    trigger: string;
    reason: string;
    currentModel?: string;
    enabledProviders: string[] | "auto";
    availability?: Array<{ id: string; ok: boolean }>;
  }): string {
    const availability = params.availability
      ? params.availability.map((x) => `${x.id}=${x.ok ? "ok" : "no"}`).join(" ")
      : "unknown";

    const providers =
      params.enabledProviders === "auto"
        ? "(auto)"
        : params.enabledProviders.length > 0
          ? params.enabledProviders.join(",")
          : "(none)";

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

    const allProviders = getProviders();
    const isAutoMode = config.enabledProviders === "auto";
    const enabledProviderIds = isAutoMode ? [] : config.enabledProviders;

    // When enabledProviders is "auto", we'll filter by availability below.
    // When explicit, filter to just the listed providers.
    const providers = isAutoMode
      ? allProviders
      : allProviders.filter((p) => enabledProviderIds.includes(p.id));

    // Only bail on empty if user explicitly configured an empty list.
    if (!isAutoMode && providers.length === 0) {
      return config.debug
        ? formatDebugInfo({ trigger, reason: "enabledProviders empty", enabledProviders: [] })
        : null;
    }

    let currentModel: string | undefined;
    if (config.onlyCurrentModel) {
      currentModel = await getCurrentModel(sessionID);
    }

    const ctx: QuotaProviderContext = {
      client: typedClient,
      config: {
        googleModels: config.googleModels,
        alibabaCodingPlanTier: config.alibabaCodingPlanTier,
        toastStyle: config.toastStyle,
        onlyCurrentModel: config.onlyCurrentModel,
        currentModel,
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

    const results = await Promise.all(
      active.map((p) =>
        fetchProviderWithCache({
          provider: p,
          ctx,
          ttlMs: config.minIntervalMs,
        }),
      ),
    );

    const entries: QuotaToastEntry[] = results.flatMap((r) => r.entries);
    const errors: QuotaToastError[] = results.flatMap((r) => r.errors);
    const attemptedAny = results.some((r) => r.attempted);

    let hasExplicitProviderIssues = false;

    // When enabledProviders is an explicit list, surface "Not configured" errors
    // for providers that returned attempted:false with no entries/errors.
    // This prevents silently omitting providers that users explicitly requested.
    if (!isAutoMode) {
      for (let i = 0; i < active.length; i++) {
        const provider = active[i];
        const result = results[i];
        if (!result.attempted && result.entries.length === 0 && result.errors.length === 0) {
          errors.push({
            label: getQuotaProviderDisplayLabel(provider.id),
            message: "Not configured",
          });
          hasExplicitProviderIssues = true;
        }
      }

      // If a user explicitly enabled providers that are unavailable (or skipped due
      // to model filtering), surface that instead of silently omitting them.
      const filteredIds = new Set(filtered.map((p) => p.id));
      const activeIds = new Set(active.map((p) => p.id));
      const availById = new Map(avail.map((x) => [x.p.id, x.ok] as const));

      for (const p of providers) {
        if (activeIds.has(p.id)) continue;

        if (!filteredIds.has(p.id)) {
          const detail =
            config.onlyCurrentModel && currentModel ? `current model: ${currentModel}` : "filtered";
          errors.push({
            label: getQuotaProviderDisplayLabel(p.id),
            message: `Skipped (${detail})`,
          });
          hasExplicitProviderIssues = true;
          continue;
        }

        const ok = availById.get(p.id);
        if (ok === false) {
          errors.push({
            label: getQuotaProviderDisplayLabel(p.id),
            message: "Unavailable (not detected)",
          });
          hasExplicitProviderIssues = true;
        }
      }
    }

    // Fetch session tokens if enabled and sessionID is available
    let sessionTokens: SessionTokensData | undefined;
    if (config.showSessionTokens && sessionID) {
      const stResult = await fetchSessionTokensForDisplay({
        enabled: config.showSessionTokens,
        sessionID,
      });
      sessionTokens = stResult.sessionTokens;
      // Update diagnostics state: clear on success (no error returned), set on failure
      lastSessionTokenError = stResult.error;
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

      const debugFooter = `\n\n[debug] src=${configMeta.source} providers=${config.enabledProviders === "auto" ? "(auto)" : config.enabledProviders.join(",") || "(none)"} avail=${avail
        .map((x) => `${x.p.id}:${x.ok ? "ok" : "no"}`)
        .join(" ")}`;

      return formatted + debugFooter;
    }

    // Show errors even without entries when:
    // 1. showOnBothFail is enabled and at least one provider attempted (existing behavior)
    // 2. OR we're in explicit mode and have "Not configured"/"Unavailable" errors (new behavior)
    if ((config.showOnBothFail && attemptedAny && errors.length > 0) || hasExplicitProviderIssues) {
      // Format errors as individual lines
      const errorLines = errors.map((e) => `${e.label}: ${e.message}`).join("\n");
      if (!config.debug) return errorLines || "Quota unavailable";
      return (
        (errorLines || "Quota unavailable") +
        "\n\n" +
        formatDebugInfo({
          trigger,
          reason: hasExplicitProviderIssues
            ? "providers missing/unavailable"
            : "all providers failed",
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
    if (!configLoaded) {
      await refreshConfig();
    }

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

    const bypassMessageCache = config.debug
      ? true
      : await shouldBypassToastCacheForLocalRequestPlan(trigger, sessionID);

    const message = bypassMessageCache
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

  async function fetchQuotaCommandBody(
    trigger: string,
    sessionID?: string,
  ): Promise<string | null> {
    if (!configLoaded) await refreshConfig();
    if (!config.enabled) return null;

    const allProviders = getProviders();
    const isAutoMode = config.enabledProviders === "auto";
    const providers = isAutoMode
      ? allProviders
      : allProviders.filter((p) => config.enabledProviders.includes(p.id));
    if (!isAutoMode && providers.length === 0) return null;

    let currentModel: string | undefined;
    if (config.onlyCurrentModel && sessionID) {
      currentModel = await getCurrentModel(sessionID);
    }

    const ctx: QuotaProviderContext = {
      client: typedClient,
      config: {
        googleModels: config.googleModels,
        alibabaCodingPlanTier: config.alibabaCodingPlanTier,
        // Always format /quota in grouped mode for a more dashboard-like look.
        toastStyle: "grouped" as const,
        onlyCurrentModel: config.onlyCurrentModel,
        currentModel,
      },
    };

    const avail = await Promise.all(providers.map(async (p) => ({ p, ok: await p.isAvailable(ctx) })));
    const active = avail.filter((x) => x.ok).map((x) => x.p);
    if (active.length === 0) return null;

    const results = await Promise.all(
      active.map((p) =>
        fetchProviderWithCache({
          provider: p,
          ctx,
          ttlMs: config.minIntervalMs,
        }),
      ),
    );
    const entries = results.flatMap((r) => r.entries) as any[];
    const errors = results.flatMap((r) => r.errors);

    // Fetch session tokens if enabled and sessionID is available
    let sessionTokens: SessionTokensData | undefined;
    if (config.showSessionTokens && sessionID) {
      const stResult = await fetchSessionTokensForDisplay({
        enabled: config.showSessionTokens,
        sessionID,
      });
      sessionTokens = stResult.sessionTokens;
      // Update diagnostics state: clear on success (no error returned), set on failure
      lastSessionTokenError = stResult.error;
    }

    if (entries.length === 0) {
      if (errors.length === 0 && !sessionTokens) return null;
      return formatQuotaCommandBody({ entries, errors, sessionTokens });
    }

    return formatQuotaCommandBody({ entries, errors, sessionTokens });
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
    generatedAtMs: number;
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
      generatedAtMs: params.generatedAtMs,
    });
  }

  async function buildStatusReport(params: {
    refreshGoogleTokens?: boolean;
    skewMs?: number;
    force?: boolean;
    sessionID?: string;
    generatedAtMs: number;
  }): Promise<string | null> {
    await refreshConfig();
    if (!config.enabled) return null;
    await kickPricingRefresh({ reason: "status", maxWaitMs: 750 });

    const currentModel = await getCurrentModel(params.sessionID);
    const sessionModelLookup: "ok" | "not_found" | "no_session" = !params.sessionID
      ? "no_session"
      : currentModel
        ? "ok"
        : "not_found";

    const isAutoMode = config.enabledProviders === "auto";

    const providers = getProviders();
    const availability = await Promise.all(
      providers.map(async (p) => {
        let ok = false;
        try {
          ok = await p.isAvailable({
            client: typedClient,
            config: {
              googleModels: config.googleModels,
              alibabaCodingPlanTier: config.alibabaCodingPlanTier,
            },
          });
        } catch {
          ok = false;
        }
        return {
          id: p.id,
          // In auto mode, a provider is effectively "enabled" if it's available.
          enabled: isAutoMode ? ok : config.enabledProviders.includes(p.id),
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
      alibabaCodingPlanTier: config.alibabaCodingPlanTier,
      onlyCurrentModel: config.onlyCurrentModel,
      currentModel,
      sessionModelLookup,
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
      generatedAtMs: params.generatedAtMs,
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

      // Register token report commands (/tokens_*)
      for (const spec of TOKEN_REPORT_COMMANDS) {
        cfg.command[spec.id] = {
          template: spec.template,
          description: spec.description,
        };
      }
    },

    "command.execute.before": async (input: CommandExecuteInput) => {
      try {
        const cmd = input.command;
        const sessionID = input.sessionID;
        const isQuotaCommand =
          cmd === "quota" || cmd === "quota_status" || isTokenReportCommand(cmd);

        if (isQuotaCommand && !configLoaded) {
          await refreshConfig();
        }
        if (isQuotaCommand && !config.enabled) {
          handled();
        }

        if (cmd === "quota") {
          const generatedAtMs = Date.now();
          // Separate cache for /quota so it doesn't pollute the toast cache.
          const quotaCache = getQuotaCommandCache();

          const now = generatedAtMs;
          const bypassCommandCache = await shouldBypassQuotaCommandCache(sessionID);
          const cached =
            !bypassCommandCache &&
            quotaCache.timestamp &&
            now - quotaCache.timestamp < config.minIntervalMs
              ? quotaCache.body
              : null;

          const body = cached
            ? cached
            : await (quotaCache.inFlight ??
                (quotaCache.inFlight = (async () => {
                  try {
                    return await fetchQuotaCommandBody("command:/quota", sessionID);
                  } finally {
                    quotaCache!.inFlight = undefined;
                  }
                })()));

          if (body) {
            quotaCache.body = body;
            quotaCache.timestamp = Date.now();
          }

          if (!body) {
            // Provide an actionable message instead of a generic "unavailable".
            if (!configLoaded) {
              await injectRawOutput(sessionID, "Quota unavailable (config not loaded, try again)");
            } else if (!config.enabled) {
              await injectRawOutput(sessionID, "Quota disabled in config (enabled: false)");
            } else {
              // Check what providers are available for a more specific hint.
              const allProvs = getProviders();
              const ctx = {
                client: typedClient,
                  config: {
                    googleModels: config.googleModels,
                    alibabaCodingPlanTier: config.alibabaCodingPlanTier,
                  },
              };
              const avail = await Promise.all(
                allProvs.map(async (p) => {
                  try {
                    return { id: p.id, ok: await p.isAvailable(ctx) };
                  } catch {
                    return { id: p.id, ok: false };
                  }
                }),
              );
              const availableIds = avail.filter((x) => x.ok).map((x) => x.id);

              if (availableIds.length === 0) {
                await injectRawOutput(
                  sessionID,
                  "Quota unavailable\n\nNo quota providers detected. Make sure you are logged in to a supported provider (Copilot, OpenAI, etc.).\n\nRun /quota_status for diagnostics.",
                );
              } else {
                await injectRawOutput(
                  sessionID,
                  `Quota unavailable\n\nProviders detected (${availableIds.join(", ")}) but returned no data. This may be a temporary API error.\n\nRun /quota_status for diagnostics.`,
                );
              }
            }
            handled();
          }

          const heading = renderCommandHeading({
            title: "Quota (/quota)",
            generatedAtMs,
          });
          await injectRawOutput(sessionID, `${heading}\n\n${body}`);
          handled();
        }

        const untilMs = Date.now();

        // Handle token report commands (/tokens_*)
        if (isTokenReportCommand(cmd)) {
          const generatedAtMs = Date.now();
          await kickPricingRefresh({ reason: "tokens", maxWaitMs: 750 });
          const spec = TOKEN_REPORT_COMMANDS_BY_ID.get(cmd)!;

          if (spec.kind === "between") {
            // Special handling for date range command
            const parsed = parseQuotaBetweenArgs(input.arguments);
            if (!parsed.ok) {
              await injectRawOutput(
                sessionID,
                `Invalid arguments for /${spec.id}\n\n${parsed.error}\n\nExpected: /${spec.id} YYYY-MM-DD YYYY-MM-DD\nExample: /${spec.id} 2026-01-01 2026-01-15`,
              );
              handled();
            }
            const sinceMs = startOfLocalDayMs(parsed.startYmd);
            const rangeUntilMs = startOfNextLocalDayMs(parsed.endYmd); // Exclusive upper bound for inclusive end date
            const out = await buildQuotaReport({
              title: spec.titleForRange(parsed.startYmd, parsed.endYmd),
              sinceMs,
              untilMs: rangeUntilMs,
              sessionID,
              generatedAtMs,
            });
            await injectRawOutput(sessionID, out);
            handled();
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
            generatedAtMs,
          });
          await injectRawOutput(sessionID, out);
          handled();
        }

        // Handle /quota_status (diagnostics - not a token report)
        if (cmd === "quota_status") {
          const generatedAtMs = Date.now();
          const parsed = parseOptionalJsonArgs(input.arguments);
          if (!parsed.ok) {
            await injectRawOutput(
              sessionID,
              `Invalid arguments for /quota_status\n\n${parsed.error}\n\nExample:\n/quota_status {"refreshGoogleTokens": true}`,
            );
            handled();
          }

          const out = await buildStatusReport({
            refreshGoogleTokens: parsed.value["refreshGoogleTokens"] === true,
            skewMs:
              typeof parsed.value["skewMs"] === "number"
                ? (parsed.value["skewMs"] as number)
                : undefined,
            force: parsed.value["force"] === true,
            sessionID,
            generatedAtMs,
          });
          if (out) {
            await injectRawOutput(sessionID, out);
          }
          handled();
        }
      } catch (err) {
        // IMPORTANT: do not swallow command-handled sentinel errors.
        // In OpenCode 1.2.15, if this hook resolves, SessionPrompt.command()
        // proceeds to prompt(...) and can invoke the tool/LLM path.
        throw err;
      }
    },

    tool: {
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
            sessionID: context.sessionID,
            generatedAtMs: Date.now(),
          });
          if (!out) return "";
          context.metadata({ title: "Quota Status" });
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
    "tool.execute.after": async (input: ToolExecuteAfterInput, output: ToolExecuteAfterOutput) => {
      if (input.tool !== "question") return;

      if (!configLoaded) {
        await refreshConfig();
      }

      if (!config.enabled) return;

      if (isSuccessfulQuestionExecution(output)) {
            const model = await getCurrentModel(input.sessionID);
            try {
              if (isQwenCodeModelId(model)) {
                const plan = await resolveQwenLocalPlanCached();
                if (plan.state === "qwen_free") {
                  await recordQwenCompletion();
                  clearQuotaCommandCache();
                }
              } else if (isAlibabaModelId(model)) {
                const plan = await resolveAlibabaCodingPlanAuthCached({
              maxAgeMs: DEFAULT_ALIBABA_AUTH_CACHE_MAX_AGE_MS,
              fallbackTier: config.alibabaCodingPlanTier,
                });
                if (plan.state === "configured") {
                  await recordAlibabaCodingPlanCompletion();
                  clearQuotaCommandCache();
                }
              }
        } catch (err) {
          await log("Failed to record local request-plan quota completion", {
            error: err instanceof Error ? err.message : String(err),
            model,
          });
        }
      }

      if (config.showOnQuestion) {
        await showQuotaToast(input.sessionID, "question");
      }
    },
  };
};
