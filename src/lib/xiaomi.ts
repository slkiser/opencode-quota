/**
 * Xiaomi Token Plan API fetcher.
 *
 * Queries the Xiaomi platform API for Token Plan usage and subscription info.
 * API base: https://platform.xiaomimimo.com/api/v1
 * Auth: Xiaomi account session cookies
 */

import type { QuotaError } from "./types.js";
import { sanitizeDisplaySnippet, sanitizeDisplayText } from "./display-sanitize.js";
import { fetchWithTimeout } from "./http.js";
import {
  resolveXiaomiCookie,
  hasXiaomiCookie,
  type XiaomiCookieResult,
  type XiaomiCookieSource,
} from "./xiaomi-auth.js";

const PLATFORM_API_BASE = "https://platform.xiaomimimo.com/api/v1";
const USER_AGENT = "OpenCode-Quota-Toast/1.0";

export interface XiaomiTokenPlanUsageItem {
  name: string;
  used: number;
  limit: number;
  percent: number;
}

export interface XiaomiTokenPlanUsage {
  percent: number;
  items: XiaomiTokenPlanUsageItem[];
}

export interface XiaomiTokenPlanUsageResponse {
  monthUsage: XiaomiTokenPlanUsage;
  usage: XiaomiTokenPlanUsage;
}

export interface XiaomiTokenPlanCurrent {
  planCode: string;
  planName: string;
  tokenQuotaEn: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  expired: boolean;
}

export interface XiaomiTokenPlanResult {
  success: true;
  usage: XiaomiTokenPlanUsageResponse;
  plan: XiaomiTokenPlanCurrent;
}

export type XiaomiResult = XiaomiTokenPlanResult | QuotaError | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseUsageResponse(data: unknown): XiaomiTokenPlanUsageResponse | null {
  if (!isRecord(data)) return null;

  const monthUsage = data.monthUsage;
  const usage = data.usage;

  if (!isRecord(monthUsage) || !isRecord(usage)) return null;

  return {
    monthUsage: parseUsage(monthUsage),
    usage: parseUsage(usage),
  };
}

function parseUsage(data: Record<string, unknown>): XiaomiTokenPlanUsage {
  const percent = typeof data.percent === "number" ? data.percent : 0;
  const items: XiaomiTokenPlanUsageItem[] = [];

  if (Array.isArray(data.items)) {
    for (const item of data.items) {
      if (!isRecord(item)) continue;
      const name = typeof item.name === "string" ? item.name : "";
      const used = typeof item.used === "number" ? item.used : 0;
      const limit = typeof item.limit === "number" ? item.limit : 0;
      const itemPercent = typeof item.percent === "number" ? item.percent : 0;
      items.push({ name, used, limit, percent: itemPercent });
    }
  }

  return { percent, items };
}

function parsePlanResponse(data: unknown): XiaomiTokenPlanCurrent | null {
  if (!isRecord(data)) return null;

  const planCode = typeof data.planCode === "string" ? data.planCode : "";
  const planName = typeof data.planName === "string" ? data.planName : "";
  const tokenQuotaEn = typeof data.tokenQuotaEn === "string" ? data.tokenQuotaEn : "";
  const currentPeriodStart =
    typeof data.currentPeriodStart === "string" ? data.currentPeriodStart : "";
  const currentPeriodEnd = typeof data.currentPeriodEnd === "string" ? data.currentPeriodEnd : "";
  const expired = typeof data.expired === "boolean" ? data.expired : true;

  if (!planCode || !planName) return null;

  return { planCode, planName, tokenQuotaEn, currentPeriodStart, currentPeriodEnd, expired };
}

async function fetchPlatformApi<T>(
  endpoint: string,
  cookie: string,
  requestTimeoutMs?: number,
): Promise<{ success: true; data: T } | { success: false; message: string }> {
  try {
    const response = await fetchWithTimeout(
      `${PLATFORM_API_BASE}${endpoint}`,
      {
        method: "GET",
        headers: {
          Cookie: cookie,
          "User-Agent": USER_AGENT,
          Accept: "application/json",
        },
      },
      requestTimeoutMs,
    );

    if (!response.ok) {
      const text = await response.text();
      return {
        success: false,
        message: `Xiaomi API error ${response.status}: ${sanitizeDisplaySnippet(text, 120)}`,
      };
    }

    const json = (await response.json()) as Record<string, unknown>;

    if (json.code !== 0) {
      return {
        success: false,
        message: `Xiaomi API error: ${typeof json.message === "string" ? json.message : "unknown"}`,
      };
    }

    return { success: true, data: json.data as T };
  } catch (err) {
    return {
      success: false,
      message: sanitizeDisplayText(err instanceof Error ? err.message : String(err)),
    };
  }
}

/**
 * Query Xiaomi Token Plan usage and subscription info.
 *
 * @returns Typed result with success/error state, or null if no cookie is configured.
 */
export async function queryXiaomiTokenPlan(options: {
  requestTimeoutMs?: number;
} = {}): Promise<XiaomiResult> {
  const resolved = await resolveXiaomiCookie();
  if (!resolved) return null;

  // Fetch usage data
  const usageResult = await fetchPlatformApi<XiaomiTokenPlanUsageResponse>(
    "/tokenPlan/usage",
    resolved.cookie,
    options.requestTimeoutMs,
  );

  if (!usageResult.success) {
    return { success: false, error: usageResult.message };
  }

  const usage = parseUsageResponse(usageResult.data);
  if (!usage) {
    return { success: false, error: "Failed to parse Xiaomi Token Plan usage response" };
  }

  // Fetch current plan info
  const planResult = await fetchPlatformApi<XiaomiTokenPlanCurrent>(
    "/tokenPlan/current",
    resolved.cookie,
    options.requestTimeoutMs,
  );

  let plan: XiaomiTokenPlanCurrent;
  if (planResult.success) {
    const parsed = parsePlanResponse(planResult.data);
    plan = parsed ?? {
      planCode: "unknown",
      planName: "Unknown",
      tokenQuotaEn: "",
      currentPeriodStart: "",
      currentPeriodEnd: "",
      expired: true,
    };
  } else {
    // Plan fetch failed, use defaults
    plan = {
      planCode: "unknown",
      planName: "Unknown",
      tokenQuotaEn: "",
      currentPeriodStart: "",
      currentPeriodEnd: "",
      expired: true,
    };
  }

  return { success: true, usage, plan };
}

/**
 * Format remaining credits as a human-readable string.
 */
export function formatXiaomiCreditsRemaining(usage: XiaomiTokenPlanUsageItem): string {
  const remaining = usage.limit - usage.used;
  if (remaining >= 1_000_000_000) {
    return `${(remaining / 1_000_000_000).toFixed(1)}B`;
  }
  if (remaining >= 1_000_000) {
    return `${(remaining / 1_000_000).toFixed(1)}M`;
  }
  if (remaining >= 1_000) {
    return `${(remaining / 1_000).toFixed(1)}K`;
  }
  return String(remaining);
}

/**
 * Format used/limit as a human-readable string.
 */
export function formatXiaomiCreditsUsedLimit(usage: XiaomiTokenPlanUsageItem): string {
  const used = usage.used >= 1_000_000_000
    ? `${(usage.used / 1_000_000_000).toFixed(1)}B`
    : usage.used >= 1_000_000
      ? `${(usage.used / 1_000_000).toFixed(1)}M`
      : usage.used >= 1_000
        ? `${(usage.used / 1_000).toFixed(1)}K`
        : String(usage.used);

  const limit = usage.limit >= 1_000_000_000
    ? `${(usage.limit / 1_000_000_000).toFixed(1)}B`
    : usage.limit >= 1_000_000
      ? `${(usage.limit / 1_000_000).toFixed(1)}M`
      : usage.limit >= 1_000
        ? `${(usage.limit / 1_000).toFixed(1)}K`
        : String(usage.limit);

  return `${used}/${limit}`;
}

export {
  hasXiaomiCookie as hasXiaomiCookieConfigured,
  type XiaomiCookieResult,
  type XiaomiCookieSource,
};
