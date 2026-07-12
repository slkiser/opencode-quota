import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import {
  hasGeminiCliQuotaRuntimeAvailable,
  queryGeminiCliQuota,
} from "../lib/google-gemini-cli.js";
import { parseProviderModelRef } from "../lib/provider-model-matching.js";
import { formatGoogleAccountErrors, formatGoogleAccountLabel } from "./google-account-format.js";
import { attemptedErrorResult, attemptedResult, notAttemptedResult } from "./result-helpers.js";

function isGeminiCliModel(model: string): boolean {
  const { providerId, modelId } = parseProviderModelRef(model);
  if (["google-gemini-cli", "gemini-cli", "gemini", "opencode-gemini-auth"].includes(providerId)) {
    return true;
  }
  return providerId === "google" && modelId.includes("gemini");
}

async function isGeminiCliConfigured(ctx: QuotaProviderContext): Promise<boolean> {
  try {
    return await hasGeminiCliQuotaRuntimeAvailable(ctx.client);
  } catch {
    return false;
  }
}

export const googleGeminiCliProvider: QuotaProvider = {
  id: "google-gemini-cli",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    return await isGeminiCliConfigured(ctx);
  },

  matchesCurrentModel(model: string): boolean {
    return isGeminiCliModel(model);
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const result = await queryGeminiCliQuota(ctx.client, {
      requestTimeoutMs: ctx.config?.requestTimeoutMsConfigured
        ? ctx.config.requestTimeoutMs
        : undefined,
    });

    if (!result) {
      return notAttemptedResult();
    }

    if (!result.success) {
      return attemptedErrorResult("Gemini CLI", result.error);
    }

    const entries: QuotaToastEntry[] = result.buckets.map((bucket) => {
      const emailLabel = formatGoogleAccountLabel(bucket.accountEmail, "domainHint");
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
        group: "Gemini CLI",
        label: `${bucket.displayName}:`,
        ...(right ? { right } : {}),
        percentRemaining: bucket.percentRemaining,
        resetTimeIso: bucket.resetTimeIso,
      };
    });

    return attemptedResult(entries, formatGoogleAccountErrors(result.errors, "domainHint"), {
      singleWindowDisplayName: "Gemini CLI",
      singleWindowShowRight: true,
    });
  },
};
