/**
 * Copilot provider wrapper.
 *
 * Normalizes Copilot quota into generic toast entries.
 */

import type { QuotaProvider, QuotaProviderContext, QuotaProviderResult } from "../lib/entries.js";
import { queryCopilotQuota } from "../lib/copilot.js";

export const copilotProvider: QuotaProvider = {
  id: "copilot",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    try {
      const resp = await ctx.client.config.providers();
      const ids = new Set((resp.data?.providers ?? []).map((p) => p.id));
      return ids.has("github-copilot") || ids.has("copilot") || ids.has("copilot-chat");
    } catch {
      return false;
    }
  },

  matchesCurrentModel(model: string): boolean {
    const lower = model.toLowerCase();
    // Check provider prefix (part before "/")
    const provider = lower.split("/")[0];
    if (provider && (provider.includes("copilot") || provider.includes("github"))) {
      return true;
    }
    // Also match if the full model string contains "copilot" or "github-copilot"
    // to handle models like "github-copilot/claude-sonnet-4.5"
    return lower.includes("copilot") || lower.includes("github-copilot");
  },

  async fetch(_ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const result = await queryCopilotQuota();

    if (!result) {
      return { attempted: false, entries: [], errors: [] };
    }

    if (!result.success) {
      return {
        attempted: true,
        entries: [],
        errors: [{ label: "Copilot", message: result.error }],
      };
    }

    return {
      attempted: true,
      entries: [
        {
          name: "Copilot",
          percentRemaining: result.percentRemaining,
          resetTimeIso: result.resetTimeIso,
        },
      ],
      errors: [],
    };
  },
};
