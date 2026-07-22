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
import {
  attemptedResult,
  groupedPercentWindowEntries,
  mapNullableProviderResult,
} from "./result-helpers.js";

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
          groupedPercentWindowEntries({
            group: result.label,
            accounting: {
              resultType: "quota",
              acquisitionMethod: "remote_api",
              ownership: "maintained",
              authority: "provider_reported",
            },
            windows: [{ window: result.window, suffix: period, label: `${period}:` }],
          }),
          [],
          { singleWindowDisplayName: result.label },
        );
      },
    });
  },
};
