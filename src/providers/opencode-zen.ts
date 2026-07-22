import type {
  AccountingMetadata,
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import {
  DEFAULT_OPENCODE_ZEN_CONFIG_CACHE_MAX_AGE_MS,
  resolveOpenCodeZenConfigCached,
} from "../lib/opencode-zen-config.js";
import {
  OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR,
  queryOpenCodeZenQuota,
} from "../lib/opencode-zen.js";
import { normalizeQuotaProviderId } from "../lib/provider-metadata.js";
import { attemptedErrorResult, attemptedResult, notAttemptedResult } from "./result-helpers.js";

const OPENCODE_PROVIDER_LABEL = "OpenCode";
const OPENCODE_ZEN_GROUP = "OpenCode Zen";
const OPENCODE_ZEN_BALANCE_ACCOUNTING: AccountingMetadata = {
  resultType: "balance",
  acquisitionMethod: "dashboard_scrape",
  ownership: "maintained",
  authority: "provider_reported",
};
const OPENCODE_ZEN_BUDGET_ACCOUNTING: AccountingMetadata = {
  resultType: "budget",
  acquisitionMethod: "dashboard_scrape",
  ownership: "maintained",
  authority: "provider_reported",
};

export const opencodeZenProvider: QuotaProvider = {
  id: "opencode",

  async isAvailable(_ctx: QuotaProviderContext): Promise<boolean> {
    const config = await resolveOpenCodeZenConfigCached({
      maxAgeMs: DEFAULT_OPENCODE_ZEN_CONFIG_CACHE_MAX_AGE_MS,
    });
    return config.state === "configured";
  },

  matchesCurrentModel(model: string): boolean {
    const [provider] = model.toLowerCase().split("/", 2);
    return normalizeQuotaProviderId(provider) === "opencode";
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const config = await resolveOpenCodeZenConfigCached({
      maxAgeMs: DEFAULT_OPENCODE_ZEN_CONFIG_CACHE_MAX_AGE_MS,
    });

    if (config.state === "none") return notAttemptedResult();

    if (config.state === "incomplete") {
      return attemptedErrorResult(
        OPENCODE_PROVIDER_LABEL,
        `Missing ${config.missing} (source: ${config.source})`,
      );
    }

    if (config.state === "invalid") {
      return attemptedErrorResult(
        OPENCODE_PROVIDER_LABEL,
        `Invalid config (${config.source}): ${config.error}`,
      );
    }

    const result = await queryOpenCodeZenQuota(
      config.config.workspaceId,
      config.config.authCookie,
      {
        requestTimeoutMs: ctx.config?.requestTimeoutMsConfigured
          ? ctx.config.requestTimeoutMs
          : undefined,
      },
    );

    if (!result.success) {
      return attemptedErrorResult(OPENCODE_PROVIDER_LABEL, result.error);
    }

    const balanceUsd = result.data.balance / OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR;
    const configuredMonthlyLimit = ctx.config?.opencodeMonthlyLimit;
    const effectiveMonthlyLimit =
      configuredMonthlyLimit !== undefined
        ? configuredMonthlyLimit
        : result.data.monthlyLimit !== null
          ? result.data.monthlyLimit
          : result.data.lastPayment;

    const entry: QuotaToastEntry =
      effectiveMonthlyLimit !== null &&
      effectiveMonthlyLimit !== undefined &&
      Number.isFinite(effectiveMonthlyLimit) &&
      effectiveMonthlyLimit > 0
        ? {
            accounting: OPENCODE_ZEN_BUDGET_ACCOUNTING,
            name: "",
            group: OPENCODE_ZEN_GROUP,
            percentRemaining: Math.min(
              100,
              Math.max(0, (balanceUsd / effectiveMonthlyLimit) * 100),
            ),
          }
        : {
            accounting: OPENCODE_ZEN_BALANCE_ACCOUNTING,
            kind: "value",
            name: "",
            group: OPENCODE_ZEN_GROUP,
            value: `$${balanceUsd.toFixed(2)}`,
          };

    return attemptedResult([entry]);
  },
};
