import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import { computeQwenQuota, readQwenLocalQuotaState } from "../lib/qwen-local-quota.js";
import {
  DEFAULT_QWEN_AUTH_CACHE_MAX_AGE_MS,
  isQwenCodeModelId,
  resolveQwenLocalPlanCached,
} from "../lib/qwen-auth.js";
import { attemptedResult, notAttemptedResult } from "./result-helpers.js";
import { findQuotaProviderDefinition } from "../lib/quota-providers.js";

export const qwenCodeProvider: QuotaProvider = {
  id: "qwen-code",

  async isAvailable(_ctx: QuotaProviderContext): Promise<boolean> {
    const plan = await resolveQwenLocalPlanCached({
      maxAgeMs: DEFAULT_QWEN_AUTH_CACHE_MAX_AGE_MS,
    });
    return plan.state === "qwen_free";
  },

  matchesCurrentModel(model: string, context): boolean {
    return context?.currentProviderID
      ? context.currentProviderID === "qwen-code"
      : isQwenCodeModelId(model);
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const plan = await resolveQwenLocalPlanCached({
      maxAgeMs: DEFAULT_QWEN_AUTH_CACHE_MAX_AGE_MS,
    });
    if (plan.state !== "qwen_free") {
      return notAttemptedResult();
    }

    const tuning = findQuotaProviderDefinition(ctx.config.quotaProviders ?? [], "qwen-code");
    const daily =
      tuning?.mode === "local-estimate"
        ? tuning.windows.find((window) => window.id === "daily")
        : undefined;
    const rpm =
      tuning?.mode === "local-estimate"
        ? tuning.windows.find((window) => window.id === "rpm")
        : undefined;
    const quota = computeQwenQuota({
      state: await readQwenLocalQuotaState(),
      ...(daily ? { dayLimit: daily.requestLimit } : {}),
      ...(rpm ? { rpmLimit: rpm.requestLimit } : {}),
    });

    return attemptedResult(
      [
        {
          accounting: {
            resultType: "quota",
            acquisitionMethod: "local_estimation",
            ownership: "maintained",
            authority: "locally_derived",
          },
          name: "Qwen Free Daily",
          group: "Qwen (free)",
          label: "Daily:",
          right: `${quota.day.used}/${quota.day.limit}`,
          percentRemaining: quota.day.percentRemaining,
          resetTimeIso: quota.day.resetTimeIso,
        },
        {
          accounting: {
            resultType: "rate_limit",
            acquisitionMethod: "local_estimation",
            ownership: "maintained",
            authority: "locally_derived",
          },
          name: "Qwen Free RPM",
          group: "Qwen (free)",
          label: "RPM:",
          right: `${quota.rpm.used}/${quota.rpm.limit}`,
          percentRemaining: quota.rpm.percentRemaining,
          resetTimeIso: quota.rpm.resetTimeIso,
        },
      ],
      [],
    );
  },
};
