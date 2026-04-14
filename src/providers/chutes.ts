/**
 * Chutes AI provider wrapper.
 */

import type { QuotaProvider, QuotaProviderContext, QuotaProviderResult } from "../lib/entries.js";
import { queryChutesQuota, hasChutesApiKeyConfigured } from "../lib/chutes.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { attemptedErrorResult, attemptedResult, notAttemptedResult } from "./result-helpers.js";

export const chutesProvider: QuotaProvider = {
  id: "chutes",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const providerAvailable = await isCanonicalProviderAvailable({
      ctx,
      providerId: "chutes",
      fallbackOnError: false,
    });
    if (providerAvailable) return true;

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
      return notAttemptedResult();
    }

    if (!result.success) {
      return attemptedErrorResult("Chutes", result.error);
    }

    return attemptedResult([
      {
        name: "Chutes",
        percentRemaining: result.percentRemaining,
        resetTimeIso: result.resetTimeIso,
      },
    ]);
  },
};
