/**
 * Chutes AI quota fetcher
 *
 * Resolves API key from multiple sources and queries:
 * https://api.chutes.ai/users/me/quota_usage/me
 */

import type { ChutesResult } from "./types.js";
import { sanitizeDisplaySnippet, sanitizeDisplayText } from "./display-sanitize.js";
import { fetchWithTimeout } from "./http.js";
import { clampPercent } from "./format-utils.js";
import {
  resolveChutesApiKey,
  getChutesKeyDiagnostics,
  hasChutesApiKey,
  type ChutesKeySource,
} from "./chutes-config.js";

interface ChutesQuotaResponse {
  quota: number;
  used: number;
}

function getNextDailyResetUtc(): string {
  const now = new Date();
  const reset = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0),
  );
  return reset.toISOString();
}

const CHUTES_QUOTA_URL = "https://api.chutes.ai/users/me/quota_usage/me";

export {
  getChutesKeyDiagnostics,
  hasChutesApiKey as hasChutesApiKeyConfigured,
  type ChutesKeySource,
} from "./chutes-config.js";

export async function queryChutesQuota(
  options: { requestTimeoutMs?: number } = {},
): Promise<ChutesResult> {
  const resolved = await resolveChutesApiKey();
  if (!resolved) return null;

  try {
    return await fetchWithTimeout(CHUTES_QUOTA_URL, {
      request: {
        method: "GET",
        headers: {
          Authorization: `Bearer ${resolved.key}`,
          "User-Agent": "OpenCode-Quota-Toast/1.0",
        },
      },
      timeoutMs: options.requestTimeoutMs,
      consume: async (resp): Promise<Exclude<ChutesResult, null>> => {
        if (!resp.ok) {
          const text = await resp.text();
          return {
            success: false,
            error: `Chutes API error ${resp.status}: ${sanitizeDisplaySnippet(text, 120)}`,
          };
        }

        const data = (await resp.json()) as ChutesQuotaResponse;

        // Chutes returns used and quota.
        const used = typeof data.used === "number" ? data.used : 0;
        const quota = typeof data.quota === "number" ? data.quota : 0;
        const percentRemaining = quota > 0 ? clampPercent(((quota - used) / quota) * 100) : 0;

        return {
          success: true,
          percentRemaining,
          resetTimeIso: getNextDailyResetUtc(),
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
