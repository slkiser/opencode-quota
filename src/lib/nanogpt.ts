/**
 * NanoGPT quota fetcher
 *
 * Queries: https://nano-gpt.com/api/subscription/v1/usage
 */

import { clampPercent } from "./format-utils.js";
import { sanitizeDisplaySnippet, sanitizeDisplayText } from "./display-sanitize.js";
import { fetchWithTimeout } from "./http.js";
import { resolveNanoGptApiKey, hasNanoGptApiKey } from "./nanogpt-config.js";
import type { NanoGptResult, NanoGptQuotaResponse, QuotaError } from "./types.js";

const NANOGPT_QUOTA_URL = "https://nano-gpt.com/api/subscription/v1/usage";

type NanoGptAuth = {
  key: string;
};

async function readNanoGptAuth(): Promise<NanoGptAuth | null> {
  const result = await resolveNanoGptApiKey();
  if (!result) return null;
  return { key: result.key };
}

export { hasNanoGptApiKey };

function processWindow(
  data: { percentUsed: number; resetAt: number } | null | undefined,
): { percentRemaining: number; resetTimeIso?: string } | undefined {
  if (!data || typeof data.percentUsed !== "number") return undefined;
  const percentRemaining = clampPercent(100 - data.percentUsed * 100);
  let resetTimeIso: string | undefined;
  if (typeof data.resetAt === "number" && data.resetAt > 0) {
    resetTimeIso = new Date(data.resetAt).toISOString();
  }
  return { percentRemaining, resetTimeIso };
}

export async function queryNanoGptQuota(): Promise<NanoGptResult | QuotaError | null> {
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
        error: `NanoGPT API error ${resp.status}: ${sanitizeDisplaySnippet(text, 120)}`,
      };
    }

    const data = (await resp.json()) as NanoGptQuotaResponse;

    if (!data.active) {
      return {
        success: false,
        error: `NanoGPT subscription inactive (state: ${data.state})`,
      };
    }

    const windows: NanoGptResult["windows"] = {};

    if (data.weeklyInputTokens) {
      windows.weeklyTokens = processWindow(data.weeklyInputTokens);
    }

    if (data.dailyInputTokens) {
      windows.dailyTokens = processWindow(data.dailyInputTokens);
    }

    if (data.dailyImages) {
      windows.dailyImages = processWindow(data.dailyImages);
    }

    return {
      success: true,
      label: "NanoGPT",
      windows,
    };
  } catch (err) {
    return {
      success: false,
      error: sanitizeDisplayText(err instanceof Error ? err.message : String(err)),
    };
  }
}

export { getNanoGptKeyDiagnostics, type NanoGptKeySource } from "./nanogpt-config.js";
