/**
 * Firmware AI quota fetcher
 *
 * Resolves API key from multiple sources (env vars, opencode.json, auth.json)
 * and queries: https://app.firmware.ai/api/v1/quota
 */

import type { QuotaError } from "./types.js";
import { fetchWithTimeout } from "./http.js";
import {
  resolveFirmwareApiKey,
  hasFirmwareApiKey,
  getFirmwareKeyDiagnostics,
  type FirmwareKeySource,
} from "./firmware-config.js";

interface FirmwareQuotaResponse {
  used: number;
  reset: string | null;
}

function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

type FirmwareApiAuth = {
  type: "api";
  key: string;
  source: FirmwareKeySource;
};

async function readFirmwareAuth(): Promise<FirmwareApiAuth | null> {
  const result = await resolveFirmwareApiKey();
  if (!result) return null;
  return { type: "api", key: result.key, source: result.source };
}

export type FirmwareResult =
  | {
      success: true;
      percentRemaining: number;
      resetTimeIso?: string;
    }
  | QuotaError
  | null;

const FIRMWARE_QUOTA_URL = "https://app.firmware.ai/api/v1/quota";

export async function hasFirmwareApiKeyConfigured(): Promise<boolean> {
  return await hasFirmwareApiKey();
}

export { getFirmwareKeyDiagnostics, type FirmwareKeySource } from "./firmware-config.js";

export async function queryFirmwareQuota(): Promise<FirmwareResult> {
  const auth = await readFirmwareAuth();
  if (!auth) return null;

  try {
    const resp = await fetchWithTimeout(FIRMWARE_QUOTA_URL, {
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
        error: `Firmware API error ${resp.status}: ${text.slice(0, 120)}`,
      };
    }

    const data = (await resp.json()) as FirmwareQuotaResponse;

    // Firmware returns used ratio [0..1]. We convert to remaining %.
    const used = typeof data.used === "number" ? data.used : NaN;
    const percentRemaining = clampPercent(100 - used * 100);

    const resetIso =
      typeof data.reset === "string" && data.reset.length > 0 ? data.reset : undefined;

    return {
      success: true,
      percentRemaining,
      resetTimeIso: resetIso,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
