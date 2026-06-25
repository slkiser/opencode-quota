/**
 * Neuralwatt provider wrapper.
 *
 * Normalizes Neuralwatt account quota into generic toast entries. When a
 * subscription with a kWh allowance is active, shows the remaining kWh
 * percentage (reset = billing period end); always shows the USD credit
 * balance as a value entry. Falls back to credits-only when no subscription.
 */

import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import { hasNeuralwattApiKey } from "../lib/neuralwatt-config.js";
import {
  formatNeuralwattBalanceValue,
  formatNeuralwattKwhRight,
  queryNeuralwattQuota,
} from "../lib/neuralwatt.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { modelProviderIncludesAny } from "../lib/provider-model-matching.js";
import { attemptedErrorResult, attemptedResult, notAttemptedResult } from "./result-helpers.js";

type NeuralwattQuotaSuccess = Extract<
  NonNullable<Awaited<ReturnType<typeof queryNeuralwattQuota>>>,
  { success: true }
>;

function mapNeuralwattSuccess(result: NeuralwattQuotaSuccess): QuotaProviderResult {
  const entries: QuotaToastEntry[] = [];
  const errors: { label: string; message: string }[] = [];

  const subscription = result.subscription;
  if (subscription?.kwh) {
    entries.push({
      name: "Neuralwatt Subscription",
      group: "Neuralwatt",
      label: "Plan:",
      right: formatNeuralwattKwhRight(subscription.kwh),
      percentRemaining: subscription.kwh.percentRemaining,
      resetTimeIso: subscription.kwh.resetTimeIso,
    });
  }

  if (result.keyAllowance) {
    entries.push({
      name: "Neuralwatt Key",
      group: "Neuralwatt",
      label: "Key:",
      right: `$${result.keyAllowance.spentUsd.toFixed(2)}/$${result.keyAllowance.limitUsd.toFixed(
        2,
      )}`,
      percentRemaining: result.keyAllowance.window.percentRemaining,
    });
  }

  const balanceValue = result.balance ? formatNeuralwattBalanceValue(result.balance) : null;
  if (balanceValue) {
    entries.push({
      kind: "value",
      name: "Neuralwatt Credits",
      group: "Neuralwatt",
      label: "Credits:",
      value: balanceValue,
    });
  }

  if (subscription?.state && subscription.state.toLowerCase() !== "active") {
    errors.push({
      label: "Neuralwatt",
      message: `Subscription state: ${subscription.state}`,
    });
  }

  if (result.keyAllowance?.blocked) {
    errors.push({
      label: "Neuralwatt",
      message: "API key is blocked (spending allowance reached)",
    });
  }

  if (entries.length === 0) {
    errors.push({
      label: "Neuralwatt",
      message: "No usable Neuralwatt quota or balance data",
    });
  }

  return attemptedResult(entries, errors);
}

export const neuralwattProvider: QuotaProvider = {
  id: "neuralwatt",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const providerAvailable = await isCanonicalProviderAvailable({
      ctx,
      providerId: "neuralwatt",
      fallbackOnError: false,
    });
    if (providerAvailable) return true;

    return await hasNeuralwattApiKey();
  },

  matchesCurrentModel(model: string): boolean {
    return modelProviderIncludesAny(model, ["neuralwatt"]);
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const result = await queryNeuralwattQuota({ requestTimeoutMs: ctx.config?.requestTimeoutMs });

    if (!result) return notAttemptedResult();

    if (!result.success) {
      return attemptedErrorResult("Neuralwatt", result.error);
    }

    return mapNeuralwattSuccess(result);
  },
};
