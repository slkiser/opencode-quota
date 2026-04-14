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
  return "Quota unavailable via local Claude CLI";
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

    const style = ctx.config?.toastStyle ?? "classic";

    if (style === "grouped") {
      const entries: QuotaToastEntry[] = [
        {
          name: "Claude 5h",
          group: "Claude",
          label: "5-hour:",
          percentRemaining: result.five_hour.percentRemaining,
          resetTimeIso: result.five_hour.resetTimeIso,
        },
        {
          name: "Claude 7d",
          group: "Claude",
          label: "7-day:",
          percentRemaining: result.seven_day.percentRemaining,
          resetTimeIso: result.seven_day.resetTimeIso,
        },
      ];

      return attemptedResult(entries);
    }

    // Classic style: show the worse of the two windows.
    const worst =
      result.five_hour.percentRemaining <= result.seven_day.percentRemaining
        ? { name: "Claude 5h", ...result.five_hour }
        : { name: "Claude 7d", ...result.seven_day };

    return attemptedResult([
      {
        name: worst.name,
        percentRemaining: worst.percentRemaining,
        resetTimeIso: worst.resetTimeIso,
      },
    ]);
  },
};
