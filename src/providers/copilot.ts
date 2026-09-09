/**
 * Copilot provider wrapper.
 *
 * Normalizes GitHub AI Credit and explicitly eligible legacy PRU accounting
 * into the shared provider/result boundary.
 */

import {
  getCopilotQuotaAuthDiagnostics,
  hasCopilotQuotaRuntimeAvailable,
  queryCopilotQuota,
} from "../lib/copilot.js";
import type {
  AccountingMetadata,
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import {
  formatCredentialDisplayNames,
  readAuthFileCached,
  readCredentialRows,
} from "../lib/opencode-auth.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { modelIncludesAny, modelProviderIncludesAny } from "../lib/provider-model-matching.js";
import type {
  AuthData,
  CopilotBudgetResult,
  CopilotEnterpriseUsageResult,
  CopilotOrganizationUsageResult,
  CopilotPlanResult,
  CopilotQuotaResult,
} from "../lib/types.js";
import {
  attemptedErrorResult,
  attemptedResult,
  notAttemptedResult,
  statusDetailsFromRecord,
  withStatusDetails,
} from "./result-helpers.js";

function remoteAccounting(
  resultType: AccountingMetadata["resultType"],
  authority: AccountingMetadata["authority"],
): AccountingMetadata {
  return {
    resultType,
    acquisitionMethod: "remote_api",
    ownership: "maintained",
    authority,
  };
}

function formatBillingPeriod(period: { year: number; month: number }): string {
  return `${period.year}-${String(period.month).padStart(2, "0")}`;
}

function getCopilotGroup(
  mode: "user_quota" | "user_plan" | "organization_usage" | "enterprise_usage",
  plan?: string,
): string {
  if (mode === "organization_usage" || mode === "enterprise_usage") {
    return "Copilot (business)";
  }
  return plan ? `Copilot (${plan})` : "Copilot (personal)";
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
  const parts = [`Used ${formatNumber(result.used)}`];

  if (result.includedUsed !== undefined) {
    parts.push(`Included ${formatNumber(result.includedUsed)}`);
  }
  if (result.billedUsed !== undefined) {
    const billedAmount =
      result.billedAmountUsd === undefined ? "" : ` (${formatUsd(result.billedAmountUsd)})`;
    parts.push(`Billed ${formatNumber(result.billedUsed)}${billedAmount}`);
  } else if (result.billedAmountUsd !== undefined) {
    parts.push(`Billed ${formatUsd(result.billedAmountUsd)}`);
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
      accounting: remoteAccounting("budget", budget.authority),
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
    accounting: remoteAccounting("budget", budget.authority),
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
      accounting: remoteAccounting("quota", result.authority),
      name: "Copilot",
      group: getCopilotGroup(result.mode, result.plan),
      label: "Plan:",
      value: result.plan
        ? `${result.plan} | quota details unavailable`
        : "Quota details unavailable",
      resetTimeIso: result.resetTimeIso,
    },
  ];
}

function personalEntries(result: CopilotQuotaResult): QuotaToastEntry[] {
  const group = getCopilotGroup(result.mode, result.plan);
  const name =
    result.unit === "ai_credits"
      ? "Copilot AI Credits"
      : result.unit === "premium_interactions"
        ? "Copilot Premium Interactions"
        : "Copilot Premium Requests";

  if (result.unlimited) {
    return [
      {
        kind: "value",
        accounting: remoteAccounting("quota", result.authority),
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
      accounting: remoteAccounting("quota", result.authority),
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
      accounting: remoteAccounting("usage", result.authority),
      name,
      group,
      label: result.unit === "ai_credits" ? "Credits:" : "Usage:",
      value:
        result.unit === "ai_credits"
          ? formatAiCreditUsageValue(result)
          : `Used ${formatNumber(result.used)}`,
      resetTimeIso: result.resetTimeIso,
    });
  }

  if (result.budget) {
    entries.push(makeBudgetEntry(result.budget, group, result.resetTimeIso));
  }
  return entries;
}

async function getCopilotStatusDetails() {
  const diagnostics = getCopilotQuotaAuthDiagnostics(await readAuthFileCached({ maxAgeMs: 5_000 }));
  const managedBilling =
    diagnostics.billingMode === "organization_usage" ||
    diagnostics.billingMode === "enterprise_usage";
  return statusDetailsFromRecord({
    pat_state: diagnostics.pat.state,
    pat_path: diagnostics.pat.selectedPath,
    pat_token_kind: diagnostics.pat.tokenKind,
    pat_tier: diagnostics.pat.config?.tier,
    billing_model: diagnostics.billingModel,
    pat_organization: diagnostics.pat.config?.organization,
    pat_enterprise: diagnostics.pat.config?.enterprise,
    deployment: diagnostics.deployment,
    api_host: diagnostics.apiHost ?? "(none)",
    enterprise_host_source: diagnostics.enterpriseHostSource,
    enterprise_host_error: diagnostics.enterpriseHostError,
    billing_mode: diagnostics.billingMode,
    billing_scope: diagnostics.billingScope,
    quota_api: diagnostics.quotaApi,
    budget_api: diagnostics.budgetApi,
    billing_api_access_likely: diagnostics.billingApiAccessLikely ? "true" : "false",
    remaining_totals_state: diagnostics.remainingTotalsState,
    billing_period: diagnostics.queryPeriod
      ? formatBillingPeriod(diagnostics.queryPeriod)
      : undefined,
    username_filter: diagnostics.usernameFilter,
    billing_usage_note: managedBilling
      ? `${diagnostics.billingMode === "organization_usage" ? "organization" : "enterprise"} AI Credit usage for the current UTC calendar month`
      : undefined,
    remaining_quota_note: managedBilling
      ? "the usage report exposes included-pool consumption and billed usage, but no included-pool denominator; percentages require a real budget"
      : undefined,
    billing_target_error: diagnostics.billingTargetError,
    token_compatibility_error: diagnostics.tokenCompatibilityError,
    pat_error: diagnostics.pat.error,
    pat_checked_paths: diagnostics.pat.checkedPaths.join(" | ") || "(none)",
    oauth_configured: `${diagnostics.oauth.configured ? "true" : "false"} key=${diagnostics.oauth.keyName ?? "(none)"} refresh=${diagnostics.oauth.hasRefreshToken ? "true" : "false"} access=${diagnostics.oauth.hasAccessToken ? "true" : "false"} enterprise_host=${diagnostics.oauth.hasEnterpriseUrl ? "true" : "false"}`,
    effective_source: diagnostics.effectiveSource,
    oauth_accounting_state: diagnostics.oauthAccountingState,
    override: diagnostics.override,
  });
}

function managedEntries(
  result: CopilotOrganizationUsageResult | CopilotEnterpriseUsageResult,
): QuotaToastEntry[] {
  const group = getCopilotGroup(result.mode);
  const entries: QuotaToastEntry[] = [
    {
      kind: "value",
      accounting: remoteAccounting("usage", result.authority),
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
    const statusDetails = await getCopilotStatusDetails();
    const authData = await readAuthFileCached({ maxAgeMs: 5_000 });
    if (getCopilotQuotaAuthDiagnostics(authData).effectiveSource === "oauth") {
      const credentials = (await readCredentialRows()).filter((row) =>
        ["github-copilot", "copilot", "copilot-chat", "github-copilot-chat"].includes(
          row.integrationId,
        ),
      );
      if (credentials.length > 0) {
        const results = await Promise.all(
          credentials.map(async (row) => ({
            row,
            result: await queryCopilotQuota({
              requestTimeoutMs: ctx.config?.requestTimeoutMs,
              authData: { [row.integrationId]: row.value } as AuthData,
            }),
          })),
        );
        const names = formatCredentialDisplayNames(
          "Copilot",
          results.map(({ row, result }) => ({
            row,
            fallbackName: result?.success
              ? getCopilotGroup(result.mode, "plan" in result ? result.plan : undefined)
              : "Copilot",
          })),
        );
        const entries: QuotaToastEntry[] = [];
        const errors: QuotaProviderResult["errors"] = [];
        for (const [index, { row, result }] of results.entries()) {
          const group = names[index] ?? "Copilot";
          if (!result) continue;
          if (!result.success) {
            errors.push({ label: group, message: result.error });
            continue;
          }
          const resultEntries =
            result.mode === "user_plan"
              ? planEntries(result)
              : result.mode === "user_quota"
                ? personalEntries(result)
                : managedEntries(result);
          entries.push(
            ...resultEntries.map((entry) => ({
              ...entry,
              name: entry.group ? entry.name.replace(entry.group, group) : entry.name,
              group,
              accounting: { ...entry.accounting, sourceId: row.id },
            })),
          );
          errors.push(
            ...("warnings" in result ? (result.warnings ?? []) : []).map((message) => ({
              label: group,
              message,
            })),
          );
        }
        return withStatusDetails(attemptedResult(entries, errors), statusDetails);
      }
    }
    const result = await queryCopilotQuota({ requestTimeoutMs: ctx.config?.requestTimeoutMs });
    if (!result) return withStatusDetails(notAttemptedResult(), statusDetails);
    if (!result.success) {
      return withStatusDetails(attemptedErrorResult("Copilot", result.error), statusDetails);
    }

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

    return withStatusDetails(attemptedResult(entries, errors, presentation), statusDetails);
  },
};
