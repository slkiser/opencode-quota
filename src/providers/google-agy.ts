import type { QuotaProvider, QuotaProviderContext, QuotaProviderResult } from "../lib/entries.js";
import type { RetrieveUserQuotaSummaryGroup } from "../lib/types.js";
import { hasAgyQuotaRuntimeAvailable, queryGoogleAgyQuota } from "../lib/google-agy.js";
import { parseProviderModelRef } from "../lib/provider-model-matching.js";
import {
  formatGoogleAccountErrors,
} from "./google-account-format.js";
import { attemptedErrorResult, attemptedResult, notAttemptedResult } from "./result-helpers.js";

function isAgyModel(model: string): boolean {
  const { providerId } = parseProviderModelRef(model);
  return ["google-agy", "opencode-agy-auth", "google-agy-auth"].includes(providerId);
}

async function isAgyConfigured(ctx: QuotaProviderContext): Promise<boolean> {
  try {
    return await hasAgyQuotaRuntimeAvailable(ctx.client);
  } catch {
    return false;
  }
}

function familyGroupSortOverride(displayName: string): number {
  if (displayName.toLowerCase().includes("gemini")) return 1;
  return 2;
}

function windowToRankOverride(window: string): number {
  return window === "weekly" ? 1 : 2;
}

function windowLabel(window: string): string {
  return window === "weekly" ? "Weekly:" : "5h:";
}

function windowSuffix(window: string): string {
  return window === "weekly" ? "Weekly" : "5h";
}

export const googleAgyProvider: QuotaProvider = {
  id: "google-agy",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    return await isAgyConfigured(ctx);
  },

  matchesCurrentModel(model: string): boolean {
    return isAgyModel(model);
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const result = await queryGoogleAgyQuota(ctx.client, {
      requestTimeoutMs: ctx.config?.requestTimeoutMsConfigured
        ? ctx.config.requestTimeoutMs
        : undefined,
    });

    if (!result) {
      return notAttemptedResult();
    }

    if (!result.success) {
      return attemptedErrorResult("Google AGY", result.error);
    }

    const sortedGroups = [...result.summaryGroups].sort(
      (a, b) => familyGroupSortOverride(a.displayName) - familyGroupSortOverride(b.displayName),
    );

    const entries: import("../lib/entries.js").QuotaToastEntry[] = [];

    for (const group of sortedGroups) {
      const familyName = group.displayName;
      const groupLabel = `Google AGY \u00b7 ${familyName}`;
      const groupSort = familyGroupSortOverride(familyName);

      const sortedBuckets = [...group.buckets]
        .filter((b) => !b.disabled)
        .sort((a, b) => windowToRankOverride(a.window) - windowToRankOverride(b.window));

      for (const bucket of sortedBuckets) {
        const parsedRemaining = bucket.remainingAmount
          ? Number.parseInt(bucket.remainingAmount, 10)
          : Number.NaN;
        const remainingDisplay = bucket.remainingAmount
          ? `${Number.isFinite(parsedRemaining) ? parsedRemaining.toLocaleString("en-US") : bucket.remainingAmount} left`
          : undefined;
        const right = remainingDisplay || undefined;

        entries.push({
          name: `Google AGY ${familyName} ${windowSuffix(bucket.window)}`,
          group: groupLabel,
          label: windowLabel(bucket.window),
          rankOverride: windowToRankOverride(bucket.window),
          groupSortOverride: groupSort,
          ...(right ? { right } : {}),
          percentRemaining: Math.round((bucket.remainingFraction ?? 1) * 100),
          ...(bucket.resetTime ? { resetTimeIso: bucket.resetTime } : {}),
        });
      }
    }

    return attemptedResult(entries, formatGoogleAccountErrors(result.errors, "domainHint"), {
      singleWindowDisplayName: "Google AGY",
      singleWindowShowRight: true,
    });
  },
};
