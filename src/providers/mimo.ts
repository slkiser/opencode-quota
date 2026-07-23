import type {
  AccountingMetadata,
  QuotaProvider,
  QuotaProviderContext,
  QuotaToastEntry,
  QuotaToastError,
} from "../lib/entries.js";
import {
  DEFAULT_MIMO_CONFIG_CACHE_MAX_AGE_MS,
  resolveMimoConfigCached,
} from "../lib/mimo-config.js";
import type {
  MimoBalance,
  MimoDashboardResult,
  MimoEndpointResult,
  MimoPlanDetail,
} from "../lib/mimo.js";
import { queryMimoDashboard } from "../lib/mimo.js";
import { sanitizeSingleLineDisplaySnippet } from "../lib/display-sanitize.js";
import { getQuotaProviderRuntimeIds } from "../lib/provider-metadata.js";
import { attemptedErrorResult, attemptedResult, notAttemptedResult } from "./result-helpers.js";

const MIMO_LABEL = "Xiaomi MiMo";
const MIMO_RUNTIME_IDS = new Set(getQuotaProviderRuntimeIds("xiaomi"));

const QUOTA_ACCOUNTING: AccountingMetadata = {
  resultType: "quota",
  acquisitionMethod: "dashboard_scrape",
  ownership: "maintained",
  authority: "provider_reported",
};
const BALANCE_ACCOUNTING: AccountingMetadata = {
  resultType: "balance",
  acquisitionMethod: "dashboard_scrape",
  ownership: "maintained",
  authority: "provider_reported",
};

function getPlanDisplay(detail: MimoEndpointResult<MimoPlanDetail>): string | null {
  if (detail.state !== "success" || detail.data.expired) return null;

  const planName = detail.data.planName
    ? sanitizeSingleLineDisplaySnippet(detail.data.planName, 40)
    : "";
  const planCode = detail.data.planCode
    ? sanitizeSingleLineDisplaySnippet(detail.data.planCode, 32)
    : "";

  if (planName && planCode && planName.toLowerCase() !== planCode.toLowerCase()) {
    return `${planName} [${planCode}]`;
  }
  return planName || planCode || null;
}

function getGroup(detail: MimoEndpointResult<MimoPlanDetail>): string {
  const plan = getPlanDisplay(detail);
  return plan ? `${MIMO_LABEL} · ${plan}` : MIMO_LABEL;
}

function formatBalanceAmount(amount: number, currency: string | null): string {
  const value = amount.toFixed(2);
  if (currency === "USD") return `$${value}`;
  return currency ? `${currency} ${value}` : value;
}

function buildBalanceEntries(balance: MimoBalance, group: string): QuotaToastEntry[] {
  const entries: QuotaToastEntry[] = [];
  const rows = [
    { label: "Total:", suffix: "Total Balance", amount: balance.total },
    { label: "Cash:", suffix: "Cash Balance", amount: balance.cash },
    { label: "Gift:", suffix: "Gift Balance", amount: balance.gift },
  ];

  for (const row of rows) {
    if (row.amount === null) continue;
    entries.push({
      accounting: BALANCE_ACCOUNTING,
      kind: "value",
      name: `${MIMO_LABEL} ${row.suffix}`,
      group,
      label: row.label,
      value: formatBalanceAmount(row.amount, balance.currency),
    });
  }

  return entries;
}

function endpointErrors(result: MimoDashboardResult): QuotaToastError[] {
  const errors: QuotaToastError[] = [];
  for (const endpoint of [result.usage, result.detail, result.balance]) {
    if (endpoint.state === "error") {
      errors.push({ label: MIMO_LABEL, message: endpoint.error });
    }
  }
  return errors;
}

export const xiaomiProvider: QuotaProvider = {
  id: "xiaomi",

  async isAvailable(_ctx: QuotaProviderContext): Promise<boolean> {
    const config = await resolveMimoConfigCached({
      maxAgeMs: DEFAULT_MIMO_CONFIG_CACHE_MAX_AGE_MS,
    });
    return config.state === "configured";
  },

  matchesCurrentModel(model: string): boolean {
    const [provider] = model.trim().toLowerCase().split("/", 2);
    return MIMO_RUNTIME_IDS.has(provider);
  },

  async fetch(ctx: QuotaProviderContext) {
    const config = await resolveMimoConfigCached({
      maxAgeMs: DEFAULT_MIMO_CONFIG_CACHE_MAX_AGE_MS,
    });

    if (config.state === "none") return notAttemptedResult();
    if (config.state === "invalid") {
      return attemptedErrorResult(MIMO_LABEL, `Invalid config (${config.source}): ${config.error}`);
    }

    const result = await queryMimoDashboard(config.config.cookie, {
      requestTimeoutMs: ctx.config?.requestTimeoutMsConfigured
        ? ctx.config.requestTimeoutMs
        : undefined,
    });
    const group = getGroup(result.detail);
    const entries: QuotaToastEntry[] = [];

    if (
      result.usage.state === "success" &&
      !(result.detail.state === "success" && result.detail.data.expired)
    ) {
      const { used, limit } = result.usage.data;
      entries.push({
        accounting: QUOTA_ACCOUNTING,
        name: `${group} Monthly`,
        group,
        label: "Monthly:",
        right: `${used}/${limit}`,
        percentRemaining: 100 - (used / limit) * 100,
      });
    }

    if (result.balance.state === "success") {
      entries.push(...buildBalanceEntries(result.balance.data, group));
    }

    return attemptedResult(entries, endpointErrors(result));
  },
};
