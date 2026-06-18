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
import { createLoadConfigMeta, type LoadConfigMeta } from "./lib/config.js";
import { clearCache, getOrFetchWithCacheControl } from "./lib/cache.js";
import { formatQuotaRows } from "./lib/format.js";
import { getProviders } from "./providers/registry.js";
import { tool } from "@opencode-ai/plugin";
import { buildQuotaStatusReport, type SessionTokenError } from "./lib/quota-status.js";
import { inspectTuiConfig } from "./lib/tui-config-diagnostics.js";
import {
  maybeRefreshPricingSnapshot,
  setPricingSnapshotAutoRefresh,
  setPricingSnapshotSelection,
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
import { sanitizeDisplayText } from "./lib/display-sanitize.js";
import {
  SINGLE_WINDOW_PER_PROVIDER_FORMAT_STYLE,
  resolveQuotaFormatStyle,
} from "./lib/quota-format-style.js";
import {
  collectQuotaRenderData,
  collectQuotaStatusLiveProbes,
  matchesQuotaProviderCurrentSelection,
  type QuotaStatusLiveProbe,
  type SessionModelMeta,
} from "./lib/quota-render-data.js";
import {
  createQuotaProviderRuntimeContext,
  createQuotaRuntimeRequestContext,
  resolveQuotaRuntimeContext,
  type QuotaRuntimeContext,
} from "./lib/quota-runtime-context.js";
import { findGitWorktreeRoot, getEffectiveConfigRoot } from "./lib/config-file-utils.js";
import {
  BUNDLED_MAINTAINER_ANNOUNCEMENTS,
  formatMaintainerAnnouncementHomeCountLine,
  getMaintainerAnnouncementsSummary,
} from "./lib/maintainer-announcements.js";

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
        title?: string;
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

/** Config hook shape used to register built-in commands */
interface PluginConfigInput {
  command?: Record<string, { template: string; description: string }>;
  agent?: Record<string, unknown>;
  default_agent?: string;
}

// =============================================================================
// Deferred Quota Refresh Specification
// =============================================================================

type DeferredQuotaRefreshReason =
  | "config_load_failed"
  | "no_available_providers"
  | "provider_fetch_failed"
  | "no_reportable_data";

type DeferredQuotaRefreshState = {
  sessionID: string;
  attempts: number;
  reason: DeferredQuotaRefreshReason;
  queuedAtMs: number;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
};

type QuotaMessageFetchResult = {
  message: string | null;
  cacheRenderedMessage: boolean;
  retryable: boolean;
  retryReason?: DeferredQuotaRefreshReason;
  hasQuotaRows: boolean;
  detectedProviderIds: string[];
};

const DEFERRED_QUOTA_REFRESH_DELAYS_MS = [3_000, 15_000, 60_000, 300_000] as const;

// =============================================================================
// Plugin Implementation
// =============================================================================

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
  let runtimeProviders = getProviders();

  // Track last session token error for /quota_status diagnostics
  let lastSessionTokenError: SessionTokenError | undefined;

  const deferredQuotaRefreshes = new Map<string, DeferredQuotaRefreshState>();
  const detectedProviderIdsByToastCacheKey = new Map<string, string[]>();
  const maintainerAnnouncementToastFallback = {
    pending: true,
    inFlight: false,
  };

  function getDeferredQuotaRefreshDelayMs(attempts: number): number {
    const index = Math.min(Math.max(0, attempts), DEFERRED_QUOTA_REFRESH_DELAYS_MS.length - 1);
    return DEFERRED_QUOTA_REFRESH_DELAYS_MS[index]!;
  }

  function clearDeferredQuotaRefresh(sessionID: string): void {
    const state = deferredQuotaRefreshes.get(sessionID);
    if (state?.timer) {
      clearTimeout(state.timer);
    }
    deferredQuotaRefreshes.delete(sessionID);
  }

  function clearDeferredQuotaRefreshTimer(state: DeferredQuotaRefreshState): void {
    if (!state.timer) return;
    clearTimeout(state.timer);
    state.timer = null;
  }

  function scheduleDeferredQuotaRefresh(params: {
    sessionID: string;
    reason: DeferredQuotaRefreshReason;
    incrementAttempts: boolean;
  }): void {
    let state = deferredQuotaRefreshes.get(params.sessionID);
    if (!state) {
      state = {
        sessionID: params.sessionID,
        attempts: 0,
        reason: params.reason,
        queuedAtMs: Date.now(),
        timer: null,
        inFlight: false,
      };
      deferredQuotaRefreshes.set(params.sessionID, state);
    } else {
      if (params.incrementAttempts) {
        state.attempts += 1;
      }
      state.reason = params.reason;
      clearDeferredQuotaRefreshTimer(state);
    }

    const delayMs = getDeferredQuotaRefreshDelayMs(state.attempts);
    state.timer = setTimeout(() => {
      void runDeferredQuotaRefresh(params.sessionID);
    }, delayMs);
    state.timer.unref?.();

    void log("Deferred quota refresh scheduled", {
      sessionID: params.sessionID,
      reason: params.reason,
      attempts: state.attempts,
      delayMs,
    });
  }

  async function runDeferredQuotaRefresh(sessionID: string): Promise<void> {
    const state = deferredQuotaRefreshes.get(sessionID);
    if (!state || state.inFlight) return;

    await showQuotaToast(sessionID, "deferred.retry", { deferredRetry: true });
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

  function getPluginRuntimeRootHints() {
    const cwd = process.cwd();
    const workspaceRoot = findGitWorktreeRoot(cwd) ?? cwd;
    const configRoot = getEffectiveConfigRoot(workspaceRoot);
    return {
      workspaceRoot,
      configRoot,
      fallbackDirectory: cwd,
    };
  }

  function triggerMaintainerAnnouncementToastFallback(
    trigger: string,
    detectedProviderIds: string[],
  ): void {
    if (!maintainerAnnouncementToastFallback.pending || maintainerAnnouncementToastFallback.inFlight) {
      return;
    }

    if (!config.enabled || !config.enableToast) {
      maintainerAnnouncementToastFallback.pending = false;
      return;
    }

    if (!config.maintainerAnnouncements.enabled || !config.maintainerAnnouncements.home) {
      maintainerAnnouncementToastFallback.pending = false;
      return;
    }

    maintainerAnnouncementToastFallback.inFlight = true;
    void (async () => {
      try {
        const summary = getMaintainerAnnouncementsSummary({
          announcements: BUNDLED_MAINTAINER_ANNOUNCEMENTS,
          enabledProviders: detectedProviderIds,
        });

        if (summary.activeCount <= 0) {
          if (summary.futureCount <= 0) {
            maintainerAnnouncementToastFallback.pending = false;
          }
          return;
        }

        const tuiDiagnostics = await inspectTuiConfig({ roots: getPluginRuntimeRootHints() });
        if (tuiDiagnostics.quotaPluginConfigured) {
          maintainerAnnouncementToastFallback.pending = false;
          return;
        }

        const message = formatMaintainerAnnouncementHomeCountLine(summary.activeCount);
        if (!message) {
          return;
        }

        await typedClient.tui.showToast({
          body: {
            message: sanitizeDisplayText(message),
            variant: "info",
            duration: config.toastDurationMs,
          },
        });
        maintainerAnnouncementToastFallback.pending = false;
        await log("Displayed maintainer announcement fallback toast", { trigger });
      } catch (err) {
        await log("Failed to show maintainer announcement fallback toast", {
          trigger,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        maintainerAnnouncementToastFallback.inFlight = false;
      }
    })();
  }

  async function resolvePluginRuntimeContext(
    params: {
      sessionID?: string;
      sessionMeta?: SessionModelMeta;
      includeSessionMeta?: boolean | ((config: QuotaToastConfig) => boolean);
    } = {},
  ): Promise<QuotaRuntimeContext> {
    if (!configLoaded) {
      await refreshConfig();
    }

    return resolveQuotaRuntimeContext({
      client: typedClient,
      roots: getPluginRuntimeRootHints(),
      config,
      configMeta,
      providers: runtimeProviders,
      sessionID: params.sessionID,
      sessionMeta: params.sessionMeta,
      resolveSessionMeta: (sessionID) => getSessionModelMeta(sessionID),
      includeSessionMeta: params.includeSessionMeta,
    });
  }

  async function refreshConfig(): Promise<void> {
    if (configInFlight) return configInFlight;

    configInFlight = (async () => {
      try {
        const runtime = await resolveQuotaRuntimeContext({
          client: typedClient,
          roots: getPluginRuntimeRootHints(),
        });
        configMeta = runtime.configMeta;
        config = runtime.config;
        runtimeProviders = runtime.providers;
        setPricingSnapshotAutoRefresh(config.pricingSnapshot.autoRefresh);
        setPricingSnapshotSelection(config.pricingSnapshot.source);
        configLoaded = true;
        onFirstConfigLoaded();
      } catch {
        // Leave configLoaded=false so we can retry on next trigger.
        config = DEFAULT_CONFIG;
        configMeta = createLoadConfigMeta();
        runtimeProviders = getProviders();
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

  function buildToastCacheKey(params: {
    sessionID: string;
    sessionMeta?: SessionModelMeta;
  }): string {
    const formatStyle = resolveQuotaFormatStyle(config.formatStyle);
    const enabledProviders =
      config.enabledProviders === "auto" ? "auto" : config.enabledProviders.join(",");
    const googleModels = config.googleModels.join(",");
    const currentModel =
      config.onlyCurrentModel && params.sessionID ? (params.sessionMeta?.modelID ?? "") : "";
    const currentProviderID =
      config.onlyCurrentModel && params.sessionID ? (params.sessionMeta?.providerID ?? "") : "";

    return [
      `sessionID=${params.sessionID}`,
      `enabledProviders=${enabledProviders}`,
      `formatStyle=${formatStyle}`,
      `percentDisplayMode=${config.percentDisplayMode}`,
      `layout=${JSON.stringify(config.layout)}`,
      `showSessionTokens=${config.showSessionTokens ? "yes" : "no"}`,
      `onlyCurrentModel=${config.onlyCurrentModel ? "yes" : "no"}`,
      `currentModel=${currentModel}`,
      `currentProviderID=${currentProviderID}`,
      `anthropicBinaryPath=${config.anthropicBinaryPath}`,
      `googleModels=${googleModels}`,
      `alibabaTier=${config.alibabaCodingPlanTier}`,
      `cursorPlan=${config.cursorPlan}`,
      `cursorIncludedApiUsd=${config.cursorIncludedApiUsd ?? ""}`,
      `cursorBillingCycleStartDay=${config.cursorBillingCycleStartDay ?? ""}`,
    ].join("|");
  }

  function clearToastCacheForSession(params: {
    sessionID: string;
    sessionMeta?: SessionModelMeta;
  }): void {
    clearCache(buildToastCacheKey(params));
  }

  function isProviderFetchFailureOnly(errors: Array<{ message: string }>): boolean {
    return (
      errors.length > 0 && errors.every((error) => error.message === "Failed to read quota data")
    );
  }

  async function fetchQuotaMessageResult(params: {
    trigger: string;
    sessionID?: string;
    sessionMeta?: SessionModelMeta;
    bypassProviderCache?: boolean;
  }): Promise<QuotaMessageFetchResult> {
    // Ensure we have loaded config at least once. If load fails, we keep trying
    // on subsequent triggers and queue a deferred retry for toast paths.
    if (!configLoaded) {
      await refreshConfig();
    }

    if (!configLoaded) {
      return {
        message: config.debug
          ? formatDebugInfo({
              trigger: params.trigger,
              reason: "config load failed",
              enabledProviders: config.enabledProviders,
            })
          : null,
        cacheRenderedMessage: false,
        retryable: true,
        retryReason: "config_load_failed",
        hasQuotaRows: false,
        detectedProviderIds: [],
      };
    }

    if (!config.enabled) {
      return {
        message: config.debug
          ? formatDebugInfo({ trigger: params.trigger, reason: "disabled", enabledProviders: [] })
          : null,
        cacheRenderedMessage: false,
        retryable: false,
        hasQuotaRows: false,
        detectedProviderIds: [],
      };
    }

    if (config.enabledProviders !== "auto" && config.enabledProviders.length === 0) {
      return {
        message: config.debug
          ? formatDebugInfo({
              trigger: params.trigger,
              reason: "enabledProviders empty",
              enabledProviders: [],
            })
          : null,
        cacheRenderedMessage: false,
        retryable: false,
        hasQuotaRows: false,
        detectedProviderIds: [],
      };
    }

    const runtime = await resolvePluginRuntimeContext({
      sessionID: params.sessionID,
      sessionMeta: params.sessionMeta,
      includeSessionMeta: (config) => config.onlyCurrentModel,
    });
    const runtimeConfig = runtime.config;
    const quotaRequestContext = createQuotaRuntimeRequestContext(runtime);
    const quotaResult = await collectQuotaRenderData({
      client: runtime.client,
      config: runtimeConfig,
      configMeta: runtime.configMeta,
      request: quotaRequestContext,
      surfaceExplicitProviderIssues: true,
      formatStyle: resolveQuotaFormatStyle(runtimeConfig.formatStyle),
      bypassProviderCache: params.bypassProviderCache,
      providers: runtime.providers,
    });
    const { selection, availability, active, attemptedAny, hasExplicitProviderIssues, data } =
      quotaResult;
    const detectedProviderIds = active.map((provider) => provider.id);

    if (runtimeConfig.showSessionTokens && params.sessionID) {
      lastSessionTokenError = quotaResult.sessionTokenError;
    }

    const currentModel = selection?.currentModel;
    const errors = data?.errors ?? [];
    const hasProviderQuotaRows = Boolean(data?.entries.length);
    const hasQuotaRows = Boolean(hasProviderQuotaRows || data?.sessionTokens);
    const providerFetchFailureOnly = attemptedAny && isProviderFetchFailureOnly(errors);
    const retryableAvailabilityFailure =
      active.length === 0 && availability.some((item) => !item.ok && item.error === true);

    if (active.length === 0 && !(hasExplicitProviderIssues && errors.length > 0)) {
      const message = runtimeConfig.debug
        ? formatDebugInfo({
            trigger: params.trigger,
            reason: "no enabled providers available",
            currentModel,
            enabledProviders: runtimeConfig.enabledProviders,
            availability: availability.map((item) => ({
              id: item.provider.id,
              ok: item.ok,
            })),
          })
        : null;
      const retryableNoProviders = selection?.isAutoMode === true || retryableAvailabilityFailure;
      return {
        message,
        cacheRenderedMessage: false,
        retryable: retryableNoProviders,
        retryReason: retryableNoProviders ? "no_available_providers" : undefined,
        hasQuotaRows: false,
        detectedProviderIds,
      };
    }

    if (hasQuotaRows) {
      const formatted = formatQuotaRows({
        version: "1.0.0",
        layout: runtimeConfig.layout,
        entries: data?.entries ?? [],
        errors: data?.errors ?? [],
        style: resolveQuotaFormatStyle(runtimeConfig.formatStyle),
        percentDisplayMode: runtimeConfig.percentDisplayMode,
        sessionTokens: data?.sessionTokens,
      });

      const retryableMaskedProviderFailure = !hasProviderQuotaRows && providerFetchFailureOnly;

      if (!runtimeConfig.debug) {
        return {
          message: formatted,
          cacheRenderedMessage: true,
          retryable: retryableMaskedProviderFailure,
          retryReason: retryableMaskedProviderFailure ? "provider_fetch_failed" : undefined,
          hasQuotaRows: true,
          detectedProviderIds,
        };
      }

      const debugFooter = `\n\n[debug] src=${configMeta.source} providers=${runtimeConfig.enabledProviders === "auto" ? "(auto)" : runtimeConfig.enabledProviders.join(",") || "(none)"} avail=${availability
        .map((item) => `${item.provider.id}:${item.ok ? "ok" : "no"}`)
        .join(" ")}`;

      return {
        message: formatted + debugFooter,
        cacheRenderedMessage: false,
        retryable: retryableMaskedProviderFailure,
        retryReason: retryableMaskedProviderFailure ? "provider_fetch_failed" : undefined,
        hasQuotaRows: true,
        detectedProviderIds,
      };
    }

    // Show errors even without entries when:
    // 1. showOnBothFail is enabled and at least one provider attempted (existing behavior)
    // 2. OR we're in explicit mode and have "Not configured"/"Unavailable" errors (new behavior)
    if (
      (runtimeConfig.showOnBothFail && attemptedAny && errors.length > 0) ||
      hasExplicitProviderIssues
    ) {
      const errorLines = errors.map((error) => `${error.label}: ${error.message}`).join("\n");
      const retryableFetchFailure = !hasExplicitProviderIssues && providerFetchFailureOnly;
      const retryableFailure = retryableFetchFailure || retryableAvailabilityFailure;
      const retryReason: DeferredQuotaRefreshReason | undefined = retryableFetchFailure
        ? "provider_fetch_failed"
        : retryableAvailabilityFailure
          ? "no_available_providers"
          : undefined;
      const message = !runtimeConfig.debug
        ? errorLines || "Quota unavailable"
        : (errorLines || "Quota unavailable") +
          "\n\n" +
          formatDebugInfo({
            trigger: params.trigger,
            reason: hasExplicitProviderIssues
              ? "providers missing/unavailable"
              : "all providers failed",
            currentModel,
            enabledProviders: runtimeConfig.enabledProviders,
            availability: availability.map((item) => ({
              id: item.provider.id,
              ok: item.ok,
            })),
          });
      return {
        message,
        cacheRenderedMessage: false,
        retryable: retryableFailure,
        retryReason,
        hasQuotaRows: false,
        detectedProviderIds,
      };
    }

    const retryableNoData =
      providerFetchFailureOnly ||
      (selection?.isAutoMode === true && active.length > 0 && errors.length === 0);
    return {
      message: runtimeConfig.debug
        ? formatDebugInfo({
            trigger: params.trigger,
            reason: "no entries",
            currentModel,
            enabledProviders: runtimeConfig.enabledProviders,
            availability: availability.map((item) => ({
              id: item.provider.id,
              ok: item.ok,
            })),
          })
        : null,
      cacheRenderedMessage: false,
      retryable: retryableNoData,
      retryReason: providerFetchFailureOnly
        ? "provider_fetch_failed"
        : retryableNoData
          ? "no_reportable_data"
          : undefined,
      hasQuotaRows: false,
      detectedProviderIds,
    };
  }

  async function fetchQuotaMessage(params: {
    trigger: string;
    sessionID?: string;
    sessionMeta?: SessionModelMeta;
    bypassProviderCache?: boolean;
  }): Promise<string | null> {
    const result = await fetchQuotaMessageResult(params);
    return result.message;
  }

  async function reconcileDeferredQuotaRefresh(params: {
    sessionID: string;
    result: QuotaMessageFetchResult;
    consumedDeferredRetry: boolean;
    trigger: string;
  }): Promise<void> {
    const existing = deferredQuotaRefreshes.get(params.sessionID);

    if (!params.result.retryable) {
      if (existing) {
        clearDeferredQuotaRefresh(params.sessionID);
        await log("Deferred quota refresh cleared", {
          sessionID: params.sessionID,
          trigger: params.trigger,
          reason: params.result.hasQuotaRows ? "quota_rows_available" : "not_retryable",
        });
      }
      return;
    }

    if (!params.result.retryReason) {
      return;
    }

    scheduleDeferredQuotaRefresh({
      sessionID: params.sessionID,
      reason: params.result.retryReason,
      incrementAttempts: params.consumedDeferredRetry,
    });
  }

  /**
   * Show quota toast for a session
   */
  async function showQuotaToast(
    sessionID: string,
    trigger: string,
    options: { deferredRetry?: boolean } = {},
  ): Promise<void> {
    if (!configLoaded) {
      await refreshConfig();
    }

    const pendingDeferred = deferredQuotaRefreshes.get(sessionID);
    const consumedDeferredRetry = options.deferredRetry === true || Boolean(pendingDeferred);
    if (pendingDeferred) {
      if (pendingDeferred.inFlight && !options.deferredRetry) {
        await log("Skipping duplicate deferred quota refresh", { sessionID, trigger });
        return;
      }
      pendingDeferred.inFlight = true;
      clearDeferredQuotaRefreshTimer(pendingDeferred);
    }

    try {
      // Check if session is a subagent session
      if (await isSubagentSession(sessionID)) {
        if (consumedDeferredRetry) {
          clearDeferredQuotaRefresh(sessionID);
        }
        await log("Skipping toast for subagent session", { sessionID, trigger });
        return;
      }

      // Get or fetch quota (with caching/throttling).
      // If debug is enabled, bypass caching so the toast reflects current state.
      const sessionMeta = await getSessionModelMeta(sessionID);
      const bypassForLiveLocalUsage = await shouldBypassToastCacheForLiveLocalUsage({
        trigger,
        sessionID,
        sessionMeta,
      });
      const bypassMessageCache = config.debug || consumedDeferredRetry || bypassForLiveLocalUsage;
      const bypassProviderCache = consumedDeferredRetry || bypassForLiveLocalUsage;
      const toastCacheKey = buildToastCacheKey({ sessionID, sessionMeta });

      let fetchResult: QuotaMessageFetchResult | undefined;
      const fetchForToast = () =>
        fetchQuotaMessageResult({
          trigger,
          sessionID,
          sessionMeta,
          bypassProviderCache,
        });

      const message = bypassMessageCache
        ? await (async () => {
            fetchResult = await fetchForToast();
            return fetchResult.message;
          })()
        : await (async () => {
            const fetched: { result?: QuotaMessageFetchResult } = {};
            const cachedMessage = await getOrFetchWithCacheControl(
              toastCacheKey,
              async () => {
                const result = await fetchForToast();
                fetched.result = result;
                const cache = Boolean(
                  result.message && result.cacheRenderedMessage && result.hasQuotaRows,
                );
                return { message: result.message, cache };
              },
              config.minIntervalMs,
            );
            fetchResult = fetched.result;
            return cachedMessage;
          })();

      if (fetchResult) {
        detectedProviderIdsByToastCacheKey.set(toastCacheKey, [
          ...fetchResult.detectedProviderIds,
        ]);
        await reconcileDeferredQuotaRefresh({
          sessionID,
          result: fetchResult,
          consumedDeferredRetry,
          trigger,
        });
      }

      if (options.deferredRetry && fetchResult && !fetchResult.hasQuotaRows) {
        await log("Deferred quota refresh did not produce reportable data", {
          sessionID,
          trigger,
          retryable: fetchResult.retryable,
          retryReason: fetchResult.retryReason,
        });
        return;
      }

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
        triggerMaintainerAnnouncementToastFallback(
          trigger,
          fetchResult?.detectedProviderIds ?? detectedProviderIdsByToastCacheKey.get(toastCacheKey) ?? [],
        );
        await log("Displayed quota toast", { message, trigger });
      } catch (err) {
        await log("Failed to show toast", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      const state = deferredQuotaRefreshes.get(sessionID);
      if (state && state === pendingDeferred) {
        state.inFlight = false;
      }
    }
  }


  async function buildStatusReport(params: {
    refreshGoogleTokens?: boolean;
    skewMs?: number;
    force?: boolean;
    sessionID?: string;
    generatedAtMs: number;
  }): Promise<string | null> {
    const runtime = await resolvePluginRuntimeContext({
      sessionID: params.sessionID,
      includeSessionMeta: true,
    });
    const runtimeConfig = runtime.config;
    if (!runtimeConfig.enabled) return null;
    await kickPricingRefresh({ reason: "status", maxWaitMs: 750 });

    const currentSession = runtime.session.sessionMeta ?? {};
    const currentModel = currentSession.modelID;
    const currentProviderID = currentSession.providerID;
    const sessionModelLookup: "ok" | "not_found" | "no_session" = !params.sessionID
      ? "no_session"
      : currentModel
        ? "ok"
        : "not_found";

    const isAutoMode = runtimeConfig.enabledProviders === "auto";

    const providers = runtime.providers;
    const providerContext = createQuotaProviderRuntimeContext(runtime);
    const availability = await Promise.all(
      providers.map(async (p) => {
        let ok = false;
        try {
          ok = await p.isAvailable(providerContext);
        } catch {
          ok = false;
        }
        return {
          id: p.id,
          // In auto mode, a provider is effectively "enabled" if it's available.
          enabled: isAutoMode ? ok : runtimeConfig.enabledProviders.includes(p.id),
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

    const providersById = new Map(providers.map((provider) => [provider.id, provider] as const));
    const liveProbeProviders = availability.flatMap((item) => {
      if (!item.enabled || !item.available) {
        return [];
      }
      const provider = providersById.get(item.id);
      return provider ? [provider] : [];
    });

    let providerLiveProbes: QuotaStatusLiveProbe[] = [];
    if (liveProbeProviders.length > 0) {
      try {
        providerLiveProbes = await collectQuotaStatusLiveProbes({
          client: runtime.client,
          config: runtimeConfig,
          configMeta: runtime.configMeta,
          request: createQuotaRuntimeRequestContext(runtime),
          formatStyle: SINGLE_WINDOW_PER_PROVIDER_FORMAT_STYLE,
          providers: liveProbeProviders,
        });
      } catch (error) {
        await typedClient.app.log({
          body: {
            service: "quota-toast",
            level: "warn",
            message: "Failed to collect /quota_status live probes",
            extra: {
              providers: liveProbeProviders.map((provider) => provider.id),
              error: error instanceof Error ? error.message : String(error),
            },
          },
        });
      }
    }

    const refresh = params.refreshGoogleTokens
      ? await refreshGoogleTokensForAllAccounts({ skewMs: params.skewMs, force: params.force })
      : null;

    const tuiDiagnostics = await inspectTuiConfig({ roots: runtime.roots });
    const announcementProviderIds = availability
      .filter((item) => item.enabled && item.available)
      .map((item) => item.id);
    const maintainerAnnouncementsSummary = getMaintainerAnnouncementsSummary({
      enabledProviders: announcementProviderIds,
    });

    return await buildQuotaStatusReport({
      tuiDiagnostics,
      configSource: runtime.configMeta.source,
      configPaths: runtime.configMeta.paths,
      globalConfigPaths: runtime.configMeta.globalConfigPaths,
      workspaceConfigPaths: runtime.configMeta.workspaceConfigPaths,
      settingSources: runtime.configMeta.settingSources,
      configIssues: runtime.configMeta.configIssues,
      enabledProviders: runtimeConfig.enabledProviders,
      anthropicBinaryPath: runtimeConfig.anthropicBinaryPath,
      alibabaCodingPlanTier: runtimeConfig.alibabaCodingPlanTier,
      cursorPlan: runtimeConfig.cursorPlan,
      cursorIncludedApiUsd: runtimeConfig.cursorIncludedApiUsd,
      cursorBillingCycleStartDay: runtimeConfig.cursorBillingCycleStartDay,
      opencodeGoWindows: runtimeConfig.opencodeGoWindows,
      pricingSnapshotSource: runtimeConfig.pricingSnapshot.source,
      onlyCurrentModel: runtimeConfig.onlyCurrentModel,
      currentModel,
      sessionModelLookup,
      providerAvailability: availability,
      providerLiveProbes,
      googleRefresh: refresh
        ? {
            attempted: true,
            total: refresh.total,
            successCount: refresh.successCount,
            failures: refresh.failures,
          }
        : { attempted: false },
      sessionTokenError: lastSessionTokenError,
      maintainerAnnouncements: {
        config: runtimeConfig.maintainerAnnouncements,
        summary: maintainerAnnouncementsSummary,
      },
      geminiCliClient: typedClient,
      generatedAtMs: params.generatedAtMs,
    });
  }

  // Return hook implementations
  return {
    // Preserve unrelated config repair only. Deterministic quota slash commands are
    // registered by the TUI plugin as palette/slash dialog commands.
    config: async (input: unknown) => {
      const cfg = input as PluginConfigInput;

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

      if (!config.enabled) {
        clearDeferredQuotaRefresh(sessionID);
        return;
      }

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

      if (!config.enabled) {
        clearDeferredQuotaRefresh(input.sessionID);
        return;
      }

      if (isSuccessfulQuestionExecution(output)) {
        const sessionMeta = await getSessionModelMeta(input.sessionID);
        const model = sessionMeta.modelID;
        try {
          if (isQwenCodeModelId(model)) {
            const plan = await resolveQwenLocalPlanCached();
            if (plan.state === "qwen_free") {
              await recordQwenCompletion();
              clearToastCacheForSession({ sessionID: input.sessionID, sessionMeta });
            }
          } else if (isAlibabaModelId(model)) {
            const plan = await resolveAlibabaCodingPlanAuthCached({
              maxAgeMs: DEFAULT_ALIBABA_AUTH_CACHE_MAX_AGE_MS,
              fallbackTier: config.alibabaCodingPlanTier,
            });
            if (plan.state === "configured") {
              await recordAlibabaCodingPlanCompletion();
              clearToastCacheForSession({ sessionID: input.sessionID, sessionMeta });
            }
          } else if (isCursorProviderId(sessionMeta.providerID) || isCursorModelId(model)) {
            clearToastCacheForSession({ sessionID: input.sessionID, sessionMeta });
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
