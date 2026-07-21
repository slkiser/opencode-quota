/**
 * Synthetic provider wrapper.
 */

import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { hasSyntheticApiKeyConfigured, querySyntheticQuota } from "../lib/synthetic.js";
import type { SyntheticQuotaWindow } from "../lib/types.js";
import { modelProviderIncludesAny } from "../lib/provider-model-matching.js";
import { attemptedResult, mapNullableProviderResult } from "./result-helpers.js";

function formatSyntheticRoundedValue(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return String(Math.max(0, Math.round(value)));
}

function formatSyntheticSummary(window: SyntheticQuotaWindow, currency = false): string {
  const used = formatSyntheticRoundedValue(window.used);
  const limit = formatSyntheticRoundedValue(window.limit);
  return currency ? `$${used}/$${limit}` : `${used}/${limit}`;
}

function toSyntheticEntry(params: {
  window: SyntheticQuotaWindow;
  suffix: "5h" | "Weekly";
  label: "5h:" | "Weekly:";
  currency?: boolean;
}): QuotaToastEntry {
  const right = formatSyntheticSummary(params.window, params.currency);

  return {
    accounting: {
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
    name: `Synthetic ${params.suffix}`,
    group: "Synthetic",
    label: params.label,
    percentRemaining: params.window.percentRemaining,
    right,
    resetTimeIso: params.window.resetTimeIso,
  };
}

export const syntheticProvider: QuotaProvider = {
  id: "synthetic",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const providerAvailable = await isCanonicalProviderAvailable({
      ctx,
      providerId: "synthetic",
      fallbackOnError: false,
    });
    if (providerAvailable) return true;

    return await hasSyntheticApiKeyConfigured();
  },

  matchesCurrentModel(model: string): boolean {
    return modelProviderIncludesAny(model, ["synthetic"]);
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const result = await querySyntheticQuota({ requestTimeoutMs: ctx.config?.requestTimeoutMs });

    return mapNullableProviderResult(result, {
      errorLabel: "Synthetic",
      onSuccess: (result) =>
        attemptedResult(
          [
            toSyntheticEntry({
              window: result.windows.fiveHour,
              suffix: "5h",
              label: "5h:",
            }),
            toSyntheticEntry({
              window: result.windows.weekly,
              suffix: "Weekly",
              label: "Weekly:",
              currency: true,
            }),
          ],
          [],
          {
            singleWindowShowRight: true,
          },
        ),
    });
  },
};
