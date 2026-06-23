import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import {
  resolveOpenCodeZenConfigCached,
  DEFAULT_OPENCODE_ZEN_CONFIG_CACHE_MAX_AGE_MS,
} from "../lib/opencode-zen-config.js";
import { queryOpenCodeZenQuota } from "../lib/opencode-zen.js";
import { normalizeQuotaProviderId } from "../lib/provider-metadata.js";
import { attemptedResult, notAttemptedResult } from "./result-helpers.js";

const OPENCODE_PROVIDER_LABEL = "OpenCode";

export const opencodeProvider: QuotaProvider = {
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

    if (config.state === "none") {
      return notAttemptedResult();
    }

    if (config.state === "incomplete") {
      return attemptedResult([], [
        {
          label: OPENCODE_PROVIDER_LABEL,
          message: `Missing ${config.missing} (source: ${config.source})`,
        },
      ]);
    }

    if (config.state === "invalid") {
      return attemptedResult([], [
        {
          label: OPENCODE_PROVIDER_LABEL,
          message: `Invalid config (${config.source}): ${config.error}`,
        },
      ]);
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
      return attemptedResult([], [
        {
          label: OPENCODE_PROVIDER_LABEL,
          message: result.error,
        },
      ]);
    }

    const { balance, monthlyLimit, monthlyUsage, lastPayment } = result.data;

    // Convert micro-cents to dollars
    const MICRO_CENTS_PER_DOLLAR = 100_000_000;
    const balanceUsd = balance / MICRO_CENTS_PER_DOLLAR;

    // Determine effective monthly limit:
    // 1. Plugin config opencodeMonthlyLimit (highest priority)
    // 2. Billing page monthlyLimit
    // 3. Last payment amount (fallback)
    // 4. No limit → value-only display
    const pluginMonthlyLimit = ctx.config?.opencodeMonthlyLimit;
    const effectiveMonthlyLimit =
      pluginMonthlyLimit !== undefined
        ? pluginMonthlyLimit
        : monthlyLimit !== null
          ? monthlyLimit
          : lastPayment;

    const entries: QuotaToastEntry[] = [];

    if (effectiveMonthlyLimit !== null && effectiveMonthlyLimit !== undefined) {
      const limitUsd = effectiveMonthlyLimit;
      // Percent = how much of the monthly limit is covered by current balance.
      // If balance ≥ limit, the bar shows 100%.
      const percentRemaining = Math.min(100, Math.max(0, (balanceUsd / limitUsd) * 100));

      entries.push({
        kind: "percent",
        name: "",
        group: "OpenCode Zen",
        percentRemaining,
        // No resetTimeIso — OpenCode Zen is prepaid balance, not a usage
        // allowance that resets on a schedule.
      });
    } else {
      entries.push({
        kind: "value",
        name: "",
        group: "OpenCode Zen",
        value: `$${balanceUsd.toFixed(2)}`,
      });
    }

    return attemptedResult(entries);
  },
};
