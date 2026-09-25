import type {
  AccountingMetadata,
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaProviderStatusDetail,
  QuotaToastEntry,
} from "../lib/entries.js";
import {
  OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR,
  queryOpenCodeZenQuota,
} from "../lib/opencode-zen.js";
import {
  DEFAULT_OPENCODE_ZEN_ACCOUNT_CACHE_MAX_AGE_MS,
  resolveOpenCodeZenAccountCached,
} from "../lib/opencode-zen-config.js";
import { normalizeQuotaProviderId } from "../lib/provider-metadata.js";
import {
  attemptedErrorResult,
  attemptedResult,
  notAttemptedResult,
  statusDetailsFromRecord,
  withStatusDetails,
} from "./result-helpers.js";

const OPENCODE_PROVIDER_LABEL = "OpenCode";
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

  async isAvailable(_ctx: QuotaProviderContext): Promise<boolean> {
    const resolved = await resolveOpenCodeZenAccountCached({
      maxAgeMs: DEFAULT_OPENCODE_ZEN_ACCOUNT_CACHE_MAX_AGE_MS,
    });
    return resolved.state === "configured";
  },

  matchesCurrentModel(model: string): boolean {
    const [provider] = model.toLowerCase().split("/", 2);
    return normalizeQuotaProviderId(provider) === "opencode";
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const resolved = await resolveOpenCodeZenAccountCached({
      maxAgeMs: DEFAULT_OPENCODE_ZEN_ACCOUNT_CACHE_MAX_AGE_MS,
    });

    if (resolved.state === "none") {
      // No Console CLI session in the OpenCode state DB; absent, not an error.
      return withStatusDetails(
        notAttemptedResult(),
        accountStatusDetails({ state: "none", consoleUrl: null }),
      );
    }

    if (resolved.state !== "configured") {
      return withStatusDetails(
        attemptedErrorResult(OPENCODE_PROVIDER_LABEL, accountErrorMessage(resolved.state)),
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
      return withStatusDetails(attemptedErrorResult(OPENCODE_PROVIDER_LABEL, result.error), [
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

    const hasMonthlyBudget =
      effectiveMonthlyLimit !== null &&
      Number.isFinite(effectiveMonthlyLimit) &&
      effectiveMonthlyLimit > 0 &&
      monthlyUsageUsd !== null &&
      Number.isFinite(monthlyUsageUsd) &&
      monthlyUsageUsd >= 0;
    const entries: QuotaToastEntry[] = [];

    if (hasMonthlyBudget) {
      const monthlyRemainingUsd = Math.max(0, effectiveMonthlyLimit - monthlyUsageUsd);
      entries.push({
        accounting: OPENCODE_ZEN_BUDGET_ACCOUNTING,
        name: "zen-monthly-budget",
        group: OPENCODE_ZEN_GROUP,
        percentRemaining: Math.min(100, (monthlyRemainingUsd / effectiveMonthlyLimit) * 100),
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

    const errors = result.errors.map((message) => ({ label: OPENCODE_PROVIDER_LABEL, message }));

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
