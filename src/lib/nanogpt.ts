/**
 * NanoGPT live quota and balance fetcher.
 *
 * Queries:
 * - https://nano-gpt.com/api/subscription/v1/usage
 * - https://nano-gpt.com/api/check-balance
 */

import type { QuotaError } from "./types.js";
import { sanitizeDisplaySnippet, sanitizeDisplayText } from "./display-sanitize.js";
import { clampPercent, fmtUsdAmount } from "./format-utils.js";
import { fetchWithTimeout } from "./http.js";
import {
  getNanoGptKeyDiagnostics,
  resolveNanoGptApiKey,
  hasNanoGptApiKey,
  type NanoGptKeySource,
} from "./nanogpt-config.js";

type NanoGptRecord = Record<string, unknown>;

export type NanoGptEndpoint = "usage" | "balance";

export type NanoGptUsageWindow = {
  used: number;
  limit: number;
  remaining: number;
  percentRemaining: number;
  resetTimeIso?: string;
};

export interface NanoGptSubscription {
  active: boolean;
  state: string;
  enforceDailyLimit: boolean;
  daily?: NanoGptUsageWindow;
  monthly?: NanoGptUsageWindow;
  currentPeriodEndIso?: string;
  graceUntilIso?: string;
}

export interface NanoGptBalance {
  usdBalance?: number;
  usdBalanceRaw?: string;
  nanoBalanceRaw?: string;
}

export type NanoGptResult =
  | {
      success: true;
      subscription?: NanoGptSubscription;
      balance?: NanoGptBalance;
      endpointErrors?: Array<{ endpoint: NanoGptEndpoint; message: string }>;
    }
  | QuotaError
  | null;

interface NanoGptUsageResponse {
  active?: boolean;
  limits?: {
    daily?: number;
    monthly?: number;
  };
  enforceDailyLimit?: boolean;
  daily?: {
    used?: number;
    remaining?: number;
    percentUsed?: number;
    resetAt?: number;
  };
  monthly?: {
    used?: number;
    remaining?: number;
    percentUsed?: number;
    resetAt?: number;
  };
  period?: {
    currentPeriodEnd?: string;
  };
  state?: string;
  graceUntil?: string | null;
}

interface NanoGptBalanceResponse {
  usd_balance?: string;
  nano_balance?: string;
}

const USER_AGENT = "OpenCode-Quota-Toast/1.0";
const NANOGPT_USAGE_URL = "https://nano-gpt.com/api/subscription/v1/usage";
const NANOGPT_BALANCE_URL = "https://nano-gpt.com/api/check-balance";

function isRecord(value: unknown): value is NanoGptRecord {
  return Boolean(value) && typeof value === "object";
}

function getFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getFinitePositiveNumber(value: unknown): number | undefined {
  const n = getFiniteNumber(value);
  return n !== undefined && n > 0 ? n : undefined;
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

function getIsoFromEpochMs(value: unknown): string | undefined {
  const ms = getFinitePositiveNumber(value);
  if (ms === undefined) return undefined;
  return new Date(Math.round(ms)).toISOString();
}

function normalizeUsageWindow(
  value: unknown,
  limitValue: unknown,
  fallbackResetTimeIso?: string,
): NanoGptUsageWindow | undefined {
  if (!isRecord(value)) return undefined;

  const used = getFiniteNumber(value.used);
  const remainingRaw = getFiniteNumber(value.remaining);
  const limitFromResponse = getFinitePositiveNumber(limitValue);
  const percentUsed = getFiniteNumber(value.percentUsed);

  const derivedLimit =
    limitFromResponse ??
    (used !== undefined && remainingRaw !== undefined ? used + remainingRaw : undefined);
  if (derivedLimit === undefined || derivedLimit <= 0) return undefined;

  const safeUsed = used ?? 0;
  const safeRemaining =
    remainingRaw ??
    (percentUsed !== undefined ? Math.max(0, derivedLimit * (1 - percentUsed)) : derivedLimit);
  const percentRemaining =
    safeRemaining >= 0
      ? clampPercent((safeRemaining / derivedLimit) * 100)
      : clampPercent(percentUsed !== undefined ? (1 - percentUsed) * 100 : 0);

  return {
    used: safeUsed,
    limit: derivedLimit,
    remaining: Math.max(0, safeRemaining),
    percentRemaining,
    resetTimeIso: getIsoFromEpochMs(value.resetAt) ?? fallbackResetTimeIso,
  };
}

function parseNanoGptUsage(payload: unknown): NanoGptSubscription {
  if (!isRecord(payload)) {
    throw new Error("NanoGPT usage response returned an unexpected response shape");
  }

  const data = payload as NanoGptUsageResponse;
  const currentPeriodEndIso = getIsoString(data.period?.currentPeriodEnd);
  const daily = normalizeUsageWindow(data.daily, data.limits?.daily);
  const monthly = normalizeUsageWindow(data.monthly, data.limits?.monthly, currentPeriodEndIso);
  const hasSubscriptionShape =
    typeof data.active === "boolean" ||
    typeof data.enforceDailyLimit === "boolean" ||
    Boolean(getNonEmptyString(data.state)) ||
    daily !== undefined ||
    monthly !== undefined;

  if (!hasSubscriptionShape) {
    throw new Error("NanoGPT usage response returned an unexpected response shape");
  }

  return {
    active: typeof data.active === "boolean" ? data.active : false,
    state: getNonEmptyString(data.state) ?? (data.active ? "active" : "unknown"),
    enforceDailyLimit: typeof data.enforceDailyLimit === "boolean" ? data.enforceDailyLimit : false,
    daily,
    monthly,
    currentPeriodEndIso,
    graceUntilIso: getIsoString(data.graceUntil),
  };
}

function parseNanoGptBalance(payload: unknown): NanoGptBalance {
  if (!isRecord(payload)) {
    throw new Error("NanoGPT balance response returned an unexpected response shape");
  }

  const data = payload as NanoGptBalanceResponse;
  const usdBalanceRaw = getNonEmptyString(data.usd_balance);
  const nanoBalanceRaw = getNonEmptyString(data.nano_balance);
  const usdParsed = usdBalanceRaw !== undefined ? Number.parseFloat(usdBalanceRaw) : NaN;

  if (usdBalanceRaw === undefined && nanoBalanceRaw === undefined) {
    throw new Error("NanoGPT balance response returned an unexpected response shape");
  }

  return {
    usdBalance: Number.isFinite(usdParsed) ? usdParsed : undefined,
    usdBalanceRaw,
    nanoBalanceRaw,
  };
}

async function fetchNanoGptUsage(
  headers: Record<string, string>,
  requestTimeoutMs?: number,
): Promise<
  { success: true; subscription: NanoGptSubscription } | { success: false; message: string }
> {
  try {
    return await fetchWithTimeout(NANOGPT_USAGE_URL, {
      request: {
        method: "GET",
        headers,
      },
      timeoutMs: requestTimeoutMs,
      consume: async (response) => {
        if (!response.ok) {
          const text = await response.text();
          return {
            success: false as const,
            message: `NanoGPT API error ${response.status}: ${sanitizeDisplaySnippet(text, 120)}`,
          };
        }

        return {
          success: true as const,
          subscription: parseNanoGptUsage(await response.json()),
        };
      },
    });
  } catch (err) {
    return {
      success: false,
      message: sanitizeDisplayText(err instanceof Error ? err.message : String(err)),
    };
  }
}

async function fetchNanoGptBalance(
  headers: Record<string, string>,
  requestTimeoutMs?: number,
): Promise<{ success: true; balance: NanoGptBalance } | { success: false; message: string }> {
  try {
    return await fetchWithTimeout(NANOGPT_BALANCE_URL, {
      request: {
        method: "POST",
        headers,
      },
      timeoutMs: requestTimeoutMs,
      consume: async (response) => {
        if (!response.ok) {
          const text = await response.text();
          return {
            success: false as const,
            message: `NanoGPT API error ${response.status}: ${sanitizeDisplaySnippet(text, 120)}`,
          };
        }

        return {
          success: true as const,
          balance: parseNanoGptBalance(await response.json()),
        };
      },
    });
  } catch (err) {
    return {
      success: false,
      message: sanitizeDisplayText(err instanceof Error ? err.message : String(err)),
    };
  }
}

export {
  getNanoGptKeyDiagnostics,
  hasNanoGptApiKey as hasNanoGptApiKeyConfigured,
  type NanoGptKeySource,
} from "./nanogpt-config.js";

export function formatNanoGptBalanceValue(balance: {
  usdBalance?: number;
  nanoBalanceRaw?: string;
}): string | null {
  if (typeof balance.usdBalance === "number" && Number.isFinite(balance.usdBalance)) {
    return fmtUsdAmount(balance.usdBalance);
  }

  if (balance.nanoBalanceRaw) {
    return `${balance.nanoBalanceRaw} NANO`;
  }

  return null;
}

export async function queryNanoGptQuota(
  options: { requestTimeoutMs?: number } = {},
): Promise<NanoGptResult> {
  const resolved = await resolveNanoGptApiKey();
  if (!resolved) return null;

  const headers = {
    "x-api-key": resolved.key,
    "User-Agent": USER_AGENT,
  };

  const [usageResult, balanceResult] = await Promise.all([
    fetchNanoGptUsage(headers, options.requestTimeoutMs),
    fetchNanoGptBalance(headers, options.requestTimeoutMs),
  ]);

  const endpointErrors: Array<{ endpoint: NanoGptEndpoint; message: string }> = [];
  if (!usageResult.success) {
    endpointErrors.push({ endpoint: "usage", message: usageResult.message });
  }
  if (!balanceResult.success) {
    endpointErrors.push({ endpoint: "balance", message: balanceResult.message });
  }

  if (!usageResult.success && !balanceResult.success) {
    return {
      success: false,
      error: endpointErrors
        .map((entry) => `${entry.endpoint === "usage" ? "Usage" : "Balance"}: ${entry.message}`)
        .join("; "),
    };
  }

  return {
    success: true,
    subscription: usageResult.success ? usageResult.subscription : undefined,
    balance: balanceResult.success ? balanceResult.balance : undefined,
    endpointErrors: endpointErrors.length > 0 ? endpointErrors : undefined,
  };
}
