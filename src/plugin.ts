/**
 * OpenCode Quota Toast Plugin
 *
 * Shows a minimal quota status toast without LLM invocation.
 * Triggers on session.idle, session.compacted, and question tool completion.
 * Supports GitHub Copilot and Google (via opencode-antigravity-auth).
 */

import { isMainThread } from "node:worker_threads";
import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { handled } from "./lib/command-handled.js";
import { shouldRegisterServerSlashCommands } from "./lib/command-surfaces.js";
import { findGitWorktreeRoot, getEffectiveConfigRoot } from "./lib/config-file-utils.js";
import { sanitizeDisplayText } from "./lib/display-sanitize.js";
import { reconcileDetectedProvidersInGlobalConfig } from "./lib/opencode-config-providers.js";
import {
  buildQuotaDialogCommandOutput,
  isQuotaDialogCommand,
  QUOTA_DIALOG_COMMANDS,
  type QuotaDialogCommandId,
} from "./lib/quota-dialog-commands.js";
import type { SessionModelMeta } from "./lib/quota-render-data.js";
import type { SessionTokenError } from "./lib/quota-status.js";
import { disposeQuotaTelemetryOwner } from "./lib/quota-telemetry.js";
import { createQuotaToastRuntime } from "./lib/quota-toast-runtime.js";
import type { QuotaToastConfig } from "./lib/types.js";

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
        model?: {
          id?: string;
          providerID?: string;
        };
      };
    }>;
    prompt: (params: {
      path: { id: string };
      body: {
        noReply?: boolean;
        parts: Array<{ type: "text"; text: string; ignored?: boolean }>;
      };
    }) => Promise<unknown>;
    abort: (params: { path: { id: string } }) => Promise<unknown>;
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

function normalizeDefaultAgent(cfg: PluginConfigInput | null | undefined): void {
  if (!cfg?.default_agent || !cfg.agent || cfg.default_agent in cfg.agent) return;

  const stripped = (value: string) => value.replace(/[\u200B\u200C\u200D\uFEFF]/g, "");
  const target = stripped(cfg.default_agent);
  const matches = Object.keys(cfg.agent).filter((key) => stripped(key) === target);
  if (matches.length === 1) {
    cfg.default_agent = matches[0];
  }
}

/** Server command execution hook input */
interface CommandExecuteInput {
  command: string;
  arguments?: string;
  sessionID: string;
}

// =============================================================================
// Plugin Implementation
// =============================================================================

/**
 * Main plugin export
 */
export const QuotaToastPlugin: Plugin = async ({ client, directory }) => {
  const typedClient = client as unknown as OpencodeClient;
  let opencodeConfig: PluginConfigInput | null = null;

  /**
   * Inject tool output directly into the session without triggering an LLM response.
   * This prevents models from summarizing/rewriting our carefully formatted reports.
   */
  async function injectRawOutput(
    sessionID: string,
    output: string,
    options: { rethrow?: boolean } = {},
  ): Promise<void> {
    normalizeDefaultAgent(opencodeConfig);

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
      // Log but don't fail by default - tool output can still be returned.
      await typedClient.app.log({
        body: {
          service: "quota-toast",
          level: "warn",
          message: "Failed to inject raw output",
          extra: { error: err instanceof Error ? err.message : String(err) },
        },
      });
      if (options.rethrow) {
        throw err;
      }
    }
  }

  let providerConfigReconcileQueue: Promise<void> = Promise.resolve();

  // Track last session token error for /quota_status diagnostics
  let lastSessionTokenError: SessionTokenError | undefined;

  function getPluginRuntimeRootHints() {
    const cwd = directory || process.cwd();
    const workspaceRoot = findGitWorktreeRoot(cwd) ?? cwd;
    const configRoot = getEffectiveConfigRoot(workspaceRoot);
    return {
      workspaceRoot,
      configRoot,
      fallbackDirectory: cwd,
    };
  }

  function registerDeterministicSlashCommands(cfg: PluginConfigInput): void {
    cfg.command ??= {};

    for (const spec of QUOTA_DIALOG_COMMANDS) {
      cfg.command[spec.id] = {
        template: `/${spec.slashName}`,
        description: spec.description,
      };
    }
  }

  async function handleDeterministicSlashCommand(input: CommandExecuteInput): Promise<never> {
    const command = input.command as QuotaDialogCommandId;
    const result = await buildQuotaDialogCommandOutput({
      command,
      arguments: input.arguments,
      client: typedClient,
      roots: getPluginRuntimeRootHints(),
      sessionID: input.sessionID,
      resolveSessionMeta: (sessionID) => getSessionModelMeta(sessionID),
      lastSessionTokenError,
      setLastSessionTokenError: (error) => {
        lastSessionTokenError = error;
      },
      log,
    });

    if (result.state === "output") {
      await injectRawOutput(input.sessionID, result.output, { rethrow: true });
      // Settle the session so lifecycle watchers recover from chat.message.
      try {
        await typedClient.session.abort({ path: { id: input.sessionID } });
      } catch {
        // Best-effort settle; the injected output is already visible.
      }
    }

    handled();
  }

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

  async function reconcileDetectedProviderConfig(providerIds: readonly string[]): Promise<void> {
    if (!directory || providerIds.length === 0) return;

    const reconcile = async () => {
      try {
        const result = await reconcileDetectedProvidersInGlobalConfig({
          configRootDir: getPluginRuntimeRootHints().configRoot,
          detectedProviderIds: providerIds,
        });
        if (result.changed) {
          await log("Added detected providers to global OpenCode config", {
            path: result.path,
            format: result.format,
            providers: result.addedProviderIds,
          });
        }
      } catch (error) {
        try {
          await typedClient.app.log({
            body: {
              service: "quota-toast",
              level: "warn",
              message: "Failed to add detected providers to global OpenCode config",
              extra: { error: error instanceof Error ? error.message : String(error) },
            },
          });
        } catch {
          // Automatic config repair is best-effort and must not break quota output.
        }
      }
    };

    providerConfigReconcileQueue = providerConfigReconcileQueue.then(reconcile, reconcile);
    await providerConfigReconcileQueue;
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
        modelID: sessionResp.data?.model?.id,
        providerID: sessionResp.data?.model?.providerID,
      };
    } catch {
      return {};
    }
  }

  const quotaToastRuntime = createQuotaToastRuntime({
    client: typedClient,
    roots: getPluginRuntimeRootHints,
    resolveSessionMeta: (sessionID) => getSessionModelMeta(sessionID),
    isSubagentSession,
    reconcileDetectedProviders: reconcileDetectedProviderConfig,
    setSessionTokenError: (error) => {
      lastSessionTokenError = error;
    },
    showToast: (body) => typedClient.tui.showToast({ body }),
    log,
    onInitialized: (extra) => {
      void typedClient.app
        .log({
          body: {
            service: "quota-toast",
            level: "info",
            message: "plugin initialized",
            extra,
          },
        })
        .catch(() => {});
    },
  });

  // Return hook implementations
  return {
    dispose: async () => {
      disposeQuotaTelemetryOwner(typedClient);
    },

    config: async (input: unknown) => {
      const cfg = input as PluginConfigInput;
      opencodeConfig = cfg;
      if (shouldRegisterServerSlashCommands({ isMainThread, argv: process.argv })) {
        registerDeterministicSlashCommands(cfg);
      }

      // Keep the config-time correction for #39. injectRawOutput repeats the
      // same correction after later config hooks have run to handle #169.
      normalizeDefaultAgent(cfg);
    },

    "command.execute.before": async (input: CommandExecuteInput) => {
      if (!isQuotaDialogCommand(input.command)) return;
      await handleDeterministicSlashCommand(input);
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
          const result = await buildQuotaDialogCommandOutput({
            command: "quota_status",
            arguments: JSON.stringify({
              refreshGoogleTokens: args.refreshGoogleTokens,
              skewMs: args.skewMs,
              force: args.force,
            }),
            client: typedClient,
            roots: getPluginRuntimeRootHints(),
            sessionID: context.sessionID,
            resolveSessionMeta: (sessionID) => getSessionModelMeta(sessionID),
            lastSessionTokenError,
            log,
            onDetectedProviderIds: reconcileDetectedProviderConfig,
          });
          if (result.state !== "output") return "";
          context.metadata({ title: "Quota Status" });
          await injectRawOutput(context.sessionID, result.output);
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

      await quotaToastRuntime.handleTrigger({ sessionID, trigger: event.type });
    },

    // Tool execute hook for question tool
    "tool.execute.after": async (input: ToolExecuteAfterInput, _output: ToolExecuteAfterOutput) => {
      if (input.tool !== "question") return;

      await quotaToastRuntime.handleTrigger({ sessionID: input.sessionID, trigger: "question" });
    },
  };
};
