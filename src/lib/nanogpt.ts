/**
 * NanoGPT quota fetcher
 *
 * Resolves API key from multiple sources and queries:
 * https://nano-gpt.com/api/subscription/v1/usage
 */

import type { NanoGptResult } from "./types.js";
import { fetchWithTimeout } from "./http.js";
import { clampPercent } from "./format-utils.js";
import {
  resolveNanoGptApiKey,
  hasNanoGptApiKey,
  getNanoGptKeyDiagnostics,
  type NanoGptKeySource,
} from "./nanogpt-config.js";

interface NanoGptUsageWindow {
  used: number;
  remaining: number;
  percentUsed: number;
  resetAt: number;
}

interface NanoGptQuotaResponse {
  active: boolean;
  limits: {
    daily: number;
    monthly: number;
  };
  enforceDailyLimit: boolean;
  daily: NanoGptUsageWindow;
  monthly: NanoGptUsageWindow;
  period?: {
    currentPeriodEnd?: string;
  };
  state: string;
  graceUntil?: string | null;
}

type NanoGptApiAuth = {
  type: "api";
  key: string;
  source: NanoGptKeySource;
};

async function readNanoGptAuth(): Promise<NanoGptApiAuth | null> {
  const result = await resolveNanoGptApiKey();
  if (!result) return null;
  return { type: "api", key: result.key, source: result.source };
}

const NANOGPT_QUOTA_URL = "https://nano-gpt.com/api/subscription/v1/usage";

export async function hasNanoGptApiKeyConfigured(): Promise<boolean> {
  return await hasNanoGptApiKey();
}

export { getNanoGptKeyDiagnostics, type NanoGptKeySource } from "./nanogpt-config.js";

export async function queryNanoGptQuota(): Promise<NanoGptResult> {
  const auth = await readNanoGptAuth();
  if (!auth) return null;

  try {
    const resp = await fetchWithTimeout(NANOGPT_QUOTA_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${auth.key}`,
        "User-Agent": "OpenCode-Quota-Toast/1.0",
      },
    });

    if (!resp.ok) {
      const text = await resp.text();
      return {
        success: false,
        error: `NanoGPT API error ${resp.status}: ${text.slice(0, 120)}`,
      };
    }

    const data = (await resp.json()) as NanoGptQuotaResponse;

    if (!data.active) {
      return {
        success: false,
        error: `NanoGPT subscription not active (state: ${data.state ?? "unknown"})`,
      };
    }

    const daily = data.daily;
    const monthly = data.monthly;

    const dailyPercentRemaining = clampPercent((1 - (daily?.percentUsed ?? 1)) * 100);
    const monthlyPercentRemaining = clampPercent((1 - (monthly?.percentUsed ?? 1)) * 100);

    const dailyResetIso = daily?.resetAt ? new Date(daily.resetAt).toISOString() : undefined;
    const monthlyResetIso = monthly?.resetAt ? new Date(monthly.resetAt).toISOString() : undefined;

    return {
      success: true,
      daily: {
        percentRemaining: dailyPercentRemaining,
        resetTimeIso: dailyResetIso,
        used: daily?.used ?? 0,
        remaining: daily?.remaining ?? 0,
        limit: data.limits?.daily ?? 0,
      },
      monthly: {
        percentRemaining: monthlyPercentRemaining,
        resetTimeIso: monthlyResetIso,
        used: monthly?.used ?? 0,
        remaining: monthly?.remaining ?? 0,
        limit: data.limits?.monthly ?? 0,
      },
      state: data.state,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
