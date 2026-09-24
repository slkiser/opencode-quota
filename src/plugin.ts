/** OpenCode V2 server plugin: deterministic quota diagnostics tool. */
import { Plugin } from "@opencode/plugin";
import { findGitWorktreeRoot, getEffectiveConfigRoot } from "./lib/config-file-utils.js";
import { sanitizeDisplayText } from "./lib/display-sanitize.js";
import { reconcileDetectedProvidersInGlobalConfig } from "./lib/opencode-config-providers.js";
import { buildQuotaDialogCommandOutput } from "./lib/quota-dialog-commands.js";

export const QuotaToastPlugin = Plugin.define({
  id: "@slkiser/opencode-quota.server",
  async setup(ctx) {
    const directory = ctx.location.directory;
    const workspaceRoot = findGitWorktreeRoot(directory) ?? directory;
    const roots = {
      workspaceRoot,
      configRoot: getEffectiveConfigRoot(workspaceRoot),
      fallbackDirectory: directory,
    };
    // The quota collector accepts a small V1-shaped configuration client. V2
    // does not expose a mutable global config to plugins; quota settings are
    // read from the plugin's own config file by the collector.
    const client = {
      config: {
        get: async () => ({ data: {} }),
        providers: async () => ({
          data: {
            providers: (await ctx.provider.list()).data.map((provider) => ({ id: provider.id })),
          },
        }),
      },
    };

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "quota_status",
        description: "Diagnostics for toast, TUI, pricing and local storage.",
        input: {
          type: "object",
          properties: {
            refreshGoogleTokens: { type: "boolean" },
            skewMs: { type: "integer", minimum: 0 },
            force: { type: "boolean" },
          },
          additionalProperties: false,
        },
        async execute(input, context) {
          const options = input as {
            refreshGoogleTokens?: boolean;
            skewMs?: number;
            force?: boolean;
          };
          const result = await buildQuotaDialogCommandOutput({
            command: "quota_status",
            arguments: JSON.stringify(options),
            client,
            roots,
            sessionID: context.sessionID,
            resolveSessionMeta: async (sessionID) => {
              const session = await ctx.session.get({ sessionID });
              return { modelID: session.model?.id, providerID: session.model?.providerID };
            },
            onDetectedProviderIds: async (providerIds) => {
              if (providerIds.length === 0) return;
              try {
                await reconcileDetectedProvidersInGlobalConfig({
                  configRootDir: roots.configRoot,
                  detectedProviderIds: providerIds,
                });
              } catch (error) {
                console.warn("Failed to add detected providers to global OpenCode config", error);
              }
            },
          });
          return { content: result.state === "output" ? sanitizeDisplayText(result.output) : "" };
        },
      });
    });
  },
});

export default QuotaToastPlugin;
