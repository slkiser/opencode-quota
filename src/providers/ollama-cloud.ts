/**
 * Ollama Cloud provider wrapper.
 *
 * Scrapes the Ollama Cloud settings page and reports session and weekly
 * usage as percentage-based quota entries.
 */

import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import type { OllamaCloudResult } from "../lib/types.js";
import {
  DEFAULT_OLLAMA_CLOUD_CONFIG_CACHE_MAX_AGE_MS,
  resolveOllamaCloudConfigCached,
} from "../lib/ollama-cloud-config.js";
import { queryOllamaCloudQuota } from "../lib/ollama-cloud.js";
import { normalizeQuotaProviderId } from "../lib/provider-metadata.js";
import { attemptedErrorResult, attemptedResult, notAttemptedResult } from "./result-helpers.js";

const OLLAMA_CLOUD_PROVIDER_LABEL = "Ollama Cloud";

function buildOllamaCloudEntries(
  result: Extract<OllamaCloudResult, { success: true }>,
): QuotaToastEntry[] {
  const entries: QuotaToastEntry[] = [];

  if (result.session) {
    entries.push({
      name: `${OLLAMA_CLOUD_PROVIDER_LABEL} Session`,
      group: OLLAMA_CLOUD_PROVIDER_LABEL,
      label: "Session:",
      percentRemaining: result.session.percentRemaining,
      resetTimeIso: result.session.resetTimeIso,
    });
  }

  if (result.weekly) {
    entries.push({
      name: `${OLLAMA_CLOUD_PROVIDER_LABEL} Weekly`,
      group: OLLAMA_CLOUD_PROVIDER_LABEL,
      label: "Weekly:",
      percentRemaining: result.weekly.percentRemaining,
      resetTimeIso: result.weekly.resetTimeIso,
    });
  }

  return entries;
}

export const ollamaCloudProvider: QuotaProvider = {
  id: "ollama-cloud",

  async isAvailable(_ctx: QuotaProviderContext): Promise<boolean> {
    const config = await resolveOllamaCloudConfigCached({
      maxAgeMs: DEFAULT_OLLAMA_CLOUD_CONFIG_CACHE_MAX_AGE_MS,
    });
    return config.state === "configured";
  },

  matchesCurrentModel(model: string): boolean {
    const [provider] = model.toLowerCase().split("/", 2);
    return normalizeQuotaProviderId(provider) === "ollama-cloud";
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const config = await resolveOllamaCloudConfigCached({
      maxAgeMs: DEFAULT_OLLAMA_CLOUD_CONFIG_CACHE_MAX_AGE_MS,
    });

    if (config.state === "none") {
      return notAttemptedResult();
    }

    if (config.state === "incomplete") {
      return attemptedErrorResult(
        OLLAMA_CLOUD_PROVIDER_LABEL,
        `Missing ${config.missing} (source: ${config.source})`,
      );
    }

    if (config.state === "invalid") {
      return attemptedErrorResult(
        OLLAMA_CLOUD_PROVIDER_LABEL,
        `Invalid config (${config.source}): ${config.error}`,
      );
    }

    const result = await queryOllamaCloudQuota(config.config.cookie, {
      requestTimeoutMs: ctx.config?.requestTimeoutMsConfigured
        ? ctx.config.requestTimeoutMs
        : undefined,
    });

    if (!result) {
      return attemptedErrorResult(
        OLLAMA_CLOUD_PROVIDER_LABEL,
        "No response from Ollama Cloud settings page",
      );
    }

    if (!result.success) {
      return attemptedErrorResult(OLLAMA_CLOUD_PROVIDER_LABEL, result.error);
    }

    const entries = buildOllamaCloudEntries(result);

    if (entries.length === 0) {
      return attemptedErrorResult(
        OLLAMA_CLOUD_PROVIDER_LABEL,
        "No usage data found on Ollama Cloud settings page",
      );
    }

    return attemptedResult(entries);
  },
};
