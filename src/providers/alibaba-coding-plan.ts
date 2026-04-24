import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import {
  computeAlibabaCodingPlanQuota,
  readAlibabaCodingPlanQuotaState,
} from "../lib/qwen-local-quota.js";
import {
  DEFAULT_ALIBABA_AUTH_CACHE_MAX_AGE_MS,
  isAlibabaModelId,
  resolveAlibabaCodingPlanAuthCached,
} from "../lib/alibaba-auth.js";
import { attemptedErrorResult, attemptedResult, notAttemptedResult } from "./result-helpers.js";

function tierLabel(tier: "lite" | "pro"): string {
  return tier === "pro" ? "Pro" : "Lite";
}

export const alibabaCodingPlanProvider: QuotaProvider = {
  id: "alibaba-coding-plan",

  async isAvailable(_ctx: QuotaProviderContext): Promise<boolean> {
    const plan = await resolveAlibabaCodingPlanAuthCached({
      maxAgeMs: DEFAULT_ALIBABA_AUTH_CACHE_MAX_AGE_MS,
      fallbackTier: _ctx.config.alibabaCodingPlanTier,
    });
    return plan.state === "configured" || plan.state === "invalid";
  },

  matchesCurrentModel(model: string): boolean {
    return isAlibabaModelId(model);
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const plan = await resolveAlibabaCodingPlanAuthCached({
      maxAgeMs: DEFAULT_ALIBABA_AUTH_CACHE_MAX_AGE_MS,
      fallbackTier: ctx.config.alibabaCodingPlanTier,
    });
    if (plan.state === "none") {
      return notAttemptedResult();
    }

    if (plan.state === "invalid") {
      return attemptedErrorResult("Alibaba Coding Plan", plan.error);
    }

    const quota = computeAlibabaCodingPlanQuota({
      state: await readAlibabaCodingPlanQuotaState(),
      tier: plan.tier,
    });
    const label = `Alibaba Coding Plan (${tierLabel(plan.tier)})`;

    const entries: QuotaToastEntry[] = [
      {
        name: `${label} 5h`,
        group: label,
        label: "5h:",
        right: `${quota.fiveHour.used}/${quota.fiveHour.limit}`,
        percentRemaining: quota.fiveHour.percentRemaining,
        resetTimeIso: quota.fiveHour.resetTimeIso,
      },
      {
        name: `${label} Weekly`,
        group: label,
        label: "Weekly:",
        right: `${quota.weekly.used}/${quota.weekly.limit}`,
        percentRemaining: quota.weekly.percentRemaining,
        resetTimeIso: quota.weekly.resetTimeIso,
      },
      {
        name: `${label} Monthly`,
        group: label,
        label: "Monthly:",
        right: `${quota.monthly.used}/${quota.monthly.limit}`,
        percentRemaining: quota.monthly.percentRemaining,
        resetTimeIso: quota.monthly.resetTimeIso,
      },
    ];

    return attemptedResult(entries);
  },
};
