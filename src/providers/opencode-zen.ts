import type {
  AccountingMetadata,
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import {
  queryOpenCodeZenQuota,
} from "../lib/opencode-zen.js";
import { OPENCODE_CONSOLE_BASE_URL, resolveOpenCodeConsoleAuth } from "../lib/opencode-console-auth.js";
import { normalizeQuotaProviderId } from "../lib/provider-metadata.js";
import {
  attemptedErrorResult,
  attemptedResult,
  notAttemptedResult,
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

function zenUsdDecimal(value: number): string {
  const fixed = value.toFixed(8);
  return fixed.replace(/0+$/u, "").replace(/\.$/u, "");
}

export const opencodeZenProvider: QuotaProvider = {
  id: "opencode",

  async isAvailable(_ctx: QuotaProviderContext): Promise<boolean> {
    const auth = await resolveOpenCodeConsoleAuth();
    return auth.state === "configured" || auth.state === "expired";
  },

  matchesCurrentModel(model: string): boolean {
    const [provider] = model.toLowerCase().split("/", 2);
    return normalizeQuotaProviderId(provider) === "opencode";
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const auth = await resolveOpenCodeConsoleAuth();

    if (auth.state === "none") {
      return withStatusDetails(notAttemptedResult(), [
        { key: "console_auth_state", value: "none" },
      ]);
    }

    if (auth.state === "expired") {
      return withStatusDetails(
        attemptedErrorResult(
          OPENCODE_PROVIDER_LABEL,
          "OpenCode Console credential expired - run `opencode auth login` to refresh",
        ),
        [
          { key: "console_auth_state", value: "expired" },
          { key: "console_server", value: auth.credential.server ?? OPENCODE_CONSOLE_BASE_URL },
        ],
      );
    }

    if (auth.state === "invalid") {
      return withStatusDetails(
        attemptedErrorResult(OPENCODE_PROVIDER_LABEL, auth.error),
        [{ key: "console_auth_state", value: "invalid" }],
      );
    }

    const statusDetails = [
      { key: "console_auth_state", value: "configured" },
      { key: "console_server", value: auth.credential.server ?? OPENCODE_CONSOLE_BASE_URL },
    ];

    const result = await queryOpenCodeZenQuota(
      { accessToken: auth.credential.accessToken },
      {
        requestTimeoutMs: ctx.config?.requestTimeoutMsConfigured
          ? ctx.config.requestTimeoutMs
          : undefined,
      },
    );

    if (!result.success) {
      return withStatusDetails(attemptedErrorResult(OPENCODE_PROVIDER_LABEL, result.error), [
        ...statusDetails,
        { key: "live_fetch_error", value: result.error },
      ]);
    }

    // The console quota query returns USD-converted billing data.
    const balanceUsd = result.data.balance;
    const configuredMonthlyLimit = ctx.config?.opencodeMonthlyLimit;
    const effectiveMonthlyLimit = configuredMonthlyLimit ?? result.data.monthlyLimit;
    const monthlyUsageUsd = result.data.monthlyUsage;

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

    return withStatusDetails(attemptedResult(entries), [
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
        key: "last_payment_usd",
        value:
          result.data.lastPayment === null
            ? "(none)"
            : `USD ${zenUsdDecimal(result.data.lastPayment)}`,
      },
      { key: "auto_reload", value: result.data.reload ? "true" : "false" },
      {
        key: "auto_reload_amount_raw",
        value: result.data.reloadAmount === null ? "(none)" : String(result.data.reloadAmount),
      },
      {
        key: "auto_reload_trigger_raw",
        value: result.data.reloadTrigger === null ? "(none)" : String(result.data.reloadTrigger),
      },
    ]);
  },
};
