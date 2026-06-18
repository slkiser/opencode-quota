/**
 * Z.ai quota fetcher
 *
 * Uses OpenCode's auth.json (zai-coding-plan) and queries:
 * https://api.z.ai/api/monitor/usage/quota/limit
 */

import { clampPercent } from "./format-utils.js";
import { sanitizeDisplaySnippet, sanitizeDisplayText } from "./display-sanitize.js";
import { fetchWithTimeout } from "./http.js";
import type { ZaiQuotaLimit, ZaiResult } from "./types.js";
import { resolveZaiAuthCached } from "./zai-auth.js";

const ZAI_QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";

type ZaiQuotaApiResponse = {
  code?: number;
  msg?: unknown;
  data?: {
    limits?: ZaiQuotaLimit[] | null;
    level?: string;
  };
  limits?: ZaiQuotaLimit[] | null;
  success?: boolean;
};

export async function queryZaiQuota(options: { requestTimeoutMs?: number } = {}): Promise<ZaiResult> {
  const auth = await resolveZaiAuthCached();
  if (auth.state === "none") return null;
  if (auth.state === "invalid") {
    return { success: false, error: auth.error };
  }

  try {
    const headers: Record<string, string> = {
      Authorization: auth.apiKey,
      "User-Agent": "OpenCode-Quota-Toast/1.0",
      "Content-Type": "application/json",
    };

    const resp = await fetchWithTimeout(ZAI_QUOTA_URL, { headers }, options.requestTimeoutMs);
    if (!resp.ok) {
      const text = await resp.text();
      return {
        success: false,
        error: `Z.ai API error ${resp.status}: ${sanitizeDisplaySnippet(text, 120)}`,
      };
    }

    const data = (await resp.json()) as ZaiQuotaApiResponse;
    if (data.success === false || (typeof data.code === "number" && data.code >= 400)) {
      const msg = typeof data.msg === "string" ? sanitizeDisplayText(data.msg) : "";
      return {
        success: false,
        error: msg || (typeof data.code === "number" ? `Z.ai API error ${data.code}` : "Z.ai API error"),
      };
    }

    const limits = data.data?.limits ?? data.limits;

    if (!limits || !Array.isArray(limits)) {
      return { success: false, error: "Invalid quota data" };
    }

    let fiveHourWindow: { percentRemaining: number; resetTimeIso?: string } | undefined;
    let weeklyWindow: { percentRemaining: number; resetTimeIso?: string } | undefined;
    let mcpWindow: { percentRemaining: number; resetTimeIso?: string } | undefined;

    for (const limit of limits) {
      const percentRemaining = clampPercent(100 - limit.percentage);
      let resetTimeIso: string | undefined;

      if (limit.nextResetTime) {
        const ms = Math.round(limit.nextResetTime);
        if (Number.isFinite(ms) && ms > 0) {
          resetTimeIso = new Date(ms).toISOString();
        }
      }

      const window = { percentRemaining, resetTimeIso };

      if (limit.type === "TOKENS_LIMIT") {
        if (limit.unit === 3) {
          // unit 3 is the 5-hour token window (Standard Lite/Pro/Max).
          fiveHourWindow = window;
        } else if (limit.unit === 6) {
          // unit 6 is the weekly token window.
          weeklyWindow = window;
        } else if (limit.unit === 4) {
          // unit 4 is daily. Do not surface it as weekly in the current UI/report shape.
          continue;
        }
      } else if (limit.type === "TIME_LIMIT") {
        // TIME_LIMIT (unit 5) is typically the Monthly MCP limit
        mcpWindow = window;
      }
    }

    return {
      success: true,
      label: "Z.ai",
      windows: {
        fiveHour: fiveHourWindow,
        weekly: weeklyWindow,
        mcp: mcpWindow,
      },
    };
  } catch (err) {
    return {
      success: false,
      error: sanitizeDisplayText(err instanceof Error ? err.message : String(err)),
    };
  }
}
