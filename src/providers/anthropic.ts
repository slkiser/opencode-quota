/**
 * Anthropic Claude provider wrapper.
 *
 * Normalizes Claude CLI-exposed quota windows into generic toast entries.
 */

import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import {
  hasAnthropicCredentialsConfigured,
  queryAnthropicQuota,
} from "../lib/anthropic.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { attemptedErrorResult, attemptedResult, notAttemptedResult } from "./result-helpers.js";

export function getAnthropicNoDataMessage(): string {
  return "Quota unavailable via local Claude CLI or Claude OAuth fallback";
}

export const anthropicProvider: QuotaProvider = {
  id: "anthropic",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const providerAvailable = await isCanonicalProviderAvailable({
      ctx,
      providerId: "anthropic",
      fallbackOnError: false,
    });
    if (!providerAvailable) {
      return false;
    }

    return await hasAnthropicCredentialsConfigured({
      binaryPath: ctx.config?.anthropicBinaryPath,
    });
  },

  matchesCurrentModel(model: string): boolean {
    return model.toLowerCase().startsWith("anthropic/");
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const result = await queryAnthropicQuota({
      binaryPath: ctx.config?.anthropicBinaryPath,
    });

    if (!result) {
      return notAttemptedResult();
    }

    if (!result.success) {
      return attemptedErrorResult("Claude", result.error);
    }

    const entries: QuotaToastEntry[] = [
      {
        name: "Claude 5h",
        group: "Claude",
        label: "5h:",
        percentRemaining: result.five_hour.percentRemaining,
        resetTimeIso: result.five_hour.resetTimeIso,
      },
      {
        name: "Claude Weekly",
        group: "Claude",
        label: "Weekly:",
        percentRemaining: result.seven_day.percentRemaining,
        resetTimeIso: result.seven_day.resetTimeIso,
      },
    ];

    return attemptedResult(entries);
  },
};
