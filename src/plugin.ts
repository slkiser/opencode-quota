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
import { tool } from "@opencode-ai/plugin";
import {
  aggregateUsage,
  resolveSessionTree,
  SessionNotFoundError,
  type SessionTreeNode,
} from "./lib/quota-stats.js";
import { formatQuotaStatsReport } from "./lib/quota-stats-format.js";
import { buildQuotaStatusReport, type SessionTokenError } from "./lib/quota-status.js";
import { inspectTuiConfig } from "./lib/tui-config-diagnostics.js";
import {
  getPricingSnapshotMeta,
  getPricingSnapshotSource,
  getRuntimePricingRefreshStatePath,
  getRuntimePricingSnapshotPath,
  maybeRefreshPricingSnapshot,
  setPricingSnapshotAutoRefresh,
  setPricingSnapshotSelection,
  type PricingRefreshResult,
} from "./lib/modelsdev-pricing.js";
import { refreshGoogleTokensForAllAccounts } from "./lib/google.js";
import {
  DEFAULT_ALIBABA_AUTH_CACHE_MAX_AGE_MS,
  isAlibabaModelId,
  resolveAlibabaCodingPlanAuthCached,
} from "./lib/alibaba-auth.js";
import { isQwenCodeModelId, resolveQwenLocalPlanCached } from "./lib/qwen-auth.js";
import { recordAlibabaCodingPlanCompletion, recordQwenCompletion } from "./lib/qwen-local-quota.js";
import { isCursorModelId, isCursorProviderId } from "./lib/cursor-pricing.js";
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
import { sanitizeDisplayText } from "./lib/display-sanitize.js";
import {
  collectQuotaRenderData,
  matchesQuotaProviderCurrentSelection,
  resolveQuotaRenderSelection,
  type ProviderFetchCacheStore,
  type QuotaRenderData as QuotaCommandRenderData,
  type QuotaRequestContext as QuotaCommandRequestContext,
  type SessionModelMeta,
} from "./lib/quota-render-data.js";

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
        providerID?: string;
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
  agent?: Record<string, unknown>;
  default_agent?: string;
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
  | "tokens_session_all"
  | "tokens_between";

/** Specification for a token report command */
type TokenReportCommandSpec =
  | {
      id: Exclude<TokenReportCommandId, "tokens_between">;
      template: `/${string}`;
      description: string;
      title: string;
      metadataTitle: string;
      kind: "rolling" | "today" | "all" | "session" | "session_tree";
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
    description: "Token + deterministic cost summary for today (calendar day, local timezone).",
    title: "Tokens used (Today) (/tokens_today)",
    metadataTitle: "Tokens used (Today)",
    kind: "today",
  },
  {
    id: "tokens_daily",
    template: "/tokens_daily",
    description: "Token + deterministic cost summary for the last 24 hours (rolling).",
    title: "Tokens used (Last 24 Hours) (/tokens_daily)",
    metadataTitle: "Tokens used (Last 24 Hours)",
    kind: "rolling",
    windowMs: 24 * 60 * 60 * 1000,
  },
  {
    id: "tokens_weekly",
    template: "/tokens_weekly",
    description: "Token + deterministic cost summary for the last 7 days (rolling).",
    title: "Tokens used (Last 7 Days) (/tokens_weekly)",
    metadataTitle: "Tokens used (Last 7 Days)",
    kind: "rolling",
    windowMs: 7 * 24 * 60 * 60 * 1000,
  },
  {
    id: "tokens_monthly",
    template: "/tokens_monthly",
    description: "Token + deterministic cost summary for the last 30 days (rolling).",
    title: "Tokens used (Last 30 Days) (/tokens_monthly)",
    metadataTitle: "Tokens used (Last 30 Days)",
    kind: "rolling",
    windowMs: 30 * 24 * 60 * 60 * 1000,
  },
  {
    id: "tokens_all",
    template: "/tokens_all",
    description: "Token + deterministic cost summary for all locally saved OpenCode history.",
    title: "Tokens used (All Time) (/tokens_all)",
    metadataTitle: "Tokens used (All Time)",
    kind: "all",
    topModels: 12,
    topSessions: 12,
  },
  {
    id: "tokens_session",
    template: "/tokens_session",
    description: "Token + deterministic cost summary for current session only.",
    title: "Tokens used (Current Session) (/tokens_session)",
    metadataTitle: "Tokens used (Current Session)",
    kind: "session",
  },
  {
    id: "tokens_session_all",
    template: "/tokens_session_all",
    description:
      "Token + deterministic cost summary for current session and all descendant child/subagent sessions.",
    title: "Tokens used (Current Session Tree) (/tokens_session_all)",
    metadataTitle: "Tokens used (Current Session Tree)",
    kind: "session_tree",
  },
  {
    id: "tokens_between",
    template: "/tokens_between",
    description:
      "Token + deterministic cost report between two YYYY-MM-DD dates (local timezone, inclusive).",
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

const LIVE_LOCAL_USAGE_PROVIDER_IDS = new Set(["qwen-code", "alibaba-coding-plan", "cursor"]);

type QuotaCommandCacheEntry = {
  data?: QuotaCommandRenderData;
  timestamp: number;
  inFlight?: Promise<QuotaCommandRenderData | null>;
};

type QuotaCommandCacheStore = Map<string, QuotaCommandCacheEntry>;

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
          parts: [{ type: "text", text: sanitizeDisplayText(output), ignored: true }],
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

  const providerFetchCache: ProviderFetchCacheStore = new Map();

  function getQuotaCommandCache(): QuotaCommandCacheStore {
    const existing = (globalThis as any).__opencodeQuotaCommandCache as unknown;
    if (existing instanceof Map) {
      return existing as QuotaCommandCacheStore;
    }

    const quotaCache: QuotaCommandCacheStore = new Map();
    (globalThis as any).__opencodeQuotaCommandCache = quotaCache;
    return quotaCache;
  }

  function clearQuotaCommandCache(): void {
    getQuotaCommandCache().clear();
  }

  function buildQuotaCommandCacheKey(params: QuotaCommandRequestContext): string {
    const enabledProviders =
      config.enabledProviders === "auto" ? "auto" : config.enabledProviders.join(",");
    const googleModels = config.googleModels.join(",");
    const currentModel =
      config.onlyCurrentModel && params.sessionID ? (params.sessionMeta?.modelID ?? "") : "";
    const currentProviderID =
      config.onlyCurrentModel && params.sessionID ? (params.sessionMeta?.providerID ?? "") : "";

    return [
      `sessionID=${params.sessionID ?? ""}`,
      `showSessionTokens=${config.showSessionTokens ? "yes" : "no"}`,
      `onlyCurrentModel=${config.onlyCurrentModel ? "yes" : "no"}`,
      `enabledProviders=${enabledProviders}`,
      `anthropicBinaryPath=${config.anthropicBinaryPath}`,
      `googleModels=${googleModels}`,
      `alibabaTier=${config.alibabaCodingPlanTier}`,
      `cursorPlan=${config.cursorPlan}`,
      `cursorIncludedApiUsd=${config.cursorIncludedApiUsd ?? ""}`,
      `cursorBillingCycleStartDay=${config.cursorBillingCycleStartDay ?? ""}`,
      `currentModel=${currentModel}`,
      `currentProviderID=${currentProviderID}`,
    ].join("|");
  }

  function pruneQuotaCommandCache(ttlMs: number, nowMs: number): void {
    const quotaCache = getQuotaCommandCache();
    for (const [cacheKey, entry] of quotaCache.entries()) {
      if (entry.inFlight) continue;
      if (entry.timestamp <= 0 || ttlMs <= 0 || nowMs - entry.timestamp >= ttlMs) {
        quotaCache.delete(cacheKey);
      }
    }
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

  function isProviderEnabled(providerId: string): boolean {
    return config.enabledProviders === "auto" || config.enabledProviders.includes(providerId);
  }

  async function shouldBypassToastCacheForLiveLocalUsage(params: {
    trigger: string;
    sessionID: string;
    sessionMeta?: SessionModelMeta;
  }): Promise<boolean> {
    const { trigger, sessionID } = params;
    if (trigger !== "question") return false;

    const currentSession = params.sessionMeta ?? (await getSessionModelMeta(sessionID));
    const currentModel = currentSession.modelID;
    if (isQwenCodeModelId(currentModel)) {
      const plan = await resolveQwenLocalPlanCached();
      return plan.state === "qwen_free" && isProviderEnabled("qwen-code");
    }

    if (isAlibabaModelId(currentModel)) {
      const plan = await resolveAlibabaCodingPlanAuthCached({
        maxAgeMs: DEFAULT_ALIBABA_AUTH_CACHE_MAX_AGE_MS,
        fallbackTier: config.alibabaCodingPlanTier,
      });
      return plan.state === "configured" && isProviderEnabled("alibaba-coding-plan");
    }

    if (isCursorProviderId(currentSession.providerID) || isCursorModelId(currentModel)) {
      return isProviderEnabled("cursor");
    }

    return false;
  }

  async function shouldBypassQuotaCommandCache(
    sessionID?: string,
    sessionMeta?: SessionModelMeta,
  ): Promise<boolean> {
    if (config.debug || !sessionID) return config.debug;
    return await shouldBypassToastCacheForLiveLocalUsage({
      trigger: "question",
      sessionID,
      sessionMeta,
    });
  }

  async function refreshConfig(): Promise<void> {
    if (configInFlight) return configInFlight;

    configInFlight = (async () => {
      try {
        configMeta = createLoadConfigMeta();
        config = await loadConfig(typedClient, configMeta);
        setPricingSnapshotAutoRefresh(config.pricingSnapshot.autoRefresh);
        setPricingSnapshotSelection(config.pricingSnapshot.source);
        configLoaded = true;
        onFirstConfigLoaded();
      } catch {
        // Leave configLoaded=false so we can retry on next trigger.
        config = DEFAULT_CONFIG;
        setPricingSnapshotAutoRefresh(DEFAULT_CONFIG.pricingSnapshot.autoRefresh);
        setPricingSnapshotSelection(DEFAULT_CONFIG.pricingSnapshot.source);
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
      const refreshPromise = maybeRefreshPricingSnapshot({
        reason: params.reason,
        snapshotSelection: config.pricingSnapshot.source,
      });
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

  // Deferred init: runs once after the first successful config load.
  // Avoids HTTP calls during plugin construction, which can interfere with
  // other plugins that are still being loaded (see #39).
  let initDone = false;
  function onFirstConfigLoaded(): void {
    if (initDone) return;
    initDone = true;

    if (config.enabled) {
      void kickPricingRefresh({ reason: "init" });
    }

    void typedClient.app
      .log({
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
            cursorPlan: config.cursorPlan,
            cursorIncludedApiUsd: config.cursorIncludedApiUsd,
            cursorBillingCycleStartDay: config.cursorBillingCycleStartDay,
            pricingSnapshotSource: config.pricingSnapshot.source,
            pricingSnapshotAutoRefresh: config.pricingSnapshot.autoRefresh,
            showOnIdle: config.showOnIdle,
            showOnQuestion: config.showOnQuestion,
            showOnCompact: config.showOnCompact,
            showOnBothFail: config.showOnBothFail,
          },
        },
      })
      .catch(() => {});
  }

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
   * Get the current model metadata from the active session.
   *
   * Only uses session-scoped model lookup. Does NOT fall back to
   * client.config.get() because that returns the global/default model
   * which can be stale across sessions.
   */
  async function getSessionModelMeta(sessionID?: string): Promise<SessionModelMeta> {
    if (!sessionID) return {};
    try {
      const sessionResp = await typedClient.session.get({ path: { id: sessionID } });
      return {
        modelID: sessionResp.data?.modelID,
        providerID: sessionResp.data?.providerID,
      };
    } catch {
      return {};
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

  function describeQuotaCommandCurrentSelection(params: {
    currentModel?: string;
    currentProviderID?: string;
  }): string {
    if (isCursorProviderId(params.currentProviderID)) {
      return `current provider: ${params.currentProviderID}`;
    }
    if (params.currentModel) {
      return `current model: ${params.currentModel}`;
    }
    return "current session";
  }

  async function buildQuotaCommandUnavailableMessage(
    params: QuotaCommandRequestContext = {},
  ): Promise<string> {
    const selection = await resolveQuotaRenderSelection({
      client: typedClient,
      config,
      request: params,
      formatStyle: "grouped",
    });
    if (!selection) {
      return "Quota unavailable\n\nNo enabled quota providers are configured.\n\nRun /quota_status for diagnostics.";
    }

    if (selection.filteringByCurrentSelection && selection.filtered.length === 0) {
      const detail = describeQuotaCommandCurrentSelection({
        currentModel: selection.currentModel,
        currentProviderID: selection.currentProviderID,
      });
      return `Quota unavailable\n\nNo enabled quota providers matched the ${detail}.\n\nRun /quota_status for diagnostics.`;
    }

    const avail = await Promise.all(
      selection.filtered.map(async (p) => {
        try {
          return { id: p.id, ok: await p.isAvailable(selection.ctx) };
        } catch {
          return { id: p.id, ok: false };
        }
      }),
    );
    const availableIds = avail.filter((x) => x.ok).map((x) => x.id);

    if (availableIds.length === 0) {
      const scopedDetail = selection.filteringByCurrentSelection
        ? ` for the ${describeQuotaCommandCurrentSelection({
            currentModel: selection.currentModel,
            currentProviderID: selection.currentProviderID,
          })}`
        : "";
      return (
        `Quota unavailable\n\nNo quota providers detected${scopedDetail}. ` +
        "Make sure you are logged in to a supported provider (Copilot, OpenAI, etc.).\n\n" +
        "Run /quota_status for diagnostics."
      );
    }

    return (
      `Quota unavailable\n\nProviders detected (${availableIds.join(", ")}) but returned no data. ` +
      "This may be a temporary API error.\n\n" +
      "Run /quota_status for diagnostics."
    );
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

    if (config.enabledProviders !== "auto" && config.enabledProviders.length === 0) {
      return config.debug
        ? formatDebugInfo({ trigger, reason: "enabledProviders empty", enabledProviders: [] })
        : null;
    }

    const quotaRequestContext: QuotaCommandRequestContext = {
      sessionID,
      sessionMeta:
        config.onlyCurrentModel && sessionID ? await getSessionModelMeta(sessionID) : undefined,
    };
    const quotaResult = await collectQuotaRenderData({
      client: typedClient,
      config,
      request: quotaRequestContext,
      providerFetchCache,
      surfaceExplicitProviderIssues: true,
      formatStyle: config.formatStyle,
    });
    const { selection, availability, active, attemptedAny, hasExplicitProviderIssues, data } =
      quotaResult;

    if (config.showSessionTokens && sessionID) {
      lastSessionTokenError = quotaResult.sessionTokenError;
    }

    const currentModel = selection?.currentModel;
    const errors = data?.errors ?? [];

    if (active.length === 0 && !(hasExplicitProviderIssues && errors.length > 0)) {
      return config.debug
        ? formatDebugInfo({
            trigger,
            reason: "no enabled providers available",
            currentModel,
            enabledProviders: config.enabledProviders,
            availability: availability.map((item) => ({
              id: item.provider.id,
              ok: item.ok,
            })),
          })
        : null;
    }

    if (data?.entries.length) {
      const formatted = formatQuotaRows({
        version: "1.0.0",
        layout: config.layout,
        entries: data.entries,
        errors: data.errors,
        style: config.formatStyle,
        sessionTokens: data.sessionTokens,
      });

      if (!config.debug) return formatted;

      const debugFooter = `\n\n[debug] src=${configMeta.source} providers=${config.enabledProviders === "auto" ? "(auto)" : config.enabledProviders.join(",") || "(none)"} avail=${availability
        .map((item) => `${item.provider.id}:${item.ok ? "ok" : "no"}`)
        .join(" ")}`;

      return formatted + debugFooter;
    }

    // Show errors even without entries when:
    // 1. showOnBothFail is enabled and at least one provider attempted (existing behavior)
    // 2. OR we're in explicit mode and have "Not configured"/"Unavailable" errors (new behavior)
    if ((config.showOnBothFail && attemptedAny && errors.length > 0) || hasExplicitProviderIssues) {
      const errorLines = errors.map((error) => `${error.label}: ${error.message}`).join("\n");
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
          availability: availability.map((item) => ({
            id: item.provider.id,
            ok: item.ok,
          })),
        })
      );
    }

    return config.debug
      ? formatDebugInfo({
          trigger,
          reason: "no entries",
          currentModel,
          enabledProviders: config.enabledProviders,
          availability: availability.map((item) => ({
            id: item.provider.id,
            ok: item.ok,
          })),
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
      : await shouldBypassToastCacheForLiveLocalUsage({ trigger, sessionID });

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
          message: sanitizeDisplayText(message),
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

  async function fetchQuotaCommandData(
    trigger: string,
    params: QuotaCommandRequestContext = {},
  ): Promise<QuotaCommandRenderData | null> {
    const quotaResult = await collectQuotaRenderData({
      client: typedClient,
      config,
      request: params,
      providerFetchCache,
      surfaceExplicitProviderIssues: false,
      formatStyle: "grouped",
    });

    if (config.showSessionTokens && params.sessionID) {
      lastSessionTokenError = quotaResult.sessionTokenError;
    }

    return quotaResult.data;
  }

  async function buildQuotaReport(params: {
    title: string;
    sinceMs?: number;
    untilMs?: number;
    sessionID: string;
    topModels?: number;
    topSessions?: number;
    filterSessionID?: string;
    filterSessionIDs?: string[];
    /** When true, hides Window/Sessions columns and Top Sessions section */
    sessionOnly?: boolean;
    reportKind?: "standard" | "session" | "session_tree";
    sessionTree?: {
      rootSessionID: string;
      nodes: SessionTreeNode[];
    };
    generatedAtMs: number;
  }): Promise<string> {
    const result = await aggregateUsage({
      sinceMs: params.sinceMs,
      untilMs: params.untilMs,
      sessionID: params.filterSessionID,
      sessionIDs: params.filterSessionIDs,
    });
    return formatQuotaStatsReport({
      title: params.title,
      result,
      topModels: params.topModels,
      topSessions: params.topSessions,
      focusSessionID: params.sessionID,
      sessionOnly: params.sessionOnly,
      reportKind: params.reportKind,
      sessionTree: params.sessionTree,
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

    const currentSession = await getSessionModelMeta(params.sessionID);
    const currentModel = currentSession.modelID;
    const currentProviderID = currentSession.providerID;
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
              anthropicBinaryPath: config.anthropicBinaryPath,
              alibabaCodingPlanTier: config.alibabaCodingPlanTier,
              cursorPlan: config.cursorPlan,
              cursorIncludedApiUsd: config.cursorIncludedApiUsd,
              cursorBillingCycleStartDay: config.cursorBillingCycleStartDay,
              currentModel,
              currentProviderID,
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
            currentModel || isCursorProviderId(currentProviderID)
              ? matchesQuotaProviderCurrentSelection({
                  provider: p,
                  currentModel,
                  currentProviderID,
                })
              : undefined,
        };
      }),
    );

    const refresh = params.refreshGoogleTokens
      ? await refreshGoogleTokensForAllAccounts({ skewMs: params.skewMs, force: params.force })
      : null;

    const tuiDiagnostics = await inspectTuiConfig();

    return await buildQuotaStatusReport({
      tuiDiagnostics,
      configSource: configMeta.source,
      configPaths: configMeta.paths,
      enabledProviders: config.enabledProviders,
      anthropicBinaryPath: config.anthropicBinaryPath,
      alibabaCodingPlanTier: config.alibabaCodingPlanTier,
      cursorPlan: config.cursorPlan,
      cursorIncludedApiUsd: config.cursorIncludedApiUsd,
      cursorBillingCycleStartDay: config.cursorBillingCycleStartDay,
      pricingSnapshotSource: config.pricingSnapshot.source,
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

  function formatIsoTimestamp(timestampMs: number | undefined): string {
    return typeof timestampMs === "number" && Number.isFinite(timestampMs) && timestampMs > 0
      ? new Date(timestampMs).toISOString()
      : "(none)";
  }

  function buildPricingRefreshCommandOutput(params: {
    result: PricingRefreshResult;
    generatedAtMs: number;
  }): string {
    const meta = getPricingSnapshotMeta();
    const activeSource = getPricingSnapshotSource();
    const configuredSelection = config.pricingSnapshot.source;
    const resultLabel =
      params.result.reason ??
      params.result.state.lastResult ??
      (params.result.updated ? "success" : "unknown");

    const lines = [
      renderCommandHeading({
        title: "Pricing Refresh (/pricing_refresh)",
        generatedAtMs: params.generatedAtMs,
      }),
      "",
      "refresh:",
      `- attempted: ${params.result.attempted ? "true" : "false"}`,
      `- result: ${resultLabel}`,
      `- runtime_snapshot_persisted: ${params.result.updated ? "true" : "false"}`,
    ];

    if (params.result.error) {
      lines.push(`- error: ${params.result.error}`);
    }

    lines.push("");
    lines.push("pricing_snapshot:");
    lines.push(`- selection: configured=${configuredSelection} active=${activeSource}`);
    lines.push(
      `- active_snapshot: source=${meta.source} generated_at=${formatIsoTimestamp(meta.generatedAt)} units=${meta.units}`,
    );
    lines.push(
      `- runtime_paths: snapshot=${getRuntimePricingSnapshotPath()} refresh_state=${getRuntimePricingRefreshStatePath()}`,
    );
    if (configuredSelection === "bundled" && params.result.updated) {
      lines.push(
        "- selection_note: runtime snapshot refreshed locally, but active reports remain pinned to bundled pricing",
      );
    }

    return lines.join("\n");
  }

  function buildTokenReportUnavailableOutput(params: {
    command: `/${string}`;
    generatedAtMs: number;
    error: SessionNotFoundError;
  }): string {
    const lines = [
      renderCommandHeading({
        title: `Token report unavailable (${params.command})`,
        generatedAtMs: params.generatedAtMs,
      }),
      "",
      "session_lookup_error:",
      `- session_id: ${params.error.sessionID}`,
      `- error: ${params.error.message}`,
      `- checked_path: ${params.error.checkedPath}`,
    ];

    return lines.join("\n");
  }

  async function injectCommandOutputAndHandle(
    sessionID: string,
    output?: string | null,
  ): Promise<never> {
    if (output !== undefined && output !== null) {
      await injectRawOutput(sessionID, output);
    }
    handled();
  }

  async function handleQuotaSlashCommand(input: CommandExecuteInput): Promise<never> {
    const sessionID = input.sessionID;
    const generatedAtMs = Date.now();
    const now = generatedAtMs;
    const quotaRequestContext: QuotaCommandRequestContext = {
      sessionID,
      sessionMeta: sessionID ? await getSessionModelMeta(sessionID) : undefined,
    };
    const bypassCommandCache = await shouldBypassQuotaCommandCache(
      sessionID,
      quotaRequestContext.sessionMeta,
    );
    const reportData = bypassCommandCache
      ? await fetchQuotaCommandData("command:/quota", quotaRequestContext)
      : await (async () => {
          const quotaCache = getQuotaCommandCache();
          pruneQuotaCommandCache(config.minIntervalMs, now);

          const cacheKey = buildQuotaCommandCacheKey(quotaRequestContext);
          const cachedEntry = quotaCache.get(cacheKey);
          if (cachedEntry?.timestamp && now - cachedEntry.timestamp < config.minIntervalMs) {
            return cachedEntry.data ?? null;
          }

          const cacheEntry: QuotaCommandCacheEntry = cachedEntry ?? { timestamp: 0 };
          if (!cachedEntry) {
            quotaCache.set(cacheKey, cacheEntry);
          }

          return await (cacheEntry.inFlight ??
            (cacheEntry.inFlight = (async () => {
              try {
                const freshData = await fetchQuotaCommandData(
                  "command:/quota",
                  quotaRequestContext,
                );
                if (freshData) {
                  cacheEntry.data = freshData;
                  cacheEntry.timestamp = Date.now();
                }
                return freshData;
              } finally {
                cacheEntry.inFlight = undefined;
                if (!cacheEntry.data && cacheEntry.timestamp <= 0) {
                  quotaCache.delete(cacheKey);
                }
              }
            })()));
        })();

    if (!reportData) {
      if (!configLoaded) {
        return await injectCommandOutputAndHandle(
          sessionID,
          "Quota unavailable (config not loaded, try again)",
        );
      }
      if (!config.enabled) {
        return await injectCommandOutputAndHandle(
          sessionID,
          "Quota disabled in config (enabled: false)",
        );
      }
      return await injectCommandOutputAndHandle(
        sessionID,
        await buildQuotaCommandUnavailableMessage(quotaRequestContext),
      );
    }

    return await injectCommandOutputAndHandle(
      sessionID,
      formatQuotaCommand({
        ...reportData,
        generatedAtMs,
      }),
    );
  }

  async function handlePricingRefreshSlashCommand(input: CommandExecuteInput): Promise<never> {
    const sessionID = input.sessionID;
    const generatedAtMs = Date.now();
    if ((input.arguments ?? "").trim()) {
      return await injectCommandOutputAndHandle(
        sessionID,
        "Invalid arguments for /pricing_refresh\n\nThis command does not accept arguments.\n\nUsage:\n/pricing_refresh",
      );
    }

    const result = await maybeRefreshPricingSnapshot({
      reason: "manual",
      force: true,
      snapshotSelection: config.pricingSnapshot.source,
      allowRefreshWhenSelectionBundled: true,
    });
    return await injectCommandOutputAndHandle(
      sessionID,
      buildPricingRefreshCommandOutput({
        result,
        generatedAtMs,
      }),
    );
  }

  async function handleTokenReportSlashCommand(
    input: CommandExecuteInput,
    command: TokenReportCommandId,
  ): Promise<never> {
    const sessionID = input.sessionID;
    const untilMs = Date.now();
    const generatedAtMs = Date.now();
    await kickPricingRefresh({ reason: "tokens", maxWaitMs: 750 });
    const spec = TOKEN_REPORT_COMMANDS_BY_ID.get(command)!;

    try {
      if (spec.kind === "between") {
        const parsed = parseQuotaBetweenArgs(input.arguments);
        if (!parsed.ok) {
          return await injectCommandOutputAndHandle(
            sessionID,
            `Invalid arguments for /${spec.id}\n\n${parsed.error}\n\nExpected: /${spec.id} YYYY-MM-DD YYYY-MM-DD\nExample: /${spec.id} 2026-01-01 2026-01-15`,
          );
        }

        const sinceMs = startOfLocalDayMs(parsed.startYmd);
        const rangeUntilMs = startOfNextLocalDayMs(parsed.endYmd);
        return await injectCommandOutputAndHandle(
          sessionID,
          await buildQuotaReport({
            title: spec.titleForRange(parsed.startYmd, parsed.endYmd),
            sinceMs,
            untilMs: rangeUntilMs,
            sessionID,
            generatedAtMs,
          }),
        );
      }

      let sinceMs: number | undefined;
      let filterSessionID: string | undefined;
      let filterSessionIDs: string[] | undefined;
      let sessionOnly: boolean | undefined;
      let topModels: number | undefined;
      let topSessions: number | undefined;
      let reportKind: "standard" | "session" | "session_tree" | undefined;
      let sessionTree: { rootSessionID: string; nodes: SessionTreeNode[] } | undefined;

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
          reportKind = "session";
          break;
        case "session_tree": {
          const nodes = await resolveSessionTree(sessionID);
          filterSessionIDs = nodes.map((node) => node.sessionID);
          reportKind = "session_tree";
          sessionTree = { rootSessionID: sessionID, nodes };
          break;
        }
        case "all":
          topModels = spec.topModels;
          topSessions = spec.topSessions;
          break;
      }

      return await injectCommandOutputAndHandle(
        sessionID,
        await buildQuotaReport({
          title: spec.title,
          sinceMs,
          untilMs: spec.kind === "rolling" || spec.kind === "today" ? untilMs : undefined,
          sessionID,
          filterSessionID,
          filterSessionIDs,
          sessionOnly,
          reportKind,
          sessionTree,
          topModels,
          topSessions,
          generatedAtMs,
        }),
      );
    } catch (err) {
      if (err instanceof SessionNotFoundError) {
        return await injectCommandOutputAndHandle(
          sessionID,
          buildTokenReportUnavailableOutput({
            command: spec.template,
            generatedAtMs,
            error: err,
          }),
        );
      }
      throw err;
    }
  }

  async function handleQuotaStatusSlashCommand(input: CommandExecuteInput): Promise<never> {
    const sessionID = input.sessionID;
    const generatedAtMs = Date.now();
    const parsed = parseOptionalJsonArgs(input.arguments);
    if (!parsed.ok) {
      return await injectCommandOutputAndHandle(
        sessionID,
        `Invalid arguments for /quota_status\n\n${parsed.error}\n\nExample:\n/quota_status {"refreshGoogleTokens": true}`,
      );
    }

    const out = await buildStatusReport({
      refreshGoogleTokens: parsed.value["refreshGoogleTokens"] === true,
      skewMs:
        typeof parsed.value["skewMs"] === "number" ? (parsed.value["skewMs"] as number) : undefined,
      force: parsed.value["force"] === true,
      sessionID,
      generatedAtMs,
    });
    return await injectCommandOutputAndHandle(sessionID, out);
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
            "Diagnostics for toast + TUI + pricing + local storage (includes unknown pricing report).",
      };
      cfg.command["pricing_refresh"] = {
        template: "/pricing_refresh",
        description: "Refresh the local runtime pricing snapshot from models.dev.",
      };

      // Register token report commands (/tokens_*)
      for (const spec of TOKEN_REPORT_COMMANDS) {
        cfg.command[spec.id] = {
          template: spec.template,
          description: spec.description,
        };
      }

      // Fix zero-width space mismatch between default_agent and agent keys.
      // Some plugins remap agent keys with invisible Unicode prefixes for sort
      // ordering but set default_agent without them, causing OpenCode to crash
      // with "default agent not found". See #39.
      if (cfg.default_agent && cfg.agent && !(cfg.default_agent in cfg.agent)) {
        const stripped = (s: string) => s.replace(/[\u200B\u200C\u200D\uFEFF]/g, "");
        const target = stripped(cfg.default_agent);
        const matches = Object.keys(cfg.agent).filter((k) => stripped(k) === target);
        if (matches.length === 1) {
          cfg.default_agent = matches[0];
        }
      }
    },

    "command.execute.before": async (input: CommandExecuteInput) => {
      try {
        const cmd = input.command;
        const isHandledSlashCommand =
          cmd === "quota" ||
          cmd === "quota_status" ||
          cmd === "pricing_refresh" ||
          isTokenReportCommand(cmd);

        if (isHandledSlashCommand && !configLoaded) {
          await refreshConfig();
        }
        if (isHandledSlashCommand && !config.enabled) {
          handled();
        }

        if (cmd === "quota") {
          return await handleQuotaSlashCommand(input);
        }

        if (cmd === "pricing_refresh") {
          return await handlePricingRefreshSlashCommand(input);
        }

        // Handle token report commands (/tokens_*)
        if (isTokenReportCommand(cmd)) {
          return await handleTokenReportSlashCommand(input, cmd);
        }

        // Handle /quota_status (diagnostics - not a token report)
        if (cmd === "quota_status") {
          return await handleQuotaStatusSlashCommand(input);
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
            "Diagnostics for toast + TUI + pricing + local storage (includes unknown pricing report).",
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

      if (event.type !== "session.idle" && event.type !== "session.compacted") {
        return;
      }

      if (!configLoaded) {
        await refreshConfig();
      }

      if (!config.enabled) return;

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
        const sessionMeta = await getSessionModelMeta(input.sessionID);
        const model = sessionMeta.modelID;
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
          } else if (isCursorProviderId(sessionMeta.providerID) || isCursorModelId(model)) {
            clearQuotaCommandCache();
          }
        } catch (err) {
          await log("Failed to record local request-plan quota completion", {
            error: err instanceof Error ? err.message : String(err),
            model,
            providerID: sessionMeta.providerID,
          });
        }
      }

      if (config.showOnQuestion) {
        await showQuotaToast(input.sessionID, "question");
      }
    },
  };
};
