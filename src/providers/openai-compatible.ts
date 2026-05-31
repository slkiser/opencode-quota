/**
 * Generic OpenAI-compatible gateway provider.
 *
 * Unlike the vendor providers, this one is config-driven: it reads
 * `experimental.quotaToast.openaiCompatibleGateways` and polls each gateway's
 * quota endpoint (see src/lib/openai-compatible.ts). One provider covers any
 * number of self-hosted / OpenAI-compatible gateways. Bound to no product.
 */

import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
  QuotaToastError,
} from "../lib/entries.js";
import type { OpenAiCompatibleGateway } from "../lib/types.js";
import {
  hasGatewayApiKey,
  resolveGatewayApiKey,
  resolveGatewayBaseURL,
} from "../lib/openai-compatible-config.js";
import {
  queryGatewayQuota,
  type GatewayQuotaResult,
} from "../lib/openai-compatible.js";
import { clampPercent, fmtUsdAmount, formatTokenCount } from "../lib/format-utils.js";
import { attemptedResult, notAttemptedResult } from "./result-helpers.js";

// `matchesCurrentModel` can't see ctx.config, so cache the configured gateway
// provider ids at availability/fetch time. onlyCurrentModel (default off) then
// matches `<providerId>/...` models against them.
let knownGatewayProviderIds: string[] = [];

function rememberGateways(gateways: OpenAiCompatibleGateway[]): void {
  knownGatewayProviderIds = gateways.map((gateway) => gateway.providerId);
}

function getGateways(ctx: QuotaProviderContext): OpenAiCompatibleGateway[] {
  return ctx.config?.openaiCompatibleGateways ?? [];
}

function tokenCount(value: number | null): string {
  return value === null ? "?" : formatTokenCount(value);
}

type GatewaySuccess = Extract<NonNullable<GatewayQuotaResult>, { success: true }>;

function buildGatewayEntries(label: string, result: GatewaySuccess): QuotaToastEntry[] {
  const entries: QuotaToastEntry[] = [];

  const tokens = result.tokens;
  if (tokens && tokens.limit !== null && tokens.limit > 0 && tokens.remaining !== null) {
    entries.push({
      name: `${label} tokens`,
      group: label,
      label: "Tokens:",
      percentRemaining: clampPercent((tokens.remaining / tokens.limit) * 100),
      right: `${tokenCount(tokens.used)}/${tokenCount(tokens.limit)}`,
      resetTimeIso: tokens.resetTimeIso,
    });
  }

  const cost = result.cost;
  if (cost && (cost.limit !== null || cost.used !== null)) {
    const used = cost.used ?? 0;
    const value =
      cost.limit !== null ? `${fmtUsdAmount(used)} / ${fmtUsdAmount(cost.limit)}` : fmtUsdAmount(used);
    entries.push({
      kind: "value",
      name: `${label} cost`,
      group: label,
      label: "Budget:",
      value,
    });
  }

  if (entries.length === 0) {
    entries.push({ kind: "value", name: label, group: label, label: "Status:", value: "no quota data" });
  }

  return entries;
}

export const openaiCompatibleProvider: QuotaProvider = {
  id: "openai-compatible",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const gateways = getGateways(ctx);
    rememberGateways(gateways);
    for (const gateway of gateways) {
      if (await hasGatewayApiKey(gateway.providerId)) return true;
    }
    return false;
  },

  matchesCurrentModel(model: string): boolean {
    const prefix = model.split("/")[0];
    return prefix.length > 0 && knownGatewayProviderIds.includes(prefix);
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const gateways = getGateways(ctx);
    rememberGateways(gateways);
    if (gateways.length === 0) {
      return notAttemptedResult();
    }

    const entries: QuotaToastEntry[] = [];
    const errors: QuotaToastError[] = [];
    let attempted = false;

    for (const gateway of gateways) {
      const apiKey = await resolveGatewayApiKey(gateway.providerId);
      if (!apiKey) {
        // Not configured for this gateway; skip without marking attempted.
        continue;
      }

      const label = gateway.label ?? gateway.providerId;
      const baseURL = await resolveGatewayBaseURL(gateway.providerId, gateway.baseURL);
      attempted = true;

      if (!baseURL) {
        errors.push({
          label,
          message: `no base URL (set provider.${gateway.providerId}.options.baseURL or gateway.baseURL)`,
        });
        continue;
      }

      const result = await queryGatewayQuota({
        baseURL,
        apiKey: apiKey.key,
        quotaPath: gateway.quotaPath,
        mapping: gateway.mapping,
        fallbackLabel: label,
        requestTimeoutMs: ctx.config?.requestTimeoutMs,
      });

      if (!result) continue;
      if (!result.success) {
        errors.push({ label, message: result.error });
        continue;
      }

      entries.push(...buildGatewayEntries(label, result));
    }

    if (!attempted) {
      return notAttemptedResult();
    }

    return attemptedResult(entries, errors);
  },
};
