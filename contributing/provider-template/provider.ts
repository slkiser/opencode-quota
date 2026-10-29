/**
 * Template target: src/providers/<provider>.ts
 *
 * Purpose: wire provider availability, current-model matching, and quota-result
 * mapping into the quota provider registry.
 */

import type {
  AccountingMetadata,
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
} from "../lib/entries.js";
import { hasExampleProviderApiKey } from "../lib/example-provider-config.js";
import { queryExampleProviderQuota } from "../lib/example-provider.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { modelProviderIncludesAny } from "../lib/provider-model-matching.js";
import { attemptedErrorResult, attemptedResult, notAttemptedResult } from "./result-helpers.js";

const EXAMPLE_QUOTA_ACCOUNTING: AccountingMetadata = {
  resultType: "quota",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
};

export const exampleProviderProvider: QuotaProvider = {
  id: "example-provider",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const providerAvailable = await isCanonicalProviderAvailable({
      ctx,
      providerId: "example-provider",
      fallbackOnError: false,
    });
    if (providerAvailable) return true;

    return await hasExampleProviderApiKey();
  },

  matchesCurrentModel(model: string): boolean {
    return modelProviderIncludesAny(model, ["example-provider", "example"]);
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const result = await queryExampleProviderQuota({
      requestTimeoutMs: ctx.config?.requestTimeoutMs,
    });

    if (!result) return notAttemptedResult();

    if (!result.success) {
      return attemptedErrorResult("Example Provider", result.error);
    }

    return attemptedResult([
      {
        accounting: EXAMPLE_QUOTA_ACCOUNTING,
        name: "Example Provider",
        percentRemaining: result.percentRemaining,
        resetTimeIso: result.resetTimeIso,
      },
    ]);
  },
};
