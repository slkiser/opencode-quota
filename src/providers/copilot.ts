/**
 * Copilot provider wrapper.
 *
 * Normalizes GitHub AI Credit and explicitly eligible legacy PRU accounting
 * into the shared provider/result boundary.
 */

import type {
  AccountingMetadata,
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import { hasCopilotQuotaRuntimeAvailable, queryCopilotQuota } from "../lib/copilot.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { modelIncludesAny, modelProviderIncludesAny } from "../lib/provider-model-matching.js";
import type {
  CopilotBudgetResult,
  CopilotEnterpriseUsageResult,
  CopilotOrganizationUsageResult,
  CopilotPlanResult,
  CopilotQuotaResult,
} from "../lib/types.js";
import { attemptedErrorResult, attemptedResult, notAttemptedResult } from "./result-helpers.js";

const REMOTE_MAINTAINED: Omit<AccountingMetadata, "resultType"> = {
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
};

function formatBillingPeriod(period: { year: number; month: number }): string {
  return `${period.year}-${String(period.month).padStart(2, "0")}`;
}

function getCopilotGroup(
  mode: "user_quota" | "user_plan" | "organization_usage" | "enterprise_usage",
): string {
  return mode === "organization_usage" || mode === "enterprise_usage"
    ? "Copilot (business)"
    : "Copilot (personal)";
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatAiCreditUsageValue(
  result: CopilotOrganizationUsageResult | CopilotEnterpriseUsageResult | CopilotQuotaResult,
): string {
  const parts = [`${formatNumber(result.used)} used`];

  if (result.includedUsed !== undefined) {
    parts.push(`${formatNumber(result.includedUsed)} included`);
  }
  if (result.billedUsed !== undefined) {
    parts.push(`${formatNumber(result.billedUsed)} billed`);
  }
  if (result.billedAmountUsd !== undefined) {
    parts.push(`${formatUsd(result.billedAmountUsd)} billed`);
  }

  if (result.mode !== "user_quota") {
    parts.push(formatBillingPeriod(result.period));
    if (result.mode === "organization_usage") {
      parts.push(`org=${result.organization}`);
    } else {
      parts.push(`enterprise=${result.enterprise}`);
      if (result.organization) parts.push(`org=${result.organization}`);
    }
    if (result.username) parts.push(`user=${result.username}`);
  } else if (result.plan) {
    parts.push(`plan=${result.plan}`);
  }

  return parts.join(" | ");
}

function makeBudgetEntry(
  budget: CopilotBudgetResult,
  group: string,
  resetTimeIso?: string,
): QuotaToastEntry {
  const spent = budget.spentUsd;
  if (budget.percentRemaining !== undefined && spent !== undefined && budget.amountUsd > 0) {
    return {
      accounting: { ...REMOTE_MAINTAINED, resultType: "budget" },
      name: "Copilot Additional Usage",
      group,
      label: "Budget:",
      right: `${formatUsd(spent)}/${formatUsd(budget.amountUsd)}`,
      percentRemaining: budget.percentRemaining,
      resetTimeIso,
    };
  }

  const value =
    spent === undefined
      ? `${formatUsd(budget.amountUsd)} limit | scope=${budget.scope}`
      : `${formatUsd(spent)} spent | ${formatUsd(budget.amountUsd)} budget | scope=${budget.scope}`;
  return {
    kind: "value",
    accounting: { ...REMOTE_MAINTAINED, resultType: "budget" },
    name: "Copilot Additional Usage",
    group,
    label: "Budget:",
    value,
    resetTimeIso,
  };
}

function planEntries(result: CopilotPlanResult): QuotaToastEntry[] {
  return [
    {
      kind: "value",
      accounting: { ...REMOTE_MAINTAINED, resultType: "quota" },
      name: "Copilot",
      group: getCopilotGroup(result.mode),
      label: "Plan:",
      value: result.plan
        ? `${result.plan} | quota details unavailable`
        : "Quota details unavailable",
      resetTimeIso: result.resetTimeIso,
    },
  ];
}

function personalEntries(result: CopilotQuotaResult): QuotaToastEntry[] {
  const group = getCopilotGroup(result.mode);
  const name = result.unit === "ai_credits" ? "Copilot AI Credits" : "Copilot Premium Requests";

  if (result.unlimited) {
    return [
      {
        kind: "value",
        accounting: { ...REMOTE_MAINTAINED, resultType: "quota" },
        name,
        group,
        label: "Quota:",
        value: "Unlimited",
        resetTimeIso: result.resetTimeIso,
      },
    ];
  }

  const entries: QuotaToastEntry[] = [];
  if (result.total !== undefined && result.total > 0 && result.percentRemaining !== undefined) {
    entries.push({
      accounting: { ...REMOTE_MAINTAINED, resultType: "quota" },
      name,
      group,
      label: result.unit === "ai_credits" ? "Credits:" : "Quota:",
      right: `${formatNumber(result.used)}/${formatNumber(result.total)}`,
      percentRemaining: result.percentRemaining,
      resetTimeIso: result.resetTimeIso,
    });
  } else {
    entries.push({
      kind: "value",
      accounting: { ...REMOTE_MAINTAINED, resultType: "usage" },
      name,
      group,
      label: result.unit === "ai_credits" ? "Credits:" : "Usage:",
      value:
        result.unit === "ai_credits"
          ? formatAiCreditUsageValue(result)
          : `${formatNumber(result.used)} used`,
      resetTimeIso: result.resetTimeIso,
    });
  }

  if (result.budget) {
    entries.push(makeBudgetEntry(result.budget, group, result.resetTimeIso));
  }
  return entries;
}

function managedEntries(
  result: CopilotOrganizationUsageResult | CopilotEnterpriseUsageResult,
): QuotaToastEntry[] {
  const group = getCopilotGroup(result.mode);
  const entries: QuotaToastEntry[] = [
    {
      kind: "value",
      accounting: { ...REMOTE_MAINTAINED, resultType: "usage" },
      name: "Copilot AI Credits",
      group,
      label: "Credits:",
      value: formatAiCreditUsageValue(result),
      resetTimeIso: result.resetTimeIso,
    },
  ];
  if (result.budget) {
    entries.push(makeBudgetEntry(result.budget, group, result.resetTimeIso));
  }
  return entries;
}

export const copilotProvider: QuotaProvider = {
  id: "copilot",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const providerAvailable = await isCanonicalProviderAvailable({
      ctx,
      providerId: "copilot",
      fallbackOnError: false,
    });
    if (providerAvailable) return true;

    try {
      return await hasCopilotQuotaRuntimeAvailable();
    } catch {
      return false;
    }
  },

  matchesCurrentModel(model: string): boolean {
    if (modelProviderIncludesAny(model, ["copilot", "github"])) return true;
    return modelIncludesAny(model, ["copilot", "github-copilot"]);
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const result = await queryCopilotQuota({ requestTimeoutMs: ctx.config?.requestTimeoutMs });
    if (!result) return notAttemptedResult();
    if (!result.success) return attemptedErrorResult("Copilot", result.error);

    const entries =
      result.mode === "user_plan"
        ? planEntries(result)
        : result.mode === "user_quota"
          ? personalEntries(result)
          : managedEntries(result);
    const errors = ("warnings" in result ? (result.warnings ?? []) : []).map((message) => ({
      label: "Copilot",
      message,
    }));
    const presentation =
      result.mode === "enterprise_usage"
        ? { singleWindowDisplayName: `Copilot Enterprise (${result.enterprise})` }
        : result.mode === "organization_usage"
          ? { singleWindowDisplayName: `Copilot Org (${result.organization})` }
          : undefined;

    return attemptedResult(entries, errors, presentation);
  },
};
