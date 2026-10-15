/**
 * IPC handlers for quota data fetching.
 * Wraps the existing provider registry and quota-state pipeline.
 */

import type { QuotaProviderContext, QuotaToastEntry, QuotaToastError } from "../../lib/entries.js";
import { fetchQuotaProviderResult } from "../../lib/quota-state.js";
import { getProviders } from "../../providers/registry.js";
import type { QuotaToastConfig } from "../../lib/types.js";
import { getQuotaProviderDisplayLabel } from "../../lib/provider-metadata.js";
import { DEFAULT_CONFIG } from "../../lib/types.js";
import { createQuotaProviderRuntimeContext } from "../../lib/quota-runtime-context.js";
import type { LoadConfigMeta } from "../../lib/config.js";
import {
  projectAccountingDetails,
  displayQuotaEntries,
  type AccountingDisplayRow,
} from "../../lib/accounting-display.js";

export interface QuotaFetchResult {
  accountingDetails?: AccountingDisplayRow[];
  entries: QuotaToastEntry[];
  errors: QuotaToastError[];
  detectedProviderIds: string[];
  historyDiagnostics?: string[];
  providerResults?: import("../../dashboard/quota-snapshot-bridge.js").ProviderResultForSnapshot[];
}

function buildMinimalProviderContext(
  config: QuotaToastConfig,
  bypassCache: boolean,
  configMeta?: LoadConfigMeta,
): QuotaProviderContext {
  const context = createQuotaProviderRuntimeContext({
    client: {
      config: {
        providers: async () => ({ data: { providers: [] } }),
        get: async () => ({ data: { model: undefined } }),
      },
    },
    config,
    configMeta,
    session: {},
  });
  context.config.bypassCache = bypassCache;
  return context;
}

/**
 * Fetch quota data from all available providers.
 * Returns normalized entries and errors suitable for direct UI rendering.
 */
export async function fetchAllQuota(
  config: QuotaToastConfig,
  bypassCache = false,
  configMeta?: LoadConfigMeta,
): Promise<QuotaFetchResult> {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const providers = getProviders();
  const ctx = buildMinimalProviderContext(mergedConfig, bypassCache, configMeta);

  const entries: QuotaToastEntry[] = [];
  const errors: QuotaToastError[] = [];
  const detectedProviderIds: string[] = [];
  const providerResults: NonNullable<QuotaFetchResult["providerResults"]> = [];

  // Determine which providers to query
  const enabledList =
    mergedConfig.enabledProviders === "auto"
      ? providers
      : providers.filter((p) => mergedConfig.enabledProviders.includes(p.id));

  // Check availability and fetch in parallel
  const results = await Promise.allSettled(
    enabledList.map(async (provider) => {
      const available = await provider.isAvailable(ctx);
      if (!available) return null;

      const result = await fetchQuotaProviderResult({
        provider,
        ctx,
        ttlMs: bypassCache ? 0 : mergedConfig.minIntervalMs,
        bypassCache,
      });

      return { providerId: provider.id, result };
    }),
  );

  for (const [index, settled] of results.entries()) {
    if (settled.status === "rejected") {
      errors.push({
        label: getQuotaProviderDisplayLabel(enabledList[index]!.id),
        message: "Quota query failed",
      });
      continue;
    }
    const item = settled.value;
    if (!item) continue;

    detectedProviderIds.push(item.providerId);
    providerResults.push({ providerId: item.providerId, result: item.result });

    entries.push(...displayQuotaEntries(item.result));
    if (item.result.errors.length > 0) {
      errors.push(...item.result.errors);
    }
  }

  const details = providerResults.flatMap((item) =>
    projectAccountingDetails(item.providerId, item.result),
  );
  return {
    entries,
    errors,
    detectedProviderIds,
    providerResults,
    ...(details.length ? { accountingDetails: details } : {}),
  };
}
