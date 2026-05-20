/**
 * DeepSeek balance fetcher.
 *
 * Queries: GET https://api.deepseek.com/user/balance
 * Auth: Bearer token in Authorization header.
 */

import type { QuotaError } from "./types.js";
import { sanitizeDisplaySnippet, sanitizeDisplayText } from "./display-sanitize.js";
import { fetchWithTimeout } from "./http.js";
import {
  resolveDeepSeekApiKey,
  hasDeepSeekApiKey,
  type DeepSeekKeySource,
} from "./deepseek-auth.js";

export type DeepSeekCurrency = "CNY" | "USD";

export interface DeepSeekBalanceInfo {
  currency: DeepSeekCurrency;
  totalBalance: string;
  grantedBalance: string;
  toppedUpBalance: string;
}

export interface DeepSeekBalanceResult {
  isAvailable: boolean;
  balanceInfos: DeepSeekBalanceInfo[];
}

export type DeepSeekResult =
  | {
      success: true;
      isAvailable: boolean;
      balanceInfos: DeepSeekBalanceInfo[];
    }
  | QuotaError
  | null;

const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
const USER_AGENT = "OpenCode-Quota-Toast/1.0";

const CURRENCY_SYMBOLS: Record<string, string> = {
  CNY: "\u00A5",    // ¥
  USD: "$",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseDeepSeekBalance(payload: unknown): DeepSeekBalanceResult {
  if (!isRecord(payload)) {
    throw new Error("DeepSeek balance response returned an unexpected response shape");
  }

  const isAvailable = typeof payload.is_available === "boolean" ? payload.is_available : false;

  const balanceInfos: DeepSeekBalanceInfo[] = [];
  const rawInfos = payload.balance_infos;

  if (Array.isArray(rawInfos)) {
    for (const info of rawInfos) {
      if (!isRecord(info)) continue;

      const currency = getNonEmptyString(info.currency);
      if (!currency || !["CNY", "USD"].includes(currency.toUpperCase())) continue;

      balanceInfos.push({
        currency: currency.toUpperCase() as DeepSeekCurrency,
        totalBalance: getNonEmptyString(info.total_balance) ?? "0.00",
        grantedBalance: getNonEmptyString(info.granted_balance) ?? "0.00",
        toppedUpBalance: getNonEmptyString(info.topped_up_balance) ?? "0.00",
      });
    }
  }

  return { isAvailable, balanceInfos };
}

async function fetchDeepSeekBalance(
  apiKey: string,
  requestTimeoutMs?: number,
): Promise<
  | { success: true; data: DeepSeekBalanceResult }
  | { success: false; message: string }
> {
  try {
    const response = await fetchWithTimeout(
      DEEPSEEK_BALANCE_URL,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "User-Agent": USER_AGENT,
        },
      },
      requestTimeoutMs,
    );

    if (!response.ok) {
      const text = await response.text();
      return {
        success: false,
        message: `DeepSeek API error ${response.status}: ${sanitizeDisplaySnippet(text, 120)}`,
      };
    }

    return {
      success: true,
      data: parseDeepSeekBalance(await response.json()),
    };
  } catch (err) {
    return {
      success: false,
      message: sanitizeDisplayText(err instanceof Error ? err.message : String(err)),
    };
  }
}

/**
 * Format a balance value with the appropriate currency symbol.
 */
export function formatDeepSeekBalanceValue(balance: {
  currency: DeepSeekCurrency;
  totalBalance: string;
}): string {
  const symbol = CURRENCY_SYMBOLS[balance.currency] ?? balance.currency;
  return `${symbol}${balance.totalBalance}`;
}

/**
 * Query DeepSeek balance from the API.
 *
 * @returns A typed result with success/error state, or null if no API key is configured.
 */
export async function queryDeepSeekBalance(options: {
  requestTimeoutMs?: number;
} = {}): Promise<DeepSeekResult> {
  const resolved = await resolveDeepSeekApiKey();
  if (!resolved) return null;

  const result = await fetchDeepSeekBalance(resolved.key, options.requestTimeoutMs);

  if (!result.success) {
    return { success: false, error: result.message };
  }

  return {
    success: true,
    isAvailable: result.data.isAvailable,
    balanceInfos: result.data.balanceInfos,
  };
}

export {
  getDeepSeekKeyDiagnostics,
  hasDeepSeekApiKey as hasDeepSeekApiKeyConfigured,
  type DeepSeekKeySource,
} from "./deepseek-auth.js";
