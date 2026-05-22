/**
 * Anthropic Claude provider wrapper.
 *
 * Normalizes Claude CLI-exposed quota windows into generic toast entries.
 * Also handles Enterprise usage-based plans where quota is expressed as
 * monthly dollar spend limits (extra_usage) rather than token windows.
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

function formatUsd(amount: number): string {
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
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
      requestTimeoutMs: ctx.config?.requestTimeoutMs,
    });

    if (!result) {
      return notAttemptedResult();
    }

    if (!result.success) {
      return attemptedErrorResult("Claude", result.error);
    }

    const entries: QuotaToastEntry[] = [];

    // Token-window quota (personal/Pro/Team plans)
    if (result.five_hour) {
      entries.push({
        name: "Claude 5h",
        group: "Claude",
        label: "5h:",
        percentRemaining: result.five_hour.percentRemaining,
        resetTimeIso: result.five_hour.resetTimeIso,
      });
    }
    if (result.seven_day) {
      entries.push({
        name: "Claude Weekly",
        group: "Claude",
        label: "Weekly:",
        percentRemaining: result.seven_day.percentRemaining,
        resetTimeIso: result.seven_day.resetTimeIso,
      });
    }

    // Enterprise usage-based plan: personal/group monthly spend limit
    if (result.extra_usage && result.extra_usage.isEnabled) {
      const { usedCreditsUsd, monthlyLimitUsd, utilization, currency } = result.extra_usage;
      const percentRemaining = Math.max(0, Math.round(100 - utilization));
      const right =
        currency === "USD"
          ? `${formatUsd(usedCreditsUsd)}/${formatUsd(monthlyLimitUsd)}`
          : `${usedCreditsUsd}/${monthlyLimitUsd} ${currency}`;

      entries.push({
        name: "Claude Spend Limit",
        group: "Claude",
        label: "Spend:",
        percentRemaining,
        right,
      });
    }

    if (entries.length === 0) {
      return attemptedErrorResult("Claude", getAnthropicNoDataMessage());
    }

    return attemptedResult(entries);
  },
};
