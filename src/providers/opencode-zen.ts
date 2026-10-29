import type {
  AccountingMetadata,
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaProviderStatusDetail,
  QuotaToastEntry,
} from "../lib/entries.js";
import { resolveOpenCodeZenAccountCached } from "../lib/opencode-zen-config.js";
import {
  OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR,
  queryOpenCodeZenQuota,
} from "../lib/opencode-zen.js";
import { normalizeQuotaProviderId } from "../lib/provider-metadata.js";
import {
  attemptedErrorResult,
  attemptedResult,
  notAttemptedResult,
  statusDetailsFromRecord,
  withStatusDetails,
} from "./result-helpers.js";

const OPENCODE_ZEN_GROUP = "OpenCode Zen";
const OPENCODE_ZEN_BALANCE_ACCOUNTING: AccountingMetadata = {
  resultType: "balance",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
};
const OPENCODE_ZEN_BUDGET_ACCOUNTING: AccountingMetadata = {
  resultType: "budget",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "locally_derived",
};
const OPENCODE_ZEN_SPEND_ACCOUNTING: AccountingMetadata = {
  resultType: "spend",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
};
const OPENCODE_ZEN_STATUS_ACCOUNTING: AccountingMetadata = {
  resultType: "status",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
};
const USD_UNIT = { kind: "currency", code: "USD" } as const;

const LOGIN_HINT = "Run `opencode console login` to sign in again.";
const SWITCH_HINT = "Run `opencode console switch` to select one.";

function accountErrorMessage(state: string): string {
  if (state === "missing_org") {
    return `No active OpenCode Console organization. ${SWITCH_HINT}`;
  }
  if (state === "inactive_account") {
    return `Active OpenCode Console account not found. ${SWITCH_HINT}`;
  }
  if (state === "expired") {
    return `OpenCode Console session expired. ${LOGIN_HINT}`;
  }
  if (state === "no_active_account") {
    return `No active OpenCode Console account. ${LOGIN_HINT}`;
  }
  if (state === "invalid_url") {
    return `The stored OpenCode Console URL is invalid. ${LOGIN_HINT}`;
  }
  if (state === "incompatible") {
    return `OpenCode state database is missing the Console account tables. Update OpenCode, then ${LOGIN_HINT}`;
  }
  if (state === "read_error") {
    return "The OpenCode state database could not be read (it may be locked). Close or retry OpenCode, then try again.";
  }
  return `No OpenCode Console session found. ${LOGIN_HINT}`;
}

function accountStatusDetails(params: {
  state: string;
  consoleUrl: string | null;
}): QuotaProviderStatusDetail[] {
  return statusDetailsFromRecord({
    account_state: params.state,
    console_url: params.consoleUrl ?? "(none)",
  });
}

function zenUsdDecimal(value: number): string {
  const fixed = value.toFixed(8);
  return fixed.replace(/0+$/u, "").replace(/\.$/u, "");
}

export const opencodeZenProvider: QuotaProvider = {
  id: "opencode",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const resolved = await resolveOpenCodeZenAccountCached();
    if (resolved.state === "none") return false;
    // A normal DB with no Console sign-in is not an auto-mode error, but stays
    // actionable when the user explicitly enables the opencode provider.
    if (resolved.state === "no_active_account" && ctx.config.enabledProviders === "auto") {
      return false;
    }
    // Other recoverable states (expired session, no active org, ...) stay
    // available so fetch() can surface their recovery hints.
    return true;
  },

  matchesCurrentModel(model: string): boolean {
    const [provider] = model.toLowerCase().split("/", 2);
    return normalizeQuotaProviderId(provider) === "opencode";
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const resolved = await resolveOpenCodeZenAccountCached();

    if (resolved.state === "none") {
      // No Console CLI session in the OpenCode state DB; absent, not an error.
      return withStatusDetails(
        notAttemptedResult(),
        accountStatusDetails({ state: "none", consoleUrl: null }),
      );
    }

    if (resolved.state !== "configured") {
      return withStatusDetails(
        attemptedErrorResult(OPENCODE_ZEN_GROUP, accountErrorMessage(resolved.state)),
        accountStatusDetails({ state: resolved.state, consoleUrl: null }),
      );
    }

    const { account } = resolved;
    const statusDetails = accountStatusDetails({
      state: "configured",
      consoleUrl: account.baseUrl,
    });

    const result = await queryOpenCodeZenQuota(account, {
      requestTimeoutMs: ctx.config?.requestTimeoutMsConfigured
        ? ctx.config.requestTimeoutMs
        : undefined,
    });

    if (!result.success) {
      return withStatusDetails(attemptedErrorResult(OPENCODE_ZEN_GROUP, result.error), [
        ...statusDetails,
        { key: "live_fetch_error", value: result.error },
      ]);
    }

    const balanceUsd = result.data.balance / OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR;
    const configuredMonthlyLimit = ctx.config?.opencodeMonthlyLimit;
    const effectiveMonthlyLimit = configuredMonthlyLimit ?? result.data.monthlyLimit;
    const monthlyUsageUsd =
      result.data.monthlyUsage === null
        ? null
        : result.data.monthlyUsage / OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR;

    const hasMonthlyUsage =
      monthlyUsageUsd !== null && Number.isFinite(monthlyUsageUsd) && monthlyUsageUsd >= 0;
    // A member-budget limit of $0 is a real blocking limit, not an absence; a
    // $0 credit-limit fallback value still counts as no limit. Only a member
    // budget sets a reset date.
    const zeroMemberBudget = result.data.budgetResetIso !== null && effectiveMonthlyLimit === 0;
    const hasMonthlyBudget =
      effectiveMonthlyLimit !== null &&
      Number.isFinite(effectiveMonthlyLimit) &&
      (effectiveMonthlyLimit > 0 || zeroMemberBudget) &&
      hasMonthlyUsage;
    const entries: QuotaToastEntry[] = [];

    if (hasMonthlyBudget) {
      const monthlyRemainingUsd = Math.max(0, effectiveMonthlyLimit - monthlyUsageUsd);
      entries.push({
        accounting: OPENCODE_ZEN_BUDGET_ACCOUNTING,
        name: "zen-monthly-budget",
        group: OPENCODE_ZEN_GROUP,
        percentRemaining:
          effectiveMonthlyLimit > 0
            ? Math.min(100, (monthlyRemainingUsd / effectiveMonthlyLimit) * 100)
            : 0,
        ...(result.data.budgetResetIso ? { resetTimeIso: result.data.budgetResetIso } : {}),
        semantic: {
          metric: { kind: "window", window: "month" },
          prominence: "primary",
        },
        basis: {
          used: {
            quantity: { decimal: zenUsdDecimal(monthlyUsageUsd), unit: USD_UNIT },
            authority: "provider_reported",
          },
          limit: {
            quantity: { decimal: zenUsdDecimal(effectiveMonthlyLimit), unit: USD_UNIT },
            authority:
              configuredMonthlyLimit === undefined ? "provider_reported" : "user_configured",
          },
          remaining: {
            quantity: { decimal: zenUsdDecimal(monthlyRemainingUsd), unit: USD_UNIT },
            authority: "locally_derived",
          },
        },
      });
    } else if (hasMonthlyUsage) {
      // No limit to measure against: still show this month's real spend.
      entries.push({
        accounting: OPENCODE_ZEN_SPEND_ACCOUNTING,
        kind: "quantity",
        name: "zen-monthly-spend",
        group: OPENCODE_ZEN_GROUP,
        semantic: {
          metric: { kind: "window", window: "month" },
          prominence: "primary",
        },
        quantity: { decimal: zenUsdDecimal(monthlyUsageUsd), unit: USD_UNIT },
      });
    }

    entries.push({
      accounting: OPENCODE_ZEN_BALANCE_ACCOUNTING,
      kind: "quantity",
      name: "zen-current-balance",
      group: OPENCODE_ZEN_GROUP,
      semantic: {
        metric: { kind: "component", component: "current_balance" },
        prominence: hasMonthlyBudget ? "supplementary" : "primary",
      },
      quantity: { decimal: zenUsdDecimal(balanceUsd), unit: USD_UNIT },
    });
    if (result.data.reload !== null) {
      entries.push({
        accounting: OPENCODE_ZEN_STATUS_ACCOUNTING,
        kind: "boolean",
        name: "zen-auto-reload",
        group: OPENCODE_ZEN_GROUP,
        semantic: {
          metric: { kind: "component", component: "auto_reload" },
          prominence: "supplementary",
        },
        value: result.data.reload,
      });
    }

    const errors = result.errors.map((message) => ({ label: OPENCODE_ZEN_GROUP, message }));

    return withStatusDetails(attemptedResult(entries, errors), [
      ...statusDetails,
      { key: "balance_usd", value: `USD ${zenUsdDecimal(balanceUsd)}` },
      {
        key: "monthly_limit_usd",
        value:
          result.data.monthlyLimit === null
            ? "(none)"
            : `USD ${zenUsdDecimal(result.data.monthlyLimit)}`,
      },
      {
        key: "monthly_usage_usd",
        value: monthlyUsageUsd === null ? "(unknown)" : `USD ${zenUsdDecimal(monthlyUsageUsd)}`,
      },
      ...(result.data.memberBudgetsSkipped
        ? [
            {
              key: "member_budget_note",
              value:
                "member budgets found, but not all can be evaluated (model filters, per-model limits, or missing amounts); using the credit limit",
            },
          ]
        : []),
      {
        key: "auto_reload",
        value: result.data.reload === null ? "(unknown)" : String(result.data.reload),
      },
      {
        key: "auto_reload_amount_raw",
        value: result.data.reloadAmount === null ? "(none)" : String(result.data.reloadAmount),
      },
      {
        key: "auto_reload_trigger_raw",
        value: result.data.reloadTrigger === null ? "(none)" : String(result.data.reloadTrigger),
      },
      ...(result.errors.length > 0
        ? [{ key: "live_fetch_error", value: result.errors.join(" | ") }]
        : []),
    ]);
  },
};
