/**
 * Anthropic Enterprise provider wrapper.
 *
 * Reports monthly usage-based spend limits for Enterprise organizations and
 * per-user/group allocations as percentage-based quota entries.
 */

import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import {
  resolveAnthropicEnterpriseConfigCached,
  DEFAULT_ANTHROPIC_ENTERPRISE_CONFIG_CACHE_MAX_AGE_MS,
} from "../lib/anthropic-enterprise-config.js";
import { queryAnthropicEnterpriseQuota } from "../lib/anthropic-enterprise.js";
import { attemptedErrorResult, attemptedResult, notAttemptedResult } from "./result-helpers.js";

const PROVIDER_LABEL = "Claude Enterprise";

function formatCurrency(amount: number, currency: string): string {
  if (currency === "USD") {
    return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  }
  return `${amount} ${currency}`;
}

export const anthropicEnterpriseProvider: QuotaProvider = {
  id: "anthropic-enterprise",

  async isAvailable(_ctx: QuotaProviderContext): Promise<boolean> {
    const config = await resolveAnthropicEnterpriseConfigCached({
      maxAgeMs: DEFAULT_ANTHROPIC_ENTERPRISE_CONFIG_CACHE_MAX_AGE_MS,
    });
    return config.state === "configured";
  },

  matchesCurrentModel(model: string): boolean {
    const normalized = model.toLowerCase();
    return normalized.startsWith("anthropic/") || normalized.includes("claude");
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const config = await resolveAnthropicEnterpriseConfigCached({
      maxAgeMs: DEFAULT_ANTHROPIC_ENTERPRISE_CONFIG_CACHE_MAX_AGE_MS,
    });

    if (config.state === "none") {
      return notAttemptedResult();
    }

    if (config.state === "incomplete") {
      return attemptedErrorResult(
        PROVIDER_LABEL,
        `Missing ${config.missing} (source: ${config.source})`,
      );
    }

    if (config.state === "invalid") {
      return attemptedErrorResult(
        PROVIDER_LABEL,
        `Invalid config (${config.source}): ${config.error}`,
      );
    }

    const result = await queryAnthropicEnterpriseQuota({
      orgId: config.config.orgId,
      sessionKey: config.config.sessionKey,
      accountId: config.config.accountId,
      requestTimeoutMs: ctx.config?.requestTimeoutMs,
    });

    if (!result.success) {
      return attemptedErrorResult(PROVIDER_LABEL, result.error);
    }

    const entries: QuotaToastEntry[] = [];

    // Org-level monthly usage
    if (result.orgUsage && result.orgUsage.isEnabled) {
      const remaining = Math.max(0, Math.round(100 - result.orgUsage.utilization));
      entries.push({
        name: `${PROVIDER_LABEL} Org Monthly`,
        group: PROVIDER_LABEL,
        label: "Org:",
        percentRemaining: remaining,
        right: `${formatCurrency(result.orgUsage.usedCreditsUsd, result.orgUsage.currency)}/${formatCurrency(result.orgUsage.monthlyLimitUsd, result.orgUsage.currency)}`,
      });
    }

    // User/group-level monthly limit
    if (result.userLimit && result.userLimit.isEnabled) {
      const limit = result.userLimit.monthlyLimitUsd;
      const used = result.userLimit.usedCreditsUsd;
      const percentUsed = limit > 0 ? (used / limit) * 100 : 100;
      const remaining = Math.max(0, Math.round(100 - percentUsed));

      entries.push({
        name: `${PROVIDER_LABEL} User Monthly`,
        group: PROVIDER_LABEL,
        label: "User:",
        percentRemaining: remaining,
        right: `${formatCurrency(used, result.userLimit.currency)}/${formatCurrency(limit, result.userLimit.currency)}`,
      });
    }

    if (entries.length === 0) {
      return attemptedErrorResult(
        PROVIDER_LABEL,
        "Enterprise usage data not available or not enabled",
      );
    }

    return attemptedResult(entries);
  },
};
