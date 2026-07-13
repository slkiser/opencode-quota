/**
 * xAI SuperGrok provider wrapper.
 */

import type { QuotaProvider, QuotaProviderContext, QuotaProviderResult } from "../lib/entries.js";
import {
  DEFAULT_XAI_AUTH_CACHE_MAX_AGE_MS,
  hasXaiOAuthCached,
  periodKindLabel,
  queryXaiQuota,
} from "../lib/xai.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { modelProviderMatchesRuntimeId } from "../lib/provider-model-matching.js";
import {
  attemptedResult,
  groupedPercentWindowEntries,
  mapNullableProviderResult,
} from "./result-helpers.js";

export const xaiProvider: QuotaProvider = {
  id: "xai",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const availableByProviderId = await isCanonicalProviderAvailable({
      ctx,
      providerId: "xai",
      fallbackOnError: true,
    });
    if (availableByProviderId) return true;
    return hasXaiOAuthCached({ maxAgeMs: DEFAULT_XAI_AUTH_CACHE_MAX_AGE_MS });
  },

  matchesCurrentModel(model: string): boolean {
    // Exact runtime provider ids only (`xai`, `grok`). Avoid matching bare
    // model ids like `grok-code-fast-1` on Copilot/OpenRouter sessions.
    return modelProviderMatchesRuntimeId(model, "xai");
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const result = await queryXaiQuota({ requestTimeoutMs: ctx.config?.requestTimeoutMs });

    return mapNullableProviderResult(result, {
      errorLabel: "xAI",
      onSuccess: (result) => {
        const primaryLabel = result.windows.primary
          ? periodKindLabel(result.windows.primary.kind)
          : "Weekly";

        // Under unified SuperGrok billing, Api/GrokChat share one weekly pool.
        // Showing product rows (e.g. "GrokChat 100%") looks like a separate
        // quota and confuses the main Weekly meter. Only expand products when
        // the account is not on unified billing.
        const productWindows = result.unifiedBilling
          ? []
          : result.windows.products
              .filter((product) => {
                if (!result.windows.primary) return true;
                return product.window.percentRemaining !== result.windows.primary.percentRemaining;
              })
              .map((product) => ({
                window: product.window,
                suffix: product.product,
                label: `${product.product}:`,
              }));

        // SuperGrok UI only surfaces the shared weekly credit meter (matches
        // grok.com). Monthly $ allowance is intentionally not displayed.
        const entries = groupedPercentWindowEntries({
          group: result.label,
          windows: [
            result.windows.primary
              ? {
                  window: result.windows.primary,
                  suffix: primaryLabel,
                  label: `${primaryLabel}:`,
                }
              : { window: undefined, suffix: primaryLabel, label: `${primaryLabel}:` },
            ...productWindows,
          ],
          fallbackWhenEmpty: true,
        });

        return attemptedResult(entries, [], {
          singleWindowDisplayName: result.label,
        });
      },
    });
  },
};
