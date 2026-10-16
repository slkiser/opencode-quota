/**
 * Copilot provider wrapper.
 *
 * Normalizes GitHub AI Credit and explicitly eligible legacy PRU accounting
 * into the shared provider/result boundary.
 */

import {
  type CopilotQuotaAuthDiagnostics,
  copilotLoginsIdentity,
  getCopilotQuotaAuthDiagnostics,
  queryCopilotQuota,
  readCopilotLogins,
} from "../lib/copilot.js";
import type { QuotaProvider, QuotaProviderContext } from "../lib/entries.js";
import { fmtUsdAmount } from "../lib/format-utils.js";
import { type CredentialRow, credentialRowAuthData } from "../lib/opencode-auth.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { modelIncludesAny, modelProviderIncludesAny } from "../lib/provider-model-matching.js";
import type {
  CopilotBudgetResult,
  CopilotEnterpriseUsageResult,
  CopilotOrganizationUsageResult,
  CopilotPlanResult,
  CopilotQuotaResult,
} from "../lib/types.js";
import {
  type AccountResult,
  failedAccount,
  fetchEachLogin,
  type ProviderFetchResult,
  type ProviderRow,
} from "./contract.js";
import { statusDetailsFromRecord } from "./result-helpers.js";

type CopilotSuccessResult =
  | CopilotQuotaResult
  | CopilotPlanResult
  | CopilotOrganizationUsageResult
  | CopilotEnterpriseUsageResult;

function formatBillingPeriod(period: { year: number; month: number }): string {
  return `${period.year}-${String(period.month).padStart(2, "0")}`;
}

function getCopilotGroup(mode: CopilotSuccessResult["mode"], plan?: string): string {
  if (mode === "organization_usage" || mode === "enterprise_usage") {
    return "Copilot (business)";
  }
  return plan ? `Copilot (${plan})` : "Copilot (personal)";
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

const COUNT_DECIMAL = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
  useGrouping: false,
});

/** A count as Copilot shows it, rounded to 2 places; none when negative or not finite. */
function countDecimal(value: number): string | undefined {
  const text = COUNT_DECIMAL.format(value);
  return /^\d+(?:\.\d+)?$/u.test(text) ? text : undefined;
}

/** Dollars as Copilot shows them ("2.50" → "2.5"); none when negative or not finite. */
function usdDecimal(value: number): string | undefined {
  const text = value.toFixed(2);
  if (!/^\d+\.\d{2}$/u.test(text)) return undefined;
  const [whole = "0", cents = ""] = text.split(".");
  const fraction = cents.replace(/0+$/u, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/** Used and limit in `unit`, or neither when either is not a plain shown number. */
function usedAndLimit(
  used: string | undefined,
  limit: string | undefined,
  unit: { kind: "currency"; code: string } | { kind: "count"; unit: string },
): Pick<ProviderRow, "used" | "limit"> {
  if (used === undefined || limit === undefined) return {};
  return { used: { decimal: used, unit }, limit: { decimal: limit, unit } };
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
      result.billedAmountUsd === undefined ? "" : ` (${fmtUsdAmount(result.billedAmountUsd)})`;
    parts.push(`Billed ${formatNumber(result.billedUsed)}${billedAmount}`);
  } else if (result.billedAmountUsd !== undefined) {
    parts.push(`Billed ${fmtUsdAmount(result.billedAmountUsd)}`);
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

/** The fields every Copilot row shares; `resetsAt` only when Copilot gave one. */
function copilotRow(
  fields: Pick<ProviderRow, "key" | "label" | "type" | "authority"> & {
    window?: ProviderRow["window"];
    resetTimeIso?: string;
  },
): ProviderRow {
  return {
    key: fields.key,
    label: fields.label,
    type: fields.type,
    method: "remote_api",
    authority: fields.authority,
    ...(fields.window ? { window: fields.window } : {}),
    prominence: "primary",
    ...(fields.resetTimeIso ? { resetsAt: fields.resetTimeIso } : {}),
  };
}

function budgetRow(budget: CopilotBudgetResult, resetTimeIso?: string): ProviderRow {
  const row = copilotRow({
    key: "additional_budget",
    label: "Budget",
    type: "budget",
    authority: budget.authority,
    window: "month",
    resetTimeIso,
  });
  const spent = budget.spentUsd;
  if (budget.percentRemaining !== undefined && spent !== undefined && budget.amountUsd > 0) {
    return {
      ...row,
      percentRemaining: budget.percentRemaining,
      ...usedAndLimit(usdDecimal(spent), usdDecimal(budget.amountUsd), {
        kind: "currency",
        code: "USD",
      }),
    };
  }
  const text =
    spent === undefined
      ? `${fmtUsdAmount(budget.amountUsd)} limit | scope=${budget.scope}`
      : `${fmtUsdAmount(spent)} spent | ${fmtUsdAmount(budget.amountUsd)} budget | scope=${budget.scope}`;
  return { ...row, text };
}

const ALLOWANCE_UNITS = {
  ai_credits: { label: "Credits", unit: "credit" },
  premium_interactions: { label: "Premium interactions", unit: "interaction" },
  premium_requests: { label: "Premium requests", unit: "request" },
} as const;

function personalRow(result: CopilotQuotaResult): ProviderRow {
  const allowance = ALLOWANCE_UNITS[result.unit] ?? ALLOWANCE_UNITS.premium_requests;
  const base = {
    key: "allowance",
    label: allowance.label,
    authority: result.authority,
    window: "month" as const,
    resetTimeIso: result.resetTimeIso,
  };
  if (result.unlimited) return { ...copilotRow({ ...base, type: "quota" }), text: "Unlimited" };
  if (result.total !== undefined && result.total > 0 && result.percentRemaining !== undefined) {
    return {
      ...copilotRow({ ...base, type: "quota" }),
      percentRemaining: result.percentRemaining,
      ...usedAndLimit(countDecimal(result.used), countDecimal(result.total), {
        kind: "count",
        unit: allowance.unit,
      }),
    };
  }
  return {
    ...copilotRow({ ...base, type: "usage" }),
    text:
      result.unit === "ai_credits"
        ? formatAiCreditUsageValue(result)
        : `Used ${formatNumber(result.used)}`,
  };
}

function resultRows(result: CopilotSuccessResult): ProviderRow[] {
  if (result.mode === "user_quota") return [personalRow(result)];
  if (result.mode === "user_plan") {
    // Without a billing token Copilot shows only the plan; it stands in for the allowance.
    return [
      {
        ...copilotRow({
          key: "allowance",
          label: "Plan",
          type: "quota",
          authority: result.authority,
          resetTimeIso: result.resetTimeIso,
        }),
        text: result.plan
          ? `${result.plan} | usage needs billing token`
          : "Usage needs billing token",
      },
    ];
  }

  const rows: ProviderRow[] = [
    {
      ...copilotRow({
        key: "allowance",
        label: "Credits",
        type: "usage",
        authority: result.authority,
        window: "month",
        resetTimeIso: result.resetTimeIso,
      }),
      text: formatAiCreditUsageValue(result),
    },
  ];
  if (result.budget) rows.push(budgetRow(result.budget, result.resetTimeIso));
  return rows;
}

function resultWarnings(result: CopilotSuccessResult): string[] {
  return result.mode === "user_plan" ? [] : (result.warnings ?? []);
}

function copilotStatusDetails(diagnostics: CopilotQuotaAuthDiagnostics) {
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
    token_compatibility_error: diagnostics.tokenCompatibilityError,
    pat_error: diagnostics.pat.error,
    pat_checked_paths: diagnostics.pat.checkedPaths.join(" | ") || "(none)",
    oauth_configured: `${diagnostics.oauth.configured ? "true" : "false"} key=${diagnostics.oauth.keyName ?? "(none)"} refresh=${diagnostics.oauth.hasRefreshToken ? "true" : "false"} access=${diagnostics.oauth.hasAccessToken ? "true" : "false"} enterprise_host=${diagnostics.oauth.hasEnterpriseUrl ? "true" : "false"}`,
    effective_source: diagnostics.effectiveSource,
    oauth_accounting_state: diagnostics.oauthAccountingState,
    override: diagnostics.override,
  });
}

/** One query per OpenCode Copilot login, each shown under its own credential name. */
function fetchPerCredential(
  credentials: CredentialRow[],
  requestTimeoutMs?: number,
): Promise<AccountResult[]> {
  // A failed login stays in the list so it shows as its own error.
  return fetchEachLogin({
    providerName: "Copilot",
    logins: credentials.map((row) => ({ row })),
    async fetchLogin({ row }) {
      const result = await queryCopilotQuota({
        requestTimeoutMs,
        authData: credentialRowAuthData(row),
      });
      if (!result) return null;
      if (!result.success) return { rows: [], errors: [{ message: result.error }] };
      return {
        rows: resultRows(result),
        errors: resultWarnings(result).map((message) => ({ message })),
        fallbackName: getCopilotGroup(result.mode, "plan" in result ? result.plan : undefined),
      };
    },
  });
}

export const copilotProvider: QuotaProvider = {
  id: "copilot",
  cachePolicy: {
    kind: "resolved-auth",
    resolveIdentity: async () => copilotLoginsIdentity(await readCopilotLogins()),
  },

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const providerAvailable = await isCanonicalProviderAvailable({
      ctx,
      providerId: "copilot",
      fallbackOnError: false,
    });
    if (providerAvailable) return true;

    try {
      return getCopilotQuotaAuthDiagnostics(await readCopilotLogins()).billingApiAccessLikely;
    } catch {
      return false;
    }
  },

  matchesCurrentModel(model: string): boolean {
    if (modelProviderIncludesAny(model, ["copilot", "github"])) return true;
    return modelIncludesAny(model, ["copilot", "github-copilot"]);
  },

  async fetch(ctx: QuotaProviderContext): Promise<ProviderFetchResult> {
    const requestTimeoutMs = ctx.config?.requestTimeoutMs;
    const logins = await readCopilotLogins();
    const debug = copilotStatusDetails(getCopilotQuotaAuthDiagnostics(logins));
    if (logins.pat.state === "absent") {
      // A login without a token or OAuth state gives no account.
      const accounts = await fetchPerCredential(logins.oauth, requestTimeoutMs);
      return { attempted: accounts.length > 0, accounts, debug };
    }

    const result = await queryCopilotQuota({ requestTimeoutMs });
    if (!result) return { attempted: false, accounts: [], debug };
    if (!result.success) {
      return { attempted: true, accounts: [failedAccount("Copilot", result.error)], debug };
    }
    const group = getCopilotGroup(result.mode, "plan" in result ? result.plan : undefined);
    const warnings = resultWarnings(result).map((message) => ({ message }));
    return {
      attempted: true,
      accounts: [
        { name: group, rows: resultRows(result), errors: [] },
        // The default login's warnings are labelled "Copilot", like its errors.
        ...(warnings.length > 0 ? [{ name: "Copilot", rows: [], errors: warnings }] : []),
      ],
      debug,
    };
  },
};
