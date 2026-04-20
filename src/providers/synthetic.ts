/**
 * Synthetic provider wrapper.
 */

import type { QuotaProvider, QuotaProviderContext, QuotaProviderResult } from "../lib/entries.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import {
  hasSyntheticApiKeyConfigured,
  querySyntheticQuota,
} from "../lib/synthetic.js";
import { attemptedErrorResult, attemptedResult, notAttemptedResult } from "./result-helpers.js";

export const syntheticProvider: QuotaProvider = {
  id: "synthetic",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const providerAvailable = await isCanonicalProviderAvailable({
      ctx,
      providerId: "synthetic",
      fallbackOnError: false,
    });
    if (providerAvailable) return true;

    return await hasSyntheticApiKeyConfigured();
  },

  matchesCurrentModel(model: string): boolean {
    const provider = model.split("/")[0]?.toLowerCase();
    if (!provider) return false;
    return provider.includes("synthetic");
  },

  async fetch(_ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const result = await querySyntheticQuota();

    if (!result) {
      return notAttemptedResult();
    }

    if (!result.success) {
      return attemptedErrorResult("Synthetic", result.error);
    }

    return attemptedResult([
      {
        name: "Synthetic",
        percentRemaining: result.percentRemaining,
        right: `${result.usedRequests}/${result.requestLimit}`,
        resetTimeIso: result.resetTimeIso,
      },
    ]);
  },
};
