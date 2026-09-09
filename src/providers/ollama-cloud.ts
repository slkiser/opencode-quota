/**
 * Ollama Cloud provider wrapper.
 *
 * Queries the Ollama Cloud usage API and reports session/weekly quota plus
 * provider-reported per-model request counts.
 */

import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import { queryOllamaCloudQuota } from "../lib/ollama-cloud.js";
import { getOllamaCloudKeyDiagnostics, hasOllamaCloudApiKey } from "../lib/ollama-cloud-config.js";
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

function formatRequestCount(requests: number): string {
  return `${requests} ${requests === 1 ? "request" : "requests"}`;
}

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
    });
  }

  for (const model of result.models) {
    entries.push({
      kind: "value",
      accounting: {
        resultType: "usage",
        ...REMOTE_API_ACCOUNTING,
      },
      name: `${OLLAMA_CLOUD_PROVIDER_LABEL} ${model.model}`,
      group: OLLAMA_CLOUD_PROVIDER_LABEL,
      label: `${model.model}:`,
      metricLabel: model.model,
      value: formatRequestCount(model.requests),
    });
  }

  const errors = (result.rowErrors ?? []).map((message) => ({
    label: OLLAMA_CLOUD_PROVIDER_LABEL,
    message,
  }));
  if (entries.length === 0) {
    errors.push({
      label: OLLAMA_CLOUD_PROVIDER_LABEL,
      message: "No usable Ollama Cloud usage data",
    });
  }

  return withStatusDetails(attemptedResult(entries, errors), [
    ...statusDetailsFromRecord({
      session_usage_fraction: result.session?.usageFraction.toString(),
      weekly_usage_fraction: result.weekly?.usageFraction.toString(),
      model_rows: result.models.length.toString(),
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
      credentialDatabasePaths: [],
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
