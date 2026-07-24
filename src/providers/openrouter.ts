/**
 * OpenRouter provider wrapper.
 */

import type { QuotaProvider, QuotaProviderContext, QuotaProviderResult } from "../lib/entries.js";
import { hasOpenRouterApiKeyConfigured, queryOpenRouterQuota } from "../lib/openrouter.js";
import { modelProviderMatchesRuntimeId } from "../lib/provider-model-matching.js";
import { attemptedResult, mapNullableProviderResult } from "./result-helpers.js";

export const openRouterProvider: QuotaProvider = {
  id: "openrouter",

  async isAvailable(_ctx: QuotaProviderContext): Promise<boolean> {
    return await hasOpenRouterApiKeyConfigured();
  },

  matchesCurrentModel(model: string): boolean {
    return modelProviderMatchesRuntimeId(model, "openrouter");
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const result = await queryOpenRouterQuota({
      requestTimeoutMs: ctx.config?.requestTimeoutMs,
    });

    return mapNullableProviderResult(result, {
      errorLabel: "OpenRouter",
      onSuccess: (success) =>
        attemptedResult(
          success.entries,
          success.rowErrors?.map((message) => ({ label: "OpenRouter", message })) ?? [],
          { singleWindowShowRight: true },
        ),
    });
  },
};
