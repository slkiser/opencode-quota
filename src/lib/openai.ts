/**
 * OpenAI (ChatGPT) quota fetcher
 *
 * Uses OpenCode's auth.json (openai oauth) and queries:
 * https://chatgpt.com/backend-api/wham/usage
 */

import type { AuthData, QuotaError } from "./types.js";
import { fetchWithTimeout } from "./http.js";
import { readAuthFile } from "./opencode-auth.js";

interface RateLimitWindow {
  used_percent: number;
  limit_window_seconds: number;
  reset_after_seconds: number;
  reset_at?: number;
}

interface OpenAIUsageResponse {
  plan_type: string;
  rate_limit: {
    limit_reached: boolean;
    primary_window: RateLimitWindow;
    secondary_window: RateLimitWindow | null;
  } | null;
  code_review_rate_limit?: {
    primary_window: RateLimitWindow | null;
  } | null;
  credits?: {
    has_credits: boolean;
    unlimited: boolean;
    balance: string | null;
  } | null;
}

interface JwtPayload {
  "https://api.openai.com/profile"?: {
    email?: string;
  };
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string;
  };
}

function base64UrlDecode(input: string): string {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (base64.length % 4)) % 4;
  const padded = base64 + "=".repeat(padLen);
  return Buffer.from(padded, "base64").toString("utf8");
}

function parseJwt(token: string): JwtPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(base64UrlDecode(parts[1])) as JwtPayload;
  } catch {
    return null;
  }
}

function getEmailFromJwt(token: string): string | null {
  return parseJwt(token)?.["https://api.openai.com/profile"]?.email ?? null;
}

function getAccountIdFromJwt(token: string): string | null {
  return parseJwt(token)?.["https://api.openai.com/auth"]?.chatgpt_account_id ?? null;
}

function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function remainingPercent(window: RateLimitWindow): number {
  return clampPercent(100 - window.used_percent);
}

function resetIsoFromNowSeconds(seconds: number): string | undefined {
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return new Date(Date.now() + Math.round(seconds * 1000)).toISOString();
}

function resetIsoFromResetAt(resetAt?: number): string | undefined {
  if (!Number.isFinite(resetAt) || !resetAt) return undefined;
  const ms = Math.round(resetAt * 1000);
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return new Date(ms).toISOString();
}

function derivePlanLabel(planType: string | undefined): string {
  const raw = (planType ?? "").toLowerCase();
  if (raw.includes("pro")) return "OpenAI (Pro)";
  if (raw.includes("plus")) return "OpenAI (Plus)";
  if (planType) return `OpenAI (${planType})`;
  return "OpenAI";
}

const OPENAI_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

export type OpenAIResult =
  | {
      success: true;
      label: string;
      email?: string;
      windows: {
        hourly?: { percentRemaining: number; resetTimeIso?: string };
        weekly?: { percentRemaining: number; resetTimeIso?: string };
        codeReview?: { percentRemaining: number; resetTimeIso?: string };
      };
      credits?: {
        hasCredits: boolean;
        unlimited: boolean;
        balance: string | null;
      };
    }
  | QuotaError
  | null;

type OpenAIOAuth = {
  type: "oauth";
  access: string;
  refresh?: string;
  expires?: number;
};

async function readOpenAIAuth(): Promise<OpenAIOAuth | null> {
  const auth = await readAuthFile();
  // Check all keys that openaiProvider.isAvailable() recognizes as OpenAI providers
  const openai = auth?.codex ?? auth?.openai ?? auth?.chatgpt ?? auth?.opencode;
  if (!openai || openai.type !== "oauth" || !openai.access) return null;
  return openai as OpenAIOAuth;
}

export async function queryOpenAIQuota(): Promise<OpenAIResult> {
  const auth = await readOpenAIAuth();
  if (!auth) return null;

  if (auth.expires && auth.expires < Date.now()) {
    return { success: false, error: "Token expired" };
  }

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${auth.access}`,
      "User-Agent": "OpenCode-Quota-Toast/1.0",
    };

    const accountId = getAccountIdFromJwt(auth.access);
    if (accountId) {
      headers["ChatGPT-Account-Id"] = accountId;
    }

    const resp = await fetchWithTimeout(OPENAI_USAGE_URL, { headers });
    if (!resp.ok) {
      const text = await resp.text();
      return {
        success: false,
        error: `OpenAI API error ${resp.status}: ${text.slice(0, 120)}`,
      };
    }

    const data = (await resp.json()) as OpenAIUsageResponse;
    const primary = data.rate_limit?.primary_window;
    const secondary = data.rate_limit?.secondary_window ?? null;
    const codeReview = data.code_review_rate_limit?.primary_window ?? null;
    const credits = data.credits ?? null;

    if (!primary) return { success: false, error: "No quota data" };

    const hourlyRemain = remainingPercent(primary);
    const weeklyRemain = secondary ? remainingPercent(secondary) : undefined;
    const codeReviewRemain = codeReview ? remainingPercent(codeReview) : undefined;

    const hourlyResetIso =
      resetIsoFromResetAt(primary.reset_at) ?? resetIsoFromNowSeconds(primary.reset_after_seconds);
    const weeklyResetIso = secondary
      ? (resetIsoFromResetAt(secondary.reset_at) ??
        resetIsoFromNowSeconds(secondary.reset_after_seconds))
      : undefined;
    const codeReviewResetIso = codeReview
      ? (resetIsoFromResetAt(codeReview.reset_at) ??
        resetIsoFromNowSeconds(codeReview.reset_after_seconds))
      : undefined;

    return {
      success: true,
      label: derivePlanLabel(data.plan_type),
      email: getEmailFromJwt(auth.access) ?? undefined,
      windows: {
        hourly: { percentRemaining: clampPercent(hourlyRemain), resetTimeIso: hourlyResetIso },
        weekly:
          weeklyRemain === undefined
            ? undefined
            : { percentRemaining: clampPercent(weeklyRemain), resetTimeIso: weeklyResetIso },
        codeReview:
          codeReviewRemain === undefined
            ? undefined
            : {
                percentRemaining: clampPercent(codeReviewRemain),
                resetTimeIso: codeReviewResetIso,
              },
      },
      credits: credits
        ? {
            hasCredits: Boolean(credits.has_credits),
            unlimited: Boolean(credits.unlimited),
            balance: credits.balance ?? null,
          }
        : undefined,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
