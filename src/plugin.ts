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
import { aggregateUsage, getSessionTokenSummary } from "./lib/quota-stats.js";
import type { SessionTokensData } from "./lib/entries.js";
import { formatQuotaStatsReport } from "./lib/quota-stats-format.js";
import { buildQuotaStatusReport } from "./lib/quota-status.js";
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
      } catch {
        // Ignore errors fetching session tokens - it's a nice-to-have
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
      } catch {
        // Ignore errors fetching session tokens - it's a nice-to-have
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
    });
  }

  // Return hook implementations
  return {
    // Register built-in slash commands (in addition to /tool quota_*)
    config: async (input: unknown) => {
      const cfg = input as PluginConfigInput;
      cfg.command ??= {};
      cfg.command["quota"] = {
        template: "/quota",
        description: "Show quota toast output in chat.",
      };
      cfg.command["quota_daily"] = {
        template: "/quota_daily",
        description: "Token + official API cost summary for the last 24 hours (rolling).",
      };
      cfg.command["quota_weekly"] = {
        template: "/quota_weekly",
        description: "Token + official API cost summary for the last 7 days (rolling).",
      };
      cfg.command["quota_monthly"] = {
        template: "/quota_monthly",
        description: "Token + official API cost summary for the last 30 days (rolling).",
      };
      cfg.command["quota_all"] = {
        template: "/quota_all",
        description: "Token + official API cost summary for all locally saved OpenCode history.",
      };
      cfg.command["quota_status"] = {
        template: "/quota_status",
        description:
          "Diagnostics for toast + pricing + local storage (includes unknown pricing report).",
      };
      cfg.command["quota_today"] = {
        template: "/quota_today",
        description: "Token + official API cost summary for today (calendar day, local timezone).",
      };
      cfg.command["quota_session"] = {
        template: "/quota_session",
        description: "Token + official API cost summary for current session only.",
      };
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
      if (cmd === "quota_daily") {
        const sinceMs = untilMs - 24 * 60 * 60 * 1000;
        const out = await buildQuotaReport({
          title: "Quota (/quota_daily)",
          sinceMs,
          untilMs,
          sessionID,
        });
        await injectRawOutput(sessionID, out);
        throw new Error("__QUOTA_COMMAND_HANDLED__");
      }
      if (cmd === "quota_weekly") {
        const sinceMs = untilMs - 7 * 24 * 60 * 60 * 1000;
        const out = await buildQuotaReport({
          title: "Quota (/quota_weekly)",
          sinceMs,
          untilMs,
          sessionID,
        });
        await injectRawOutput(sessionID, out);
        throw new Error("__QUOTA_COMMAND_HANDLED__");
      }
      if (cmd === "quota_monthly") {
        const sinceMs = untilMs - 30 * 24 * 60 * 60 * 1000;
        const out = await buildQuotaReport({
          title: "Quota (/quota_monthly)",
          sinceMs,
          untilMs,
          sessionID,
        });
        await injectRawOutput(sessionID, out);
        throw new Error("__QUOTA_COMMAND_HANDLED__");
      }
      if (cmd === "quota_all") {
        const out = await buildQuotaReport({
          title: "Quota (/quota_all)",
          sessionID,
          topModels: 12,
          topSessions: 12,
        });
        await injectRawOutput(sessionID, out);
        throw new Error("__QUOTA_COMMAND_HANDLED__");
      }
      if (cmd === "quota_status") {
        const parsed = parseOptionalJsonArgs(input.arguments);
        if (!parsed.ok) {
          await injectRawOutput(
            sessionID,
            `Invalid arguments for /quota_status\n\n${parsed.error}\n\nExample:\n/quota_status {\"refreshGoogleTokens\": true}`,
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
      if (cmd === "quota_today") {
        // Calendar day in local timezone: midnight to now
        const now = new Date();
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const sinceMs = startOfDay.getTime();
        const untilMs = now.getTime();
        const out = await buildQuotaReport({
          title: "Quota (/quota_today)",
          sinceMs,
          untilMs,
          sessionID,
        });
        await injectRawOutput(sessionID, out);
        throw new Error("__QUOTA_COMMAND_HANDLED__");
      }
      if (cmd === "quota_session") {
        const out = await buildQuotaReport({
          title: "Quota (/quota_session)",
          sessionID,
          filterSessionID: sessionID,
          sessionOnly: true,
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
            title: "Quota (/quota_daily)",
            sinceMs,
            untilMs,
            sessionID: context.sessionID,
          });
          context.metadata({ title: "Quota Daily" });
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
            title: "Quota (/quota_weekly)",
            sinceMs,
            untilMs,
            sessionID: context.sessionID,
          });
          context.metadata({ title: "Quota Weekly" });
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
            title: "Quota (/quota_monthly)",
            sinceMs,
            untilMs,
            sessionID: context.sessionID,
          });
          context.metadata({ title: "Quota Monthly" });
          await injectRawOutput(context.sessionID, out);
          return ""; // Empty return - output already injected with noReply
        },
      }),

      quota_all: tool({
        description: "Token + official API cost summary for all locally saved OpenCode history.",
        args: {},
        async execute(_args, context) {
          const out = await buildQuotaReport({
            title: "Quota (/quota_all)",
            sessionID: context.sessionID,
            topModels: 12,
            topSessions: 12,
          });
          context.metadata({ title: "Quota All" });
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
            title: "Quota (/quota_today)",
            sinceMs,
            untilMs,
            sessionID: context.sessionID,
          });
          context.metadata({ title: "Quota Today" });
          await injectRawOutput(context.sessionID, out);
          return ""; // Empty return - output already injected with noReply
        },
      }),

      quota_session: tool({
        description: "Token + official API cost summary for current session only.",
        args: {},
        async execute(_args, context) {
          const out = await buildQuotaReport({
            title: "Quota (/quota_session)",
            sessionID: context.sessionID,
            filterSessionID: context.sessionID,
            sessionOnly: true,
          });
          context.metadata({ title: "Quota Session" });
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
