import type { QuotaProvider, QuotaProviderResult } from "../lib/entries.js";
import { queryChutesQuota, hasChutesApiKeyConfigured } from "../lib/chutes.js";

export const chutesProvider: QuotaProvider = {
  id: "chutes",

  async isAvailable(): Promise<boolean> {
    return await hasChutesApiKeyConfigured();
  },

  async fetch(): Promise<QuotaProviderResult> {
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

  matchesCurrentModel(model: string): boolean {
    return model.toLowerCase().includes("chutes/");
  },
};
