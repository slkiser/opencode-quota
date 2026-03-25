/**
 * Anthropic Claude provider wrapper.
 *
 * Normalizes Anthropic quota windows into generic toast entries.
 *
 * Surfaces the 5-hour and 7-day rate-limit windows from the Anthropic OAuth
 * usage API using Claude Code credentials.
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
import { isAnyProviderIdAvailable } from "../lib/provider-availability.js";

export const anthropicProvider: QuotaProvider = {
  id: "anthropic",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const providerAvailable = await isAnyProviderIdAvailable({
      ctx,
      candidateIds: ["anthropic"],
      fallbackOnError: false,
    });
    if (!providerAvailable) {
      return false;
    }

    return await hasAnthropicCredentialsConfigured();
  },

  matchesCurrentModel(model: string): boolean {
    return model.toLowerCase().startsWith("anthropic/");
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const result = await queryAnthropicQuota();

    if (!result) {
      return { attempted: false, entries: [], errors: [] };
    }

    if (!result.success) {
      return {
        attempted: true,
        entries: [],
        errors: [{ label: "Claude", message: result.error }],
      };
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

      return { attempted: true, entries, errors: [] };
    }

    // Classic style: show the worse of the two windows.
    const worst =
      result.five_hour.percentRemaining <= result.seven_day.percentRemaining
        ? { name: "Claude 5h", ...result.five_hour }
        : { name: "Claude 7d", ...result.seven_day };

    return {
      attempted: true,
      entries: [
        {
          name: worst.name,
          percentRemaining: worst.percentRemaining,
          resetTimeIso: worst.resetTimeIso,
        },
      ],
      errors: [],
    };
  },
};
