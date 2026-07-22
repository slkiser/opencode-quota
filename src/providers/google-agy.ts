import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import type { GoogleAgyQuotaBucket } from "../lib/types.js";
import { hasAgyQuotaRuntimeAvailable, queryGoogleAgyQuota } from "../lib/google-agy.js";
import { parseProviderModelRef } from "../lib/provider-model-matching.js";
import { formatGoogleAccountErrors, formatGoogleAccountLabel } from "./google-account-format.js";
import { attemptedErrorResult, attemptedResult, notAttemptedResult } from "./result-helpers.js";

function isAgyModel(model: string): boolean {
  const { providerId } = parseProviderModelRef(model);
  return ["google-agy", "opencode-agy-auth", "google-agy-auth"].includes(providerId);
}

function formatAgyAccountLabel(bucket: { accountEmail?: string; accountKey?: string }): string {
  if (bucket.accountEmail) {
    return formatGoogleAccountLabel(bucket.accountEmail, "domainHint");
  }
  return bucket.accountKey ? `Account ${bucket.accountKey.slice(0, 8)}` : "Unknown";
}

function familyRank(family: string): number {
  if (family === "Gemini Models") return 0;
  if (family === "Claude and GPT models") return 1;
  return 2;
}

function windowRank(window: GoogleAgyQuotaBucket["window"]): number {
  return window === "weekly" ? 0 : 1;
}

function compareBuckets(left: GoogleAgyQuotaBucket, right: GoogleAgyQuotaBucket): number {
  if (left.accountIndex !== right.accountIndex) {
    return left.accountIndex - right.accountIndex;
  }

  const rankedFamily = familyRank(left.family) - familyRank(right.family);
  if (rankedFamily !== 0) {
    return rankedFamily;
  }

  const familyName = left.family.localeCompare(right.family);
  if (familyName !== 0) {
    return familyName;
  }

  const rankedWindow = windowRank(left.window) - windowRank(right.window);
  if (rankedWindow !== 0) {
    return rankedWindow;
  }

  const bucketLabel = (left.bucketLabel ?? "").localeCompare(right.bucketLabel ?? "");
  if (bucketLabel !== 0) {
    return bucketLabel;
  }
  return (left.bucketId ?? "").localeCompare(right.bucketId ?? "");
}

function formatRemainingAmount(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return `${Number.isFinite(parsed) ? parsed.toLocaleString("en-US") : value} left`;
}

async function isAgyConfigured(ctx: QuotaProviderContext): Promise<boolean> {
  try {
    return await hasAgyQuotaRuntimeAvailable(ctx.client);
  } catch {
    return false;
  }
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

    const sortedBuckets = [...result.buckets].sort(compareBuckets);
    const entries: QuotaToastEntry[] = sortedBuckets.map((bucket) => {
      const accountLabel = formatAgyAccountLabel(bucket);
      const windowName = `${bucket.family} ${bucket.windowLabel}`;
      const right = formatRemainingAmount(bucket.remainingAmount);

      return {
        accounting: {
          resultType: "quota",
          acquisitionMethod: "remote_api",
          ownership: "maintained",
          authority: "provider_reported",
        },
        name: `${windowName} (${accountLabel})`,
        group: "Google AGY",
        label: `${windowName}:`,
        ...(right ? { right } : {}),
        percentRemaining: bucket.percentRemaining,
        resetTimeIso: bucket.resetTimeIso,
      };
    });

    return attemptedResult(entries, formatGoogleAccountErrors(result.errors, "domainHint"), {
      singleWindowDisplayName: "Google AGY",
      singleWindowShowRight: true,
    });
  },
};
