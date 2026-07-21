import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
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

    const groupedBuckets = new Map<string, (typeof result.buckets)[0]>();

    for (const bucket of result.buckets) {
      let groupName: string | undefined;
      const name = bucket.displayName;

      if (name.includes("Gemini")) {
        groupName = "Gemini Models";
      } else if (name.includes("Claude") || name.includes("GPT")) {
        groupName = "Claude and GPT models";
      }

      if (!groupName) continue;

      const accountKey = bucket.accountKey || bucket.accountEmail || "";
      const key = `${accountKey}::${groupName}`;
      const existing = groupedBuckets.get(key);

      if (!existing || bucket.percentRemaining < existing.percentRemaining) {
        groupedBuckets.set(key, { ...bucket, displayName: groupName });
      }
    }

    const finalBuckets = Array.from(groupedBuckets.values()).sort((a, b) =>
      a.displayName.localeCompare(b.displayName),
    );

    const entries: QuotaToastEntry[] = finalBuckets.map((bucket) => {
      const emailLabel = formatAgyAccountLabel(bucket);
      const parsedRemaining = bucket.remainingAmount
        ? Number.parseInt(bucket.remainingAmount, 10)
        : Number.NaN;
      const remainingAmount = bucket.remainingAmount
        ? `${Number.isFinite(parsedRemaining) ? parsedRemaining.toLocaleString("en-US") : bucket.remainingAmount} left`
        : undefined;
      const tokenType = bucket.tokenType?.trim().toUpperCase();
      const right = [remainingAmount, tokenType && tokenType !== "REQUESTS" ? tokenType : undefined]
        .filter(Boolean)
        .join(" ");

      return {
        accounting: {
          resultType: "quota",
          acquisitionMethod: "remote_api",
          ownership: "maintained",
          authority: "provider_reported",
        },
        name: `${bucket.displayName} (${emailLabel})`,
        group: "Google AGY",
        label: `${bucket.displayName}:`,
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
