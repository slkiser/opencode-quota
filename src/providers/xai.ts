/**
 * xAI SuperGrok provider wrapper.
 */

import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderMatchContext,
  QuotaProviderResult,
} from "../lib/entries.js";
import {
  DEFAULT_XAI_AUTH_CACHE_MAX_AGE_MS,
  hasXaiOAuthCached,
  periodKindLabel,
  queryXaiQuota,
} from "../lib/xai.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { modelProviderMatchesRuntimeId } from "../lib/provider-model-matching.js";
import { normalizeQuotaProviderId } from "../lib/provider-metadata.js";
import { attemptedResult, mapNullableProviderResult } from "./result-helpers.js";

export const xaiProvider: QuotaProvider = {
  id: "xai",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const providerAvailable = await isCanonicalProviderAvailable({
      ctx,
      providerId: "xai",
      fallbackOnError: false,
    });
    if (providerAvailable) return hasXaiOAuthCached({ maxAgeMs: 0 });
    return hasXaiOAuthCached({ maxAgeMs: DEFAULT_XAI_AUTH_CACHE_MAX_AGE_MS });
  },

  matchesCurrentModel(model: string, context?: QuotaProviderMatchContext): boolean {
    if (context?.currentProviderID) {
      return normalizeQuotaProviderId(context.currentProviderID) === "xai";
    }
    return modelProviderMatchesRuntimeId(model, "xai");
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const result = await queryXaiQuota({ requestTimeoutMs: ctx.config?.requestTimeoutMs });

    return mapNullableProviderResult(result, {
      errorLabel: "xAI",
      onSuccess: (result) => {
        const period = periodKindLabel(result.window.kind);
        return attemptedResult(
          [
            {
              name: `${result.label} ${period}`,
              group: result.label,
              label: `${period}:`,
              percentRemaining: result.window.percentRemaining,
              resetTimeIso: result.window.resetTimeIso,
            },
          ],
          [],
          { singleWindowDisplayName: result.label },
        );
      },
    });
  },
};
