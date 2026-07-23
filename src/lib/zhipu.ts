/**
 * Zhipu quota fetcher
 *
 * Uses OpenCode's auth.json (zhipu-coding-plan) and queries:
 * https://bigmodel.cn/api/monitor/usage/quota/limit
 */

import { clampPercent } from "./format-utils.js";
import { sanitizeDisplaySnippet, sanitizeDisplayText } from "./display-sanitize.js";
import { fetchWithTimeout } from "./http.js";
import type { ZaiResult, ZaiQuotaResponse } from "./types.js";
import { resolveZhipuAuthCached } from "./zhipu-auth.js";

const ZHIPU_QUOTA_URL = "https://bigmodel.cn/api/monitor/usage/quota/limit";

export async function queryZhipuQuota(
  options: { requestTimeoutMs?: number } = {},
): Promise<ZaiResult> {
  const auth = await resolveZhipuAuthCached();
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

    return await fetchWithTimeout(ZHIPU_QUOTA_URL, {
      request: { headers },
      timeoutMs: options.requestTimeoutMs,
      consume: async (resp) => {
        if (!resp.ok) {
          const text = await resp.text();
          return {
            success: false,
            error: `Zhipu API error ${resp.status}: ${sanitizeDisplaySnippet(text, 120)}`,
          };
        }

        const data = (await resp.json()) as ZaiQuotaResponse;
        const limits = data.data.limits;

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
          label: "Zhipu",
          windows: {
            fiveHour: fiveHourWindow,
            weekly: weeklyWindow,
            mcp: mcpWindow,
          },
        };
      },
    });
  } catch (err) {
    return {
      success: false,
      error: sanitizeDisplayText(err instanceof Error ? err.message : String(err)),
    };
  }
}
