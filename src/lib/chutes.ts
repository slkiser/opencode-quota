/**
 * Chutes AI quota fetcher
 *
 * Resolves API key from multiple sources and queries:
 * https://api.chutes.ai/users/me/quota_usage/me
 */

import type { ChutesResult } from "./types.js";
import { REQUEST_TIMEOUT_MS } from "./types.js";
import {
  resolveChutesApiKey,
  hasChutesApiKey,
  getChutesKeyDiagnostics,
  type ChutesKeySource,
} from "./chutes-config.js";

interface ChutesQuotaResponse {
  quota: number;
  used: number;
}

function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function getNextDailyResetUtc(): string {
  const now = new Date();
  const reset = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0),
  );
  return reset.toISOString();
}

async function fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Request timeout after ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

type ChutesApiAuth = {
  type: "api";
  key: string;
  source: ChutesKeySource;
};

async function readChutesAuth(): Promise<ChutesApiAuth | null> {
  const result = await resolveChutesApiKey();
  if (!result) return null;
  return { type: "api", key: result.key, source: result.source };
}

const CHUTES_QUOTA_URL = "https://api.chutes.ai/users/me/quota_usage/me";

export async function hasChutesApiKeyConfigured(): Promise<boolean> {
  return await hasChutesApiKey();
}

export { getChutesKeyDiagnostics, type ChutesKeySource } from "./chutes-config.js";

export async function queryChutesQuota(): Promise<ChutesResult> {
  const auth = await readChutesAuth();
  if (!auth) return null;

  try {
    const resp = await fetchWithTimeout(CHUTES_QUOTA_URL, {
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
        error: `Chutes API error ${resp.status}: ${text.slice(0, 120)}`,
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
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
