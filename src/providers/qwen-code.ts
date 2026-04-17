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

export const qwenCodeProvider: QuotaProvider = {
  id: "qwen-code",

  async isAvailable(_ctx: QuotaProviderContext): Promise<boolean> {
    const plan = await resolveQwenLocalPlanCached({
      maxAgeMs: DEFAULT_QWEN_AUTH_CACHE_MAX_AGE_MS,
    });
    return plan.state === "qwen_free";
  },

  matchesCurrentModel(model: string): boolean {
    return isQwenCodeModelId(model);
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const plan = await resolveQwenLocalPlanCached({
      maxAgeMs: DEFAULT_QWEN_AUTH_CACHE_MAX_AGE_MS,
    });
    if (plan.state !== "qwen_free") {
      return notAttemptedResult();
    }

    const quota = computeQwenQuota({ state: await readQwenLocalQuotaState() });
    const style = ctx.config.formatStyle ?? "classic";

    if (style === "grouped") {
      const entries: QuotaToastEntry[] = [
        {
          name: "Qwen Free Daily",
          group: "Qwen (free)",
          label: "Daily:",
          right: `${quota.day.used}/${quota.day.limit}`,
          percentRemaining: quota.day.percentRemaining,
          resetTimeIso: quota.day.resetTimeIso,
        },
        {
          name: "Qwen Free RPM",
          group: "Qwen (free)",
          label: "RPM:",
          right: `${quota.rpm.used}/${quota.rpm.limit}`,
          percentRemaining: quota.rpm.percentRemaining,
          resetTimeIso: quota.rpm.resetTimeIso,
        },
      ];

      return attemptedResult(entries);
    }

    return attemptedResult([
      {
        name: "Qwen Free Daily",
        percentRemaining: quota.day.percentRemaining,
        resetTimeIso: quota.day.resetTimeIso,
      },
      {
        name: "Qwen Free RPM",
        percentRemaining: quota.rpm.percentRemaining,
        resetTimeIso: quota.rpm.resetTimeIso,
      },
    ]);
  },
};
