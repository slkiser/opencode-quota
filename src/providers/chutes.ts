/**
 * Chutes AI provider wrapper.
 */

import type { QuotaProvider, QuotaProviderContext, QuotaProviderResult } from "../lib/entries.js";
import { queryChutesQuota, hasChutesApiKeyConfigured } from "../lib/chutes.js";

export const chutesProvider: QuotaProvider = {
  id: "chutes",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    // Best-effort: if OpenCode exposes a chutes provider, prefer that.
    try {
      const resp = await ctx.client.config.providers();
      const ids = new Set((resp.data?.providers ?? []).map((p) => p.id));
      if (ids.has("chutes") || ids.has("chutes-ai")) return true;
    } catch {
      // ignore
    }

    return await hasChutesApiKeyConfigured();
  },

  matchesCurrentModel(model: string): boolean {
    const provider = model.split("/")[0]?.toLowerCase();
    if (!provider) return false;
    return provider.includes("chutes");
  },

  async fetch(_ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const result = await queryChutesQuota();

    if (!result) {
      return { attempted: false, entries: [], errors: [] };
    }

    if (!result.success) {
      return {
        attempted: true,
        entries: [],
        errors: [{ label: "Chutes", message: result.error }],
      };
    }

    return {
      attempted: true,
      entries: [
        {
          name: "Chutes",
          percentRemaining: result.percentRemaining,
          resetTimeIso: result.resetTimeIso,
        },
      ],
      errors: [],
    };
  },
};
