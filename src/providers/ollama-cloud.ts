/**
 * Ollama Cloud provider wrapper.
 *
 * Queries the Ollama Cloud balance API and reports included credits or
 * session/weekly limits, plus purchased credits.
 */

import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import { getOllamaCloudKeyDiagnostics, hasOllamaCloudApiKey } from "../lib/ollama-cloud-config.js";
import { queryOllamaCloudQuota } from "../lib/ollama-cloud.js";
import { modelProviderMatchesRuntimeId } from "../lib/provider-model-matching.js";
import type { OllamaCloudResult } from "../lib/types.js";
import {
  attemptedResult,
  mapNullableProviderResult,
  simpleApiKeyStatusDetails,
  statusDetailsFromRecord,
  withStatusDetails,
} from "./result-helpers.js";

const OLLAMA_CLOUD_PROVIDER_LABEL = "Ollama Cloud";
const REMOTE_API_ACCOUNTING = {
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
} as const;

type OllamaCloudSuccess = Extract<OllamaCloudResult, { success: true }>;

function mapOllamaCloudSuccess(result: OllamaCloudSuccess): QuotaProviderResult {
  const entries: QuotaToastEntry[] = [];

  if (result.session) {
    entries.push({
      accounting: {
        resultType: "quota",
        ...REMOTE_API_ACCOUNTING,
      },
      name: `${OLLAMA_CLOUD_PROVIDER_LABEL} Session`,
      group: OLLAMA_CLOUD_PROVIDER_LABEL,
      label: "Session:",
      percentRemaining: result.session.percentRemaining,
      ...(result.session.resetTimeIso ? { resetTimeIso: result.session.resetTimeIso } : {}),
    });
  }

  if (result.weekly) {
    entries.push({
      accounting: {
        resultType: "quota",
        ...REMOTE_API_ACCOUNTING,
      },
      name: `${OLLAMA_CLOUD_PROVIDER_LABEL} Weekly`,
      group: OLLAMA_CLOUD_PROVIDER_LABEL,
      label: "Weekly:",
      percentRemaining: result.weekly.percentRemaining,
      ...(result.weekly.resetTimeIso ? { resetTimeIso: result.weekly.resetTimeIso } : {}),
    });
  }

  // Included credits run on the plan's monthly period.
  const included = result.includedCredits;
  if (included?.percentRemaining !== undefined) {
    entries.push({
      accounting: {
        resultType: "quota",
        ...REMOTE_API_ACCOUNTING,
      },
      name: `${OLLAMA_CLOUD_PROVIDER_LABEL} Monthly`,
      group: OLLAMA_CLOUD_PROVIDER_LABEL,
      label: "Monthly:",
      percentRemaining: included.percentRemaining,
      ...(included.resetTimeIso ? { resetTimeIso: included.resetTimeIso } : {}),
    });
  }

  // Purchased credits show when there are some, or when they are the only data.
  if (result.purchasedUsd !== undefined && (result.purchasedUsd > 0 || entries.length === 0)) {
    entries.push({
      kind: "value",
      accounting: {
        resultType: "balance",
        ...REMOTE_API_ACCOUNTING,
      },
      name: `${OLLAMA_CLOUD_PROVIDER_LABEL} Purchased`,
      group: OLLAMA_CLOUD_PROVIDER_LABEL,
      label: "Purchased:",
      value: `$${result.purchasedUsd.toFixed(2)} left`,
    });
  }

  const errors = (result.rowErrors ?? []).map((message) => ({
    label: OLLAMA_CLOUD_PROVIDER_LABEL,
    message,
  }));
  if (entries.length === 0) {
    errors.push({
      label: OLLAMA_CLOUD_PROVIDER_LABEL,
      message: "Ollama Cloud returned no limits or balance",
    });
  }

  return withStatusDetails(attemptedResult(entries, errors), [
    ...statusDetailsFromRecord({
      included_balance_usd: included?.balanceUsd.toString(),
      included_allowance_usd: included?.allowanceUsd.toString(),
      included_period_until: included?.resetTimeIso,
      session_remaining_percent: result.session?.percentRemaining.toString(),
      session_resets_at: result.session?.resetTimeIso,
      weekly_remaining_percent: result.weekly?.percentRemaining.toString(),
      weekly_resets_at: result.weekly?.resetTimeIso,
      purchased_balance_usd: result.purchasedUsd?.toString(),
    }),
    ...(result.rowErrors ?? []).map((message, index) => ({
      key: `live_error_${index + 1}`,
      value: message,
    })),
  ]);
}

export const ollamaCloudProvider: QuotaProvider = {
  id: "ollama-cloud",

  async isAvailable(_ctx: QuotaProviderContext): Promise<boolean> {
    return await hasOllamaCloudApiKey();
  },

  matchesCurrentModel(model: string): boolean {
    return modelProviderMatchesRuntimeId(model, "ollama-cloud");
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const diagnostics = await getOllamaCloudKeyDiagnostics().catch(() => ({
      configured: false,
      source: null,
      checkedPaths: [],
      authPaths: [],
    }));
    const result = await queryOllamaCloudQuota({
      requestTimeoutMs: ctx.config?.requestTimeoutMs,
    });
    const providerResult = mapNullableProviderResult(result, {
      errorLabel: OLLAMA_CLOUD_PROVIDER_LABEL,
      onSuccess: mapOllamaCloudSuccess,
    });

    return withStatusDetails(providerResult, [
      ...simpleApiKeyStatusDetails(diagnostics),
      ...(providerResult.statusDetails ?? []),
    ]);
  },
};
