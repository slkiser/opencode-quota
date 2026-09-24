/**
 * DeepSeek provider wrapper.
 *
 * Queries the DeepSeek /user/balance endpoint and maps exact source decimals
 * into provider-neutral accounting rows.
 */

import {
  getDeepSeekKeyDiagnostics,
  hasDeepSeekApiKeyConfigured,
  queryDeepSeekBalance,
} from "../lib/deepseek.js";
import type {
  AccountingComponent,
  AccountingMetadata,
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { modelProviderIncludesAny } from "../lib/provider-model-matching.js";
import {
  attemptedResult,
  mapNullableProviderResult,
  simpleApiKeyStatusDetails,
  withStatusDetails,
} from "./result-helpers.js";

const DEEPSEEK_GROUP = "DeepSeek";
const BALANCE_ACCOUNTING: AccountingMetadata = {
  resultType: "balance",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
};
const STATUS_ACCOUNTING: AccountingMetadata = {
  ...BALANCE_ACCOUNTING,
  resultType: "status",
};

type DeepSeekBalanceSuccess = Extract<
  NonNullable<Awaited<ReturnType<typeof queryDeepSeekBalance>>>,
  { success: true }
>;

function buildDeepSeekResult(result: DeepSeekBalanceSuccess): QuotaProviderResult {
  const entries: QuotaToastEntry[] = [];
  let hasTotalBalance = false;

  for (const info of result.balanceInfos) {
    const unit = { kind: "currency", code: info.currency } as const;
    const rows: Array<{
      component: AccountingComponent;
      decimal: string | undefined;
      prominence: "primary" | "supplementary";
    }> = [
      {
        component: "total_balance",
        decimal: info.totalBalance,
        prominence: "primary",
      },
      {
        component: "granted_balance",
        decimal: info.grantedBalance,
        prominence: "supplementary",
      },
      {
        component: "topped_up_balance",
        decimal: info.toppedUpBalance,
        prominence: "supplementary",
      },
    ];

    for (const row of rows) {
      if (row.decimal === undefined) continue;
      if (row.component === "total_balance") hasTotalBalance = true;
      entries.push({
        kind: "quantity",
        accounting: BALANCE_ACCOUNTING,
        name: `deepseek-${info.currency.toLowerCase()}-${row.component.replaceAll("_", "-")}`,
        group: DEEPSEEK_GROUP,
        semantic: {
          metric: { kind: "component", component: row.component },
          prominence: row.prominence,
        },
        quantity: { decimal: row.decimal, unit },
      });
    }
  }

  if (!hasTotalBalance && result.isAvailable !== undefined) {
    entries.push({
      kind: "boolean",
      accounting: STATUS_ACCOUNTING,
      name: "deepseek-availability",
      group: DEEPSEEK_GROUP,
      semantic: {
        metric: { kind: "named", name: "Availability" },
        prominence: "primary",
      },
      value: result.isAvailable,
    });
  }

  return attemptedResult(
    entries,
    result.parseIssues.map((issue) => ({
      label: `DeepSeek ${issue.currency}`,
      message: `${issue.field} returned an invalid decimal`,
    })),
  );
}

export const deepseekProvider: QuotaProvider = {
  id: "deepseek",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    // Check if the deepseek provider exists in opencode config
    const providerAvailable = await isCanonicalProviderAvailable({
      ctx,
      providerId: "deepseek",
      fallbackOnError: false,
    });
    if (providerAvailable) return true;

    return await hasDeepSeekApiKeyConfigured();
  },

  matchesCurrentModel(model: string): boolean {
    return modelProviderIncludesAny(model, ["deepseek"]);
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const diagnostics = await getDeepSeekKeyDiagnostics().catch(() => ({
      configured: false,
      source: null,
      checkedPaths: [],
      credentialDatabasePaths: [],
    }));
    const result = await queryDeepSeekBalance({ requestTimeoutMs: ctx.config?.requestTimeoutMs });
    const providerResult = mapNullableProviderResult(result, {
      errorLabel: "DeepSeek",
      onSuccess: buildDeepSeekResult,
    });
    return withStatusDetails(providerResult, simpleApiKeyStatusDetails(diagnostics));
  },
};
