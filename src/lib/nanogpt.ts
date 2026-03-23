/**
 * NanoGPT live quota fetcher.
 *
 * Queries:
 * - https://nano-gpt.com/api/subscription/v1/usage
 */

import type { QuotaError } from "./types.js";
import { sanitizeDisplaySnippet, sanitizeDisplayText } from "./display-sanitize.js";
import { clampPercent } from "./format-utils.js";
import { fetchWithTimeout } from "./http.js";
import {
  getNanoGptKeyDiagnostics,
  hasNanoGptApiKey,
  resolveNanoGptApiKey,
  type NanoGptKeySource,
} from "./nanogpt-config.js";

type NanoGptApiAuth = {
  type: "api";
  key: string;
  source: NanoGptKeySource;
};

type NanoGptRecord = Record<string, unknown>;

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
  weeklyInputTokens?: NanoGptUsageWindow;
  dailyImages?: NanoGptUsageWindow;
  dailyInputTokens?: NanoGptUsageWindow;
  graceUntilIso?: string;
}

export type NanoGptResult =
  | {
      success: true;
      subscription: NanoGptSubscription;
    }
  | QuotaError
  | null;

interface NanoGptUsageEndpointWindow {
  used?: number | null;
  remaining?: number | null;
  percentUsed?: number | null;
  resetAt?: number | null;
}

interface NanoGptUsageResponse {
  active?: boolean;
  limits?: {
    weeklyInputTokens?: number | null;
    dailyInputTokens?: number | null;
    dailyImages?: number | null;
  };
  enforceDailyLimit?: boolean;
  weeklyInputTokens?: NanoGptUsageEndpointWindow | null;
  dailyInputTokens?: NanoGptUsageEndpointWindow | null;
  dailyImages?: NanoGptUsageEndpointWindow | null;
  state?: string;
  graceUntil?: string | null;
}

const USER_AGENT = "OpenCode-Quota-Toast/1.0";
const NANOGPT_USAGE_URL = "https://nano-gpt.com/api/subscription/v1/usage";

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

function normalizeUsageWindow(value: unknown, limitValue: unknown): NanoGptUsageWindow | undefined {
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
    resetTimeIso: getIsoFromEpochMs(value.resetAt),
  };
}

function parseNanoGptUsage(payload: unknown): NanoGptSubscription {
  if (!isRecord(payload)) {
    throw new Error("NanoGPT usage response returned an unexpected response shape");
  }

  const data = payload as NanoGptUsageResponse;
  const weeklyInputTokens = normalizeUsageWindow(
    data.weeklyInputTokens,
    data.limits?.weeklyInputTokens,
  );
  const dailyImages = normalizeUsageWindow(data.dailyImages, data.limits?.dailyImages);
  const dailyInputTokens = normalizeUsageWindow(
    data.dailyInputTokens,
    data.limits?.dailyInputTokens,
  );
  const hasSubscriptionShape =
    typeof data.active === "boolean" ||
    typeof data.enforceDailyLimit === "boolean" ||
    Boolean(getNonEmptyString(data.state)) ||
    weeklyInputTokens !== undefined ||
    dailyImages !== undefined ||
    dailyInputTokens !== undefined;

  if (!hasSubscriptionShape) {
    throw new Error("NanoGPT usage response returned an unexpected response shape");
  }

  return {
    active: typeof data.active === "boolean" ? data.active : false,
    state: getNonEmptyString(data.state) ?? (data.active ? "active" : "unknown"),
    enforceDailyLimit:
      typeof data.enforceDailyLimit === "boolean" ? data.enforceDailyLimit : false,
    weeklyInputTokens,
    dailyImages,
    dailyInputTokens,
    graceUntilIso: getIsoString(data.graceUntil),
  };
}

async function readNanoGptAuth(): Promise<NanoGptApiAuth | null> {
  const result = await resolveNanoGptApiKey();
  if (!result) return null;
  return { type: "api", key: result.key, source: result.source };
}

async function fetchNanoGptUsage(headers: Record<string, string>): Promise<
  | { success: true; subscription: NanoGptSubscription }
  | { success: false; message: string }
> {
  try {
    const response = await fetchWithTimeout(NANOGPT_USAGE_URL, {
      method: "GET",
      headers,
    });
    if (!response.ok) {
      const text = await response.text();
      return {
        success: false,
        message: `NanoGPT API error ${response.status}: ${sanitizeDisplaySnippet(text, 120)}`,
      };
    }

    return {
      success: true,
      subscription: parseNanoGptUsage(await response.json()),
    };
  } catch (err) {
    return {
      success: false,
      message: sanitizeDisplayText(err instanceof Error ? err.message : String(err)),
    };
  }
}

export async function hasNanoGptApiKeyConfigured(): Promise<boolean> {
  return await hasNanoGptApiKey();
}

export { getNanoGptKeyDiagnostics, type NanoGptKeySource } from "./nanogpt-config.js";

export async function queryNanoGptQuota(): Promise<NanoGptResult> {
  const auth = await readNanoGptAuth();
  if (!auth) return null;

  const headers = {
    "x-api-key": auth.key,
    "User-Agent": USER_AGENT,
  };

  const usageResult = await fetchNanoGptUsage(headers);
  if (!usageResult.success) {
    return {
      success: false,
      error: usageResult.message,
    };
  }

  return {
    success: true,
    subscription: usageResult.subscription,
  };
}
