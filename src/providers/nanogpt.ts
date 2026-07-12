/**
 * NanoGPT provider wrapper.
 */

import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import {
  formatNanoGptBalanceValue,
  hasNanoGptApiKeyConfigured,
  queryNanoGptQuota,
} from "../lib/nanogpt.js";
import { modelProviderMatchesRuntimeId } from "../lib/provider-model-matching.js";
import { attemptedResult, mapNullableProviderResult } from "./result-helpers.js";

function formatUsageAmount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (Number.isInteger(value)) return String(Math.trunc(value));
  return value.toFixed(2).replace(/\.?0+$/, "");
}

function formatUsageRight(window: { used: number; limit: number }): string {
  return `${formatUsageAmount(window.used)}/${formatUsageAmount(window.limit)}`;
}

type NanoGptQuotaSuccess = Extract<
  NonNullable<Awaited<ReturnType<typeof queryNanoGptQuota>>>,
  { success: true }
>;

function mapNanoGptSuccess(result: NanoGptQuotaSuccess): QuotaProviderResult {
  const entries: QuotaToastEntry[] = [];
  const errors =
    result.endpointErrors?.map((entry) => ({
      label: entry.endpoint === "usage" ? "NanoGPT Usage" : "NanoGPT Balance",
      message: entry.message,
    })) ?? [];

  const subscription = result.subscription;
  if (subscription?.daily) {
    entries.push({
      accounting: {
        resultType: "quota",
        acquisitionMethod: "remote_api",
        ownership: "maintained",
        authority: "provider_reported",
      },
      name: "NanoGPT Daily",
      group: "NanoGPT",
      label: "Daily:",
      right: formatUsageRight(subscription.daily),
      percentRemaining: subscription.daily.percentRemaining,
      resetTimeIso: subscription.daily.resetTimeIso,
    });
  }

  if (subscription?.monthly) {
    entries.push({
      accounting: {
        resultType: "quota",
        acquisitionMethod: "remote_api",
        ownership: "maintained",
        authority: "provider_reported",
      },
      name: "NanoGPT Monthly",
      group: "NanoGPT",
      label: "Monthly:",
      right: formatUsageRight(subscription.monthly),
      percentRemaining: subscription.monthly.percentRemaining,
      resetTimeIso: subscription.monthly.resetTimeIso,
    });
  }

  const balanceValue = result.balance ? formatNanoGptBalanceValue(result.balance) : null;
  if (balanceValue) {
    entries.push({
      kind: "value",
      accounting: {
        resultType: "balance",
        acquisitionMethod: "remote_api",
        ownership: "maintained",
        authority: "provider_reported",
      },
      name: "NanoGPT Balance",
      group: "NanoGPT",
      label: "Balance:",
      value: balanceValue,
    });
  }

  if (subscription?.state && subscription.state.toLowerCase() !== "active") {
    errors.push({
      label: "NanoGPT",
      message: `Subscription state: ${subscription.state}`,
    });
  }

  if (entries.length === 0) {
    errors.push({
      label: "NanoGPT",
      message: "No usable NanoGPT quota or balance data",
    });
  }

  return attemptedResult(entries, errors);
}

export const nanoGptProvider: QuotaProvider = {
  id: "nanogpt",

  async isAvailable(_ctx: QuotaProviderContext): Promise<boolean> {
    return await hasNanoGptApiKeyConfigured();
  },

  matchesCurrentModel(model: string): boolean {
    return modelProviderMatchesRuntimeId(model, "nanogpt");
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const result = await queryNanoGptQuota({ requestTimeoutMs: ctx.config?.requestTimeoutMs });

    return mapNullableProviderResult(result, {
      errorLabel: "NanoGPT",
      onSuccess: mapNanoGptSuccess,
    });
  },
};
