/**
 * Kilo Gateway provider wrapper.
 */

import type {
  AccountingMetadata,
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import { fmtUsdAmount } from "../lib/format-utils.js";
import { type KiloQuotaResult, queryKiloQuota } from "../lib/kilo.js";
import { getKiloKeyDiagnostics, hasKiloApiKey } from "../lib/kilo-config.js";
import { modelProviderMatchesRuntimeId } from "../lib/provider-model-matching.js";
import { accountingDecimalFromNumber } from "./accounting-decimal.js";
import {
  attemptedResult,
  notAttemptedResult,
  simpleApiKeyStatusDetails,
  statusDetailsFromRecord,
  withStatusDetails,
} from "./result-helpers.js";

const KILO_QUOTA_ACCOUNTING: AccountingMetadata = {
  resultType: "quota",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "locally_derived",
};

const KILO_BALANCE_ACCOUNTING: AccountingMetadata = {
  resultType: "balance",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
};

type KiloPassSuccess = Extract<NonNullable<KiloQuotaResult>, { success: true; mode: "kilo_pass" }>;
type KiloBalanceSuccess = Extract<
  NonNullable<KiloQuotaResult>,
  { success: true; mode: "gateway_balance" }
>;

function buildKiloPassEntries(state: KiloPassSuccess): QuotaToastEntry[] {
  const totalCreditsUsd = state.baseCreditsUsd + state.bonusCreditsUsd;
  const quantity = (value: number) => ({
    decimal: accountingDecimalFromNumber(value),
    unit: { kind: "currency", code: "USD" } as const,
  });

  if (totalCreditsUsd > 0) {
    return [
      {
        accounting: KILO_QUOTA_ACCOUNTING,
        name: "kilo-gateway-credits",
        group: "Kilo Gateway",
        percentRemaining: Math.min(
          100,
          Math.max(0, ((totalCreditsUsd - state.usageUsd) / totalCreditsUsd) * 100),
        ),
        semantic: {
          metric: { kind: "component", component: "remaining_credits" },
          prominence: "primary",
        },
        basis: {
          used: {
            quantity: quantity(state.usageUsd),
            authority: "provider_reported",
          },
          limit: {
            quantity: quantity(totalCreditsUsd),
            authority: "locally_derived",
          },
          remaining: {
            quantity: quantity(state.remainingUsd),
            authority: "locally_derived",
          },
        },
        ...(state.resetTimeIso ? { resetTimeIso: state.resetTimeIso } : {}),
      },
    ];
  }

  return [
    {
      kind: "quantity",
      accounting: KILO_QUOTA_ACCOUNTING,
      name: "kilo-gateway-remaining-credits",
      group: "Kilo Gateway",
      semantic: {
        metric: { kind: "component", component: "remaining_credits" },
        prominence: "primary",
      },
      quantity: quantity(state.remainingUsd),
      ...(state.resetTimeIso ? { resetTimeIso: state.resetTimeIso } : {}),
    },
  ];
}

function mapKiloPassSuccess(state: KiloPassSuccess): QuotaProviderResult {
  const rawDetails = statusDetailsFromRecord({
    base_credits_usd: fmtUsdAmount(state.baseCreditsUsd),
    usage_usd: fmtUsdAmount(state.usageUsd),
    bonus_credits_usd: fmtUsdAmount(state.bonusCreditsUsd),
    remaining_usd: fmtUsdAmount(state.remainingUsd),
    overage_usd: fmtUsdAmount(state.overageUsd),
    reset_at: state.resetTimeIso ?? "(none)",
  });

  return withStatusDetails(
    {
      ...attemptedResult(buildKiloPassEntries(state)),
      rawDetails,
    },
    [...statusDetailsFromRecord({ accounting_mode: "kilo_pass" }), ...rawDetails],
  );
}

function mapKiloBalanceSuccess(state: KiloBalanceSuccess): QuotaProviderResult {
  return withStatusDetails(
    attemptedResult([
      {
        kind: "quantity",
        accounting: KILO_BALANCE_ACCOUNTING,
        name: "kilo-gateway-total-balance",
        group: "Kilo Gateway",
        semantic: {
          metric: { kind: "component", component: "total_balance" },
          prominence: "primary",
        },
        quantity: {
          decimal: accountingDecimalFromNumber(state.balanceUsd),
          unit: { kind: "currency", code: "USD" },
        },
      },
    ]),
    statusDetailsFromRecord({
      accounting_mode: "gateway_balance",
      balance_usd: fmtUsdAmount(state.balanceUsd),
    }),
  );
}

export const kiloProvider: QuotaProvider = {
  id: "kilo",

  async isAvailable(_ctx: QuotaProviderContext): Promise<boolean> {
    return await hasKiloApiKey();
  },

  matchesCurrentModel(model: string): boolean {
    return modelProviderMatchesRuntimeId(model, "kilo");
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const diagnostics = await getKiloKeyDiagnostics().catch(() => ({
      configured: false,
      source: null,
      checkedPaths: [],
      credentialDatabasePaths: [],
    }));
    const stateResult = await queryKiloQuota({
      requestTimeoutMs: ctx.config?.requestTimeoutMs,
    });
    const keyStatusDetails = simpleApiKeyStatusDetails(diagnostics);

    if (!stateResult) {
      return withStatusDetails(notAttemptedResult(), keyStatusDetails);
    }
    if (!stateResult.success) {
      return withStatusDetails(
        {
          attempted: true,
          entries: [],
          errors: [{ label: "Kilo Gateway", message: stateResult.error }],
        },
        keyStatusDetails,
      );
    }

    const providerResult =
      stateResult.mode === "kilo_pass"
        ? mapKiloPassSuccess(stateResult)
        : mapKiloBalanceSuccess(stateResult);

    return withStatusDetails(providerResult, [
      ...keyStatusDetails,
      ...(providerResult.statusDetails ?? []),
    ]);
  },
};
