/**
 * Xiaomi Token Plan provider wrapper.
 *
 * Queries the Xiaomi platform API for Token Plan credit usage and displays
 * remaining credits as a percentage-based quota entry.
 */

import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import {
  formatXiaomiCreditsUsedLimit,
  hasXiaomiCookieConfigured,
  queryXiaomiTokenPlan,
} from "../lib/xiaomi.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { modelProviderIncludesAny } from "../lib/provider-model-matching.js";
import { attemptedErrorResult, attemptedResult, notAttemptedResult } from "./result-helpers.js";

const XIAOMI_PROVIDER_LABEL = "Xiaomi Token Plan";

export const xiaomiProvider: QuotaProvider = {
  id: "xiaomi",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const providerAvailable = await isCanonicalProviderAvailable({
      ctx,
      providerId: "xiaomi",
      fallbackOnError: false,
    });
    if (providerAvailable) return true;

    return await hasXiaomiCookieConfigured();
  },

  matchesCurrentModel(model: string): boolean {
    return modelProviderIncludesAny(model, ["xiaomi", "mimo"]);
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const result = await queryXiaomiTokenPlan({
      requestTimeoutMs: ctx.config?.requestTimeoutMs,
    });

    if (!result) return notAttemptedResult();

    if (!result.success) {
      return attemptedErrorResult(XIAOMI_PROVIDER_LABEL, result.error);
    }

    const entries: QuotaToastEntry[] = [];

    // Use the plan_total_token usage item (main quota)
    const planUsage = result.usage.usage.items.find(
      (item) => item.name === "plan_total_token",
    );

    if (planUsage) {
      // API returns percent as decimal (0.02 = 2%), convert to percentage
      const percentUsed = planUsage.percent * 100;
      const percentRemaining = Math.max(0, 100 - percentUsed);
      const right = formatXiaomiCreditsUsedLimit(planUsage);

      entries.push({
        name: `${XIAOMI_PROVIDER_LABEL} ${result.plan.planName}`,
        group: XIAOMI_PROVIDER_LABEL,
        label: "Month:",
        right,
        percentRemaining,
        resetTimeIso: result.plan.currentPeriodEnd
          ? new Date(result.plan.currentPeriodEnd).toISOString()
          : undefined,
      });
    }

    if (entries.length === 0) {
      return attemptedErrorResult(XIAOMI_PROVIDER_LABEL, "No usage data available");
    }

    return attemptedResult(entries);
  },
};
