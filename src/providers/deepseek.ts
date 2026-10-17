/**
 * DeepSeek: the exact balances GET https://api.deepseek.com/user/balance reports, per currency.
 * Each key stored in OpenCode is queried as its own account; an env or config key is used alone.
 */

import { isCanonicalAccountingDecimal } from "../lib/accounting-format.js";
import { API_KEY_VENDORS, readVendorKeys } from "../lib/api-key-resolver.js";
import { sanitizeDisplaySnippet, sanitizeDisplayText } from "../lib/display-sanitize.js";
import type { QuotaProvider, QuotaProviderContext } from "../lib/entries.js";
import { failureFacts, requestJson } from "../lib/http.js";
import { isRecord, nonEmptyString } from "../lib/json-guards.js";
import { modelProviderIncludesAny } from "../lib/provider-model-matching.js";
import type { QuotaError } from "../lib/types.js";
import { vendorKeysPolicy } from "./cache-policies.js";
import {
  type AccountResult,
  failedAccount,
  fetchError,
  keySlug,
  type ProviderFetchResult,
  type ProviderRow,
} from "./contract.js";
import { fetchStoredKeys, isKeyVendorAvailable } from "./key-vendor.js";
import { vendorKeyDetails } from "./result-helpers.js";

const LABEL = "DeepSeek";
const SPEC = API_KEY_VENDORS.deepseek;
const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
const USER_AGENT = "OpenCode-Quota-Toast/1.0";
const MAX_PARSE_ISSUES = 6;

const BALANCE_COMPONENTS = [
  ["total_balance", "Balance", "primary"],
  ["granted_balance", "Granted", "supplementary"],
  ["topped_up_balance", "Topped up", "supplementary"],
] as const;

/** A balance field DeepSeek sent that is not a decimal. */
type ParseIssue = { currency: string; field: (typeof BALANCE_COMPONENTS)[number][0] };

type DeepSeekBalance = { success: true; rows: ProviderRow[]; parseIssues: ParseIssue[] };

/** One row per balance of each CNY or USD entry; the availability flag without a total. */
function parseDeepSeekBalance(payload: unknown): DeepSeekBalance {
  if (!isRecord(payload)) {
    throw new Error("DeepSeek balance response returned an unexpected response shape");
  }

  const rows: ProviderRow[] = [];
  const parseIssues: ParseIssue[] = [];
  const infos = Array.isArray(payload.balance_infos) ? payload.balance_infos : [];
  for (const info of infos) {
    if (!isRecord(info)) continue;
    const currency = nonEmptyString(info.currency)?.toUpperCase();
    if (currency !== "CNY" && currency !== "USD") continue;
    for (const [field, label, prominence] of BALANCE_COMPONENTS) {
      const decimal = info[field];
      if (typeof decimal === "string" && isCanonicalAccountingDecimal(decimal)) {
        rows.push({
          key: `${field}.${keySlug(currency)}`,
          label,
          type: "balance",
          method: "remote_api",
          authority: "provider_reported",
          prominence,
          amount: { decimal, unit: { kind: "currency", code: currency } },
        });
      } else if (decimal !== undefined && parseIssues.length < MAX_PARSE_ISSUES) {
        parseIssues.push({ currency, field });
      }
    }
  }

  // Without any total balance, the availability flag stands in for it.
  const hasTotalBalance = rows.some((row) => row.key.startsWith("total_balance."));
  if (!hasTotalBalance && typeof payload.is_available === "boolean") {
    rows.push({
      key: "available",
      label: "Available",
      type: "status",
      method: "remote_api",
      authority: "provider_reported",
      prominence: "primary",
      flag: payload.is_available,
    });
  }
  return { success: true, rows, parseIssues };
}

/** The DeepSeek balance of one API key. */
async function queryDeepSeekBalance(
  apiKey: string,
  requestTimeoutMs?: number,
): Promise<DeepSeekBalance | QuotaError> {
  const reply = await requestJson(DEEPSEEK_BALANCE_URL, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": USER_AGENT },
    secrets: [apiKey],
    timeoutMs: requestTimeoutMs,
  });
  if (!reply.ok) {
    const { failure } = reply;
    return {
      success: false,
      error:
        failure.kind === "http"
          ? `DeepSeek API error ${failure.status}: ${sanitizeDisplaySnippet(failure.detail, 120)}`
          : failure.detail,
      facts: failureFacts(failure),
    };
  }
  try {
    return parseDeepSeekBalance(reply.json);
  } catch (err) {
    return {
      success: false,
      error: sanitizeDisplayText(err instanceof Error ? err.message : String(err)),
    };
  }
}

/** An env or config key: a value DeepSeek sent that is not a decimal is an account of its own. */
function deepseekAccounts(balance: DeepSeekBalance): AccountResult[] {
  return [
    { name: LABEL, rows: balance.rows, errors: [] },
    ...balance.parseIssues.map((issue) =>
      failedAccount(`${LABEL} ${issue.currency}`, `${issue.field} returned an invalid decimal`),
    ),
  ];
}

export const deepseekProvider: QuotaProvider = {
  id: "deepseek",
  cachePolicy: vendorKeysPolicy("deepseek"),

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    return await isKeyVendorAvailable({
      ctx,
      providerId: "deepseek",
      availability: "listed-or-key",
      readKeys: () => readVendorKeys(SPEC),
    });
  },

  matchesCurrentModel(model: string): boolean {
    return modelProviderIncludesAny(model, ["deepseek"]);
  },

  async fetch(ctx: QuotaProviderContext): Promise<ProviderFetchResult> {
    const keys = await readVendorKeys(SPEC);
    const debug = vendorKeyDetails(SPEC, keys);
    const query = (apiKey: string) => queryDeepSeekBalance(apiKey, ctx.config?.requestTimeoutMs);

    if (keys.envOrConfig) {
      const result = await query(keys.envOrConfig.key);
      const accounts = result.success
        ? deepseekAccounts(result)
        : [failedAccount(LABEL, result.error, result.facts)];
      return { attempted: true, accounts, debug };
    }

    const { attempted, accounts } = await fetchStoredKeys({
      providerName: LABEL,
      keys,
      brokenFirst: false,
      async fetchKey(apiKey) {
        const result = await query(apiKey);
        if (!result.success) return { rows: [], errors: [fetchError(result.error, result.facts)] };
        return {
          rows: result.rows,
          errors: result.parseIssues.map((issue) => ({
            message: `${issue.currency} ${issue.field} returned an invalid decimal`,
          })),
        };
      },
    });
    return { attempted, accounts, debug };
  },
};
