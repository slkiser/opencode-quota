/**
 * Xiaomi MiMo: the token plan's monthly tokens and the account balance, scraped from the
 * platform.xiaomimimo.com dashboard with the user's session cookie (see `mimo-config.ts`).
 * Its usage, plan and balance endpoints are read at once; each one that fails is its own error.
 */

import type { ErrorFacts } from "../core/errors.js";
import type { AmountUnit } from "../core/types.js";
import { sanitizeSingleLineDisplaySnippet } from "../lib/display-sanitize.js";
import type { QuotaProvider, QuotaProviderContext } from "../lib/entries.js";
import { failureFacts, requestJson } from "../lib/http.js";
import { isRecord } from "../lib/json-guards.js";
import {
  DEFAULT_MIMO_CONFIG_CACHE_MAX_AGE_MS,
  getMimoConfigDiagnostics,
  resolveMimoConfigCached,
} from "../lib/mimo-config.js";
import { getQuotaProviderRuntimeIds } from "../lib/provider-metadata.js";
import { accountingDecimalFromNumber } from "./accounting-decimal.js";
import { resolvedCredentialPolicy } from "./cache-policies.js";
import {
  type AccountResult,
  failedAccount,
  MONTHLY,
  type ProviderFetchResult,
  type ProviderRow,
} from "./contract.js";
import { configStatusDetails } from "./result-helpers.js";

const MIMO_ORIGIN = "https://platform.xiaomimimo.com";
const MIMO_REQUEST_TIMEOUT_MS = 10_000;
const MIMO_RESPONSE_MAX_BYTES = 256 * 1024;
const MIMO_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

interface MimoMonthlyQuota {
  used: number;
  limit: number;
}

interface MimoPlanDetail {
  planName: string | null;
  planCode: string | null;
  expired: boolean;
}

interface MimoBalance {
  total: number | null;
  cash: number | null;
  gift: number | null;
  currency: string | null;
}

type MimoEndpointResult<T> =
  | { state: "success"; data: T }
  | { state: "error"; error: string; facts?: ErrorFacts };

interface MimoDashboardResult {
  usage: MimoEndpointResult<MimoMonthlyQuota>;
  detail: MimoEndpointResult<MimoPlanDetail>;
  balance: MimoEndpointResult<MimoBalance>;
}

type MimoRequestContext = { cookie: string; timeoutMs: number; timeZone: string };

function parseEnvelope(json: unknown): Record<string, unknown> {
  if (!isRecord(json) || json.code !== 0 || !isRecord(json.data)) {
    throw new Error("invalid envelope");
  }
  return json.data;
}

function parseNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Balances arrive as decimal strings ("50.00") or numbers; a missing or empty field is not reported. */
function parseOptionalBalance(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const amount = parseNonNegativeNumber(
    typeof value === "string" && /^\d+(?:\.\d+)?$/u.test(value.trim()) ? Number(value) : value,
  );
  if (amount === null) throw new Error("invalid balance");
  return amount;
}

function nonBlankStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function parseMimoUsageResponse(json: unknown): MimoMonthlyQuota {
  const data = parseEnvelope(json);
  if (!isRecord(data.monthUsage) || !Array.isArray(data.monthUsage.items)) {
    throw new Error("missing monthly usage");
  }

  const item = data.monthUsage.items.find(
    (candidate) => isRecord(candidate) && candidate.name === "month_total_token",
  );
  if (!isRecord(item)) throw new Error("missing monthly quota");

  const used = parseNonNegativeNumber(item.used);
  const limit = parseNonNegativeNumber(item.limit);
  if (used === null || limit === null || limit <= 0) {
    throw new Error("invalid monthly quota");
  }

  return { used, limit };
}

function parseMimoDetailResponse(json: unknown): MimoPlanDetail {
  const data = parseEnvelope(json);
  if (typeof data.expired !== "boolean") throw new Error("invalid plan state");

  return {
    planName: nonBlankStringOrNull(data.planName),
    planCode: nonBlankStringOrNull(data.planCode),
    expired: data.expired,
  };
}

function parseMimoBalanceResponse(json: unknown): MimoBalance {
  const data = parseEnvelope(json);
  return {
    total: parseOptionalBalance(data.balance),
    cash: parseOptionalBalance(data.cashBalance),
    gift: parseOptionalBalance(data.giftBalance),
    currency:
      typeof data.currency === "string" && /^[A-Za-z]{3}$/u.test(data.currency.trim())
        ? data.currency.trim().toUpperCase()
        : null,
  };
}

function formatMimoDashboardTimeZone(timezoneOffsetMinutes?: number): string {
  const javascriptOffset = timezoneOffsetMinutes ?? new Date().getTimezoneOffset();
  const utcOffset = -javascriptOffset;
  const sign = utcOffset >= 0 ? "+" : "-";
  const absoluteMinutes = Math.abs(utcOffset);
  const hours = Math.floor(absoluteMinutes / 60);
  const minutes = absoluteMinutes % 60;
  return `UTC${sign}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** The whole cookie and each cookie value, since request errors can echo them. */
function cookieSecrets(cookie: string): string[] {
  return [cookie, ...cookie.split(";").map((part) => part.slice(part.indexOf("=") + 1).trim())];
}

async function fetchMimoEndpoint<T>(
  name: "usage" | "detail" | "balance",
  path: string,
  parse: (json: unknown) => T,
  context: MimoRequestContext,
): Promise<MimoEndpointResult<T>> {
  const fail = (problem: string, facts?: ErrorFacts): MimoEndpointResult<T> => ({
    state: "error",
    error: `Xiaomi MiMo ${name} ${problem}`,
    ...(facts ? { facts } : {}),
  });

  const reply = await requestJson(`${MIMO_ORIGIN}/api/v1${path}`, {
    method: "GET",
    redirect: "manual",
    headers: {
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      Cookie: context.cookie,
      Origin: MIMO_ORIGIN,
      Referer: `${MIMO_ORIGIN}/#/console/balance`,
      "User-Agent": MIMO_USER_AGENT,
      "x-timeZone": context.timeZone,
    },
    secrets: cookieSecrets(context.cookie),
    timeoutMs: context.timeoutMs,
    maxBytes: MIMO_RESPONSE_MAX_BYTES,
  });
  if (!reply.ok) {
    const { failure } = reply;
    if (failure.kind === "http" && failure.status !== undefined) {
      // A redirect goes to the sign-in page.
      if (failure.status >= 300 && failure.status < 400) {
        return fail("request requires login", failureFacts(failure, "login_expired"));
      }
      return fail(`request failed (HTTP ${failure.status})`, failureFacts(failure));
    }
    if (failure.kind === "too_large" || failure.kind === "invalid_json") {
      return fail("response could not be parsed", failureFacts(failure));
    }
    const detail = sanitizeSingleLineDisplaySnippet(failure.detail, 120) || "request failed";
    return fail(`request failed: ${detail}`, failureFacts(failure));
  }

  try {
    return { state: "success", data: parse(reply.json) };
  } catch {
    return fail("response did not match the expected schema");
  }
}

async function queryMimoDashboard(
  cookie: string,
  options: { requestTimeoutMs?: number } = {},
): Promise<MimoDashboardResult> {
  const context: MimoRequestContext = {
    cookie,
    timeoutMs: options.requestTimeoutMs ?? MIMO_REQUEST_TIMEOUT_MS,
    timeZone: formatMimoDashboardTimeZone(),
  };
  const [usage, detail, balance] = await Promise.all([
    fetchMimoEndpoint("usage", "/tokenPlan/usage", parseMimoUsageResponse, context),
    fetchMimoEndpoint("detail", "/tokenPlan/detail", parseMimoDetailResponse, context),
    fetchMimoEndpoint("balance", "/balance", parseMimoBalanceResponse, context),
  ]);
  return { usage, detail, balance };
}

const MIMO_LABEL = "Xiaomi MiMo";
const MIMO_RUNTIME_IDS = new Set(getQuotaProviderRuntimeIds("xiaomi"));
const TOKEN_UNIT = { kind: "count", unit: "token" } as const;
const MIMO_ROW = { method: "dashboard_scrape", authority: "provider_reported" } as const;

function getPlanDisplay(detail: MimoEndpointResult<MimoPlanDetail>): string | null {
  if (detail.state !== "success" || detail.data.expired) return null;

  const planName = detail.data.planName
    ? sanitizeSingleLineDisplaySnippet(detail.data.planName, 40)
    : "";
  const planCode = detail.data.planCode
    ? sanitizeSingleLineDisplaySnippet(detail.data.planCode, 32)
    : "";

  if (planName && planCode && planName.toLowerCase() !== planCode.toLowerCase()) {
    return `${planName} [${planCode}]`;
  }
  return planName || planCode || null;
}

function balanceRows(balance: MimoBalance): ProviderRow[] {
  const unit: AmountUnit = balance.currency
    ? { kind: "currency", code: balance.currency }
    : { kind: "count", unit: "credit" };
  const components = [
    { key: "total_balance", label: "Balance", amount: balance.total, prominence: "primary" },
    { key: "cash_balance", label: "Cash", amount: balance.cash, prominence: "supplementary" },
    { key: "gift_balance", label: "Gift", amount: balance.gift, prominence: "supplementary" },
  ] as const;
  return components.flatMap(({ key, label, amount, prominence }) =>
    amount === null
      ? []
      : [
          {
            ...MIMO_ROW,
            key,
            label,
            type: "balance",
            prominence,
            amount: { decimal: accountingDecimalFromNumber(amount), unit },
          } as const,
        ],
  );
}

/** The plan's account (named after the plan when it has one), then each failed endpoint. */
function mimoAccounts(result: MimoDashboardResult): AccountResult[] {
  const plan = getPlanDisplay(result.detail);
  const rows: ProviderRow[] = [];
  if (
    result.usage.state === "success" &&
    !(result.detail.state === "success" && result.detail.data.expired)
  ) {
    const { used, limit } = result.usage.data;
    rows.push({
      ...MIMO_ROW,
      key: "monthly_tokens",
      label: MONTHLY.label,
      window: MONTHLY.window,
      type: "quota",
      prominence: "primary",
      percentRemaining: 100 - (used / limit) * 100,
      used: { decimal: accountingDecimalFromNumber(used), unit: TOKEN_UNIT },
      limit: { decimal: accountingDecimalFromNumber(limit), unit: TOKEN_UNIT },
    });
  }
  if (result.balance.state === "success") rows.push(...balanceRows(result.balance.data));

  return [
    { name: plan ? `${MIMO_LABEL}: ${plan}` : MIMO_LABEL, rows, errors: [] },
    ...[result.usage, result.detail, result.balance].flatMap((endpoint) =>
      endpoint.state === "error" ? [failedAccount(MIMO_LABEL, endpoint.error, endpoint.facts)] : [],
    ),
  ];
}

export const xiaomiProvider: QuotaProvider = {
  id: "xiaomi",
  cachePolicy: resolvedCredentialPolicy("xiaomi", async () => {
    const resolved = await resolveMimoConfigCached({
      maxAgeMs: DEFAULT_MIMO_CONFIG_CACHE_MAX_AGE_MS,
    });
    return resolved.state === "configured" ? { credential: resolved.config.cookie } : null;
  }),

  async isAvailable(_ctx: QuotaProviderContext): Promise<boolean> {
    const config = await resolveMimoConfigCached();
    return config.state === "configured";
  },

  matchesCurrentModel(model: string): boolean {
    const [provider] = model.trim().toLowerCase().split("/", 2);
    return MIMO_RUNTIME_IDS.has(provider);
  },

  async fetch(ctx: QuotaProviderContext): Promise<ProviderFetchResult> {
    const diagnostics = await getMimoConfigDiagnostics();
    const debug = configStatusDetails({
      ...diagnostics,
      error: diagnostics.error
        ? sanitizeSingleLineDisplaySnippet(diagnostics.error, 120)
        : undefined,
    });
    const config = await resolveMimoConfigCached();

    if (config.state === "none") return { attempted: false, accounts: [], debug };
    if (config.state === "invalid") {
      return {
        attempted: true,
        accounts: [failedAccount(MIMO_LABEL, `Invalid config (${config.source}): ${config.error}`)],
        debug,
      };
    }

    const result = await queryMimoDashboard(config.config.cookie, {
      requestTimeoutMs: ctx.config?.requestTimeoutMsConfigured
        ? ctx.config.requestTimeoutMs
        : undefined,
    });
    return { attempted: true, accounts: mimoAccounts(result), debug };
  },
};
