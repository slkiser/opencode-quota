/**
 * Neuralwatt live quota fetcher.
 *
 * Queries:
 * - https://api.neuralwatt.com/v1/quota
 *
 * Returns account balance, usage, limits, subscription state (kWh allowance),
 * and per-key spending allowance.
 */

import type { QuotaError } from "./types.js";
import { sanitizeDisplaySnippet, sanitizeDisplayText } from "./display-sanitize.js";
import { clampPercent, fmtUsdAmount } from "./format-utils.js";
import { fetchWithTimeout } from "./http.js";
import {
  getNeuralwattKeyDiagnostics,
  resolveNeuralwattApiKey,
  type NeuralwattKeySource,
} from "./neuralwatt-config.js";

type NeuralwattRecord = Record<string, unknown>;

/**
 * A normalized percent window with a reset time. Used for the subscription
 * kWh allowance and the per-key spending allowance.
 */
export interface NeuralwattUsageWindow {
  used: number;
  limit: number;
  remaining: number;
  percentRemaining: number;
  resetTimeIso?: string;
}

export interface NeuralwattSubscription {
  active: boolean;
  state: string;
  billingInterval?: string;
  currentPeriodStartIso?: string;
  currentPeriodEndIso?: string;
  autoRenew?: boolean;
  /** Charged kWh allowance window for the current billing period. */
  kwh?: NeuralwattUsageWindow;
  inOverage?: boolean;
}

export interface NeuralwattKeyAllowance {
  limitUsd: number;
  spentUsd: number;
  remainingUsd: number;
  period: string;
  blocked: boolean;
  /** Percent remaining for the current period. */
  window: NeuralwattUsageWindow;
}

export interface NeuralwattBalance {
  creditsRemainingUsd?: number;
  totalCreditsUsd?: number;
  creditsUsedUsd?: number;
  accountingMethod?: string;
}

export interface NeuralwattUsageTotals {
  costUsd?: number;
  requests?: number;
  tokens?: number;
  energyKwh?: number;
}

export type NeuralwattResult =
  | {
      success: true;
      balance?: NeuralwattBalance;
      subscription?: NeuralwattSubscription;
      keyAllowance?: NeuralwattKeyAllowance;
      lifetimeUsage?: NeuralwattUsageTotals;
      currentMonthUsage?: NeuralwattUsageTotals;
    }
  | QuotaError
  | null;

interface NeuralwattQuotaResponse {
  snapshot_at?: string;
  balance?: {
    credits_remaining_usd?: number;
    total_credits_usd?: number;
    credits_used_usd?: number;
    accounting_method?: string;
  };
  usage?: {
    lifetime?: NeuralwattUsageTotalsResponse;
    current_month?: NeuralwattUsageTotalsResponse;
  };
  limits?: {
    overage_limit_usd?: number | null;
    rate_limit_tier?: string;
  };
  subscription?: {
    plan?: string;
    status?: string;
    billing_interval?: string | null;
    current_period_start?: string | null;
    current_period_end?: string | null;
    auto_renew?: boolean | null;
    kwh_included?: number | null;
    kwh_used?: number | null;
    kwh_remaining?: number | null;
    in_overage?: boolean | null;
  } | null;
  key?: {
    name?: string | null;
    allowance?: {
      limit_usd?: number;
      period?: string;
      spent_usd?: number;
      remaining_usd?: number;
      blocked?: boolean;
    } | null;
  };
}

interface NeuralwattUsageTotalsResponse {
  cost_usd?: number;
  requests?: number;
  tokens?: number;
  energy_kwh?: number;
}

const USER_AGENT = "OpenCode-Quota-Toast/1.0";
const NEURALWATT_QUOTA_URL = "https://api.neuralwatt.com/v1/quota";

function isRecord(value: unknown): value is NeuralwattRecord {
  return Boolean(value) && typeof value === "object";
}

function getFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function getIsoString(value: unknown): string | undefined {
  const raw = getNonEmptyString(value);
  if (!raw) return undefined;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

function getBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeAllowanceWindow(
  used: number,
  limit: number,
  remaining: number,
  fallbackResetTimeIso?: string,
): NeuralwattUsageWindow {
  const safeLimit = limit > 0 ? limit : used + remaining;
  const percentRemaining =
    safeLimit > 0 ? clampPercent((Math.max(0, remaining) / safeLimit) * 100) : 0;
  return {
    used,
    limit: safeLimit,
    remaining: Math.max(0, remaining),
    percentRemaining,
    resetTimeIso: fallbackResetTimeIso,
  };
}

function parseBalance(payload: unknown): NeuralwattBalance | undefined {
  if (!isRecord(payload)) return undefined;
  const creditsRemainingUsd = getFiniteNumber(payload.credits_remaining_usd);
  const totalCreditsUsd = getFiniteNumber(payload.total_credits_usd);
  const creditsUsedUsd = getFiniteNumber(payload.credits_used_usd);
  const accountingMethod = getNonEmptyString(payload.accounting_method);
  if (
    creditsRemainingUsd === undefined &&
    totalCreditsUsd === undefined &&
    creditsUsedUsd === undefined &&
    accountingMethod === undefined
  ) {
    return undefined;
  }
  return {
    creditsRemainingUsd,
    totalCreditsUsd,
    creditsUsedUsd,
    accountingMethod,
  };
}

function parseUsageTotals(payload: unknown): NeuralwattUsageTotals | undefined {
  if (!isRecord(payload)) return undefined;
  const costUsd = getFiniteNumber(payload.cost_usd);
  const requests = getFiniteNumber(payload.requests);
  const tokens = getFiniteNumber(payload.tokens);
  const energyKwh = getFiniteNumber(payload.energy_kwh);
  if (
    costUsd === undefined &&
    requests === undefined &&
    tokens === undefined &&
    energyKwh === undefined
  ) {
    return undefined;
  }
  return {
    costUsd,
    requests: requests !== undefined ? Math.trunc(requests) : undefined,
    tokens: tokens !== undefined ? Math.trunc(tokens) : undefined,
    energyKwh,
  };
}

function parseSubscription(payload: unknown): {
  subscription?: NeuralwattSubscription;
  error?: string;
} {
  if (payload === null || payload === undefined) return {};
  if (!isRecord(payload)) {
    return { error: "Neuralwatt subscription returned an unexpected response shape" };
  }
  const data = payload as NonNullable<NeuralwattQuotaResponse["subscription"]>;
  const status = getNonEmptyString(data.status);
  const kwhIncluded = getFiniteNumber(data.kwh_included);
  const currentPeriodEndIso = getIsoString(data.current_period_end);

  let kwh: NeuralwattUsageWindow | undefined;
  if (kwhIncluded !== undefined && kwhIncluded > 0) {
    const kwhUsed = getFiniteNumber(data.kwh_used) ?? 0;
    const kwhRemainingRaw = getFiniteNumber(data.kwh_remaining);
    const kwhRemaining =
      kwhRemainingRaw !== undefined ? kwhRemainingRaw : Math.max(0, kwhIncluded - kwhUsed);
    kwh = normalizeAllowanceWindow(kwhUsed, kwhIncluded, kwhRemaining, currentPeriodEndIso);
  }

  const subscription: NeuralwattSubscription = {
    active: status === "active",
    state: status ?? "unknown",
    billingInterval: getNonEmptyString(data.billing_interval) ?? undefined,
    currentPeriodStartIso: getIsoString(data.current_period_start),
    currentPeriodEndIso,
    autoRenew: getBoolean(data.auto_renew),
    kwh,
    inOverage: getBoolean(data.in_overage),
  };

  return { subscription };
}

function parseKeyAllowance(payload: unknown): {
  keyAllowance?: NeuralwattKeyAllowance;
  error?: string;
} {
  if (!isRecord(payload)) return {};
  const allowance = payload.allowance;
  if (allowance === null || allowance === undefined) return {};
  if (!isRecord(allowance)) {
    return { error: "Neuralwatt key allowance returned an unexpected response shape" };
  }

  const limitUsd = getFiniteNumber(allowance.limit_usd);
  const spentUsd = getFiniteNumber(allowance.spent_usd);
  const remainingUsd = getFiniteNumber(allowance.remaining_usd);
  const period = getNonEmptyString(allowance.period);
  if (limitUsd === undefined || spentUsd === undefined || remainingUsd === undefined) {
    return { error: "Neuralwatt key allowance returned an unexpected response shape" };
  }

  const window = normalizeAllowanceWindow(spentUsd, limitUsd, remainingUsd);
  return {
    keyAllowance: {
      limitUsd,
      spentUsd,
      remainingUsd,
      period: period ?? "unknown",
      blocked: getBoolean(allowance.blocked) ?? false,
      window,
    },
  };
}

function parseNeuralwattQuota(
  payload: unknown,
): { success: true } & Omit<NeuralwattResult & { success: true }, "success"> {
  if (!isRecord(payload)) {
    throw new Error("Neuralwatt quota response returned an unexpected response shape");
  }

  const data = payload as NeuralwattQuotaResponse;
  const balance = parseBalance(data.balance);
  const lifetimeUsage = parseUsageTotals(data.usage?.lifetime);
  const currentMonthUsage = parseUsageTotals(data.usage?.current_month);
  const { subscription, error: subscriptionError } = parseSubscription(data.subscription);
  const { keyAllowance, error: keyAllowanceError } = parseKeyAllowance(data.key);

  if (!balance && !subscription && !keyAllowance && !lifetimeUsage && !currentMonthUsage) {
    throw new Error("Neuralwatt quota response returned an unexpected response shape");
  }

  const errors: string[] = [];
  if (subscriptionError) errors.push(subscriptionError);
  if (keyAllowanceError) errors.push(keyAllowanceError);
  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }

  return {
    success: true,
    balance,
    subscription,
    keyAllowance,
    lifetimeUsage,
    currentMonthUsage,
  };
}

async function fetchNeuralwattQuota(
  headers: Record<string, string>,
  requestTimeoutMs?: number,
): Promise<{ success: true; payload: unknown } | { success: false; message: string }> {
  try {
    const response = await fetchWithTimeout(
      NEURALWATT_QUOTA_URL,
      {
        method: "GET",
        headers,
      },
      requestTimeoutMs,
    );
    if (!response.ok) {
      const text = await response.text();
      const retryAfter = response.headers.get("Retry-After");
      const suffix =
        response.status === 429 && retryAfter ? ` (rate limited; retry after ${retryAfter}s)` : "";
      return {
        success: false,
        message: `Neuralwatt API error ${response.status}${suffix}: ${sanitizeDisplaySnippet(
          text,
          120,
        )}`,
      };
    }

    return { success: true, payload: await response.json() };
  } catch (err) {
    return {
      success: false,
      message: sanitizeDisplayText(err instanceof Error ? err.message : String(err)),
    };
  }
}

export { getNeuralwattKeyDiagnostics, type NeuralwattKeySource } from "./neuralwatt-config.js";

export function formatNeuralwattBalanceValue(balance: {
  creditsRemainingUsd?: number;
}): string | null {
  if (
    typeof balance.creditsRemainingUsd === "number" &&
    Number.isFinite(balance.creditsRemainingUsd)
  ) {
    return fmtUsdAmount(balance.creditsRemainingUsd);
  }
  return null;
}

function fmtKwh(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return `${value.toFixed(2).replace(/\.?0+$/, "")} kWh`;
}

export function formatNeuralwattKwhRight(window: { used: number; limit: number }): string {
  return `${fmtKwh(window.used)}/${fmtKwh(window.limit)}`;
}

export async function queryNeuralwattQuota(
  options: { requestTimeoutMs?: number } = {},
): Promise<NeuralwattResult> {
  const resolved = await resolveNeuralwattApiKey();
  if (!resolved) return null;

  const headers = {
    Authorization: `Bearer ${resolved.key}`,
    "User-Agent": USER_AGENT,
  };

  const result = await fetchNeuralwattQuota(headers, options.requestTimeoutMs);
  if (!result.success) {
    return { success: false, error: result.message };
  }

  try {
    return parseNeuralwattQuota(result.payload);
  } catch (err) {
    return {
      success: false,
      error: sanitizeDisplayText(err instanceof Error ? err.message : String(err)),
    };
  }
}
