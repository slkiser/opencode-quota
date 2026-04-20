/**
 * Synthetic quota fetcher
 *
 * Resolves API key from multiple sources and queries:
 * https://api.synthetic.new/v2/quotas
 */

import type { QuotaError, SyntheticResult } from "./types.js";
import { sanitizeDisplaySnippet, sanitizeDisplayText } from "./display-sanitize.js";
import { clampPercent } from "./format-utils.js";
import { fetchWithTimeout } from "./http.js";
import {
  getSyntheticKeyDiagnostics,
  hasSyntheticApiKey,
  resolveSyntheticApiKey,
  type SyntheticKeySource,
} from "./synthetic-config.js";

export interface SyntheticQuotaResponse {
  subscription?: {
    limit?: unknown;
    requests?: unknown;
    renewsAt?: unknown;
  };
}

const SYNTHETIC_QUOTA_URL = "https://api.synthetic.new/v2/quotas";

export {
  getSyntheticKeyDiagnostics,
  hasSyntheticApiKey as hasSyntheticApiKeyConfigured,
  type SyntheticKeySource,
} from "./synthetic-config.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function invalidSyntheticResponse(message: string): QuotaError {
  return {
    success: false,
    error: message,
  };
}

export async function querySyntheticQuota(): Promise<SyntheticResult> {
  const resolved = await resolveSyntheticApiKey();
  if (!resolved) return null;

  try {
    const resp = await fetchWithTimeout(SYNTHETIC_QUOTA_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${resolved.key}`,
        "User-Agent": "OpenCode-Quota-Toast/1.0",
      },
    });

    if (!resp.ok) {
      const text = await resp.text();
      return {
        success: false,
        error: `Synthetic API error ${resp.status}: ${sanitizeDisplaySnippet(text, 120)}`,
      };
    }

    const data = (await resp.json()) as SyntheticQuotaResponse;
    const subscription = asRecord(data?.subscription);
    if (!subscription) {
      return invalidSyntheticResponse("Synthetic API response missing subscription");
    }

    const limit = subscription.limit;
    if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
      return invalidSyntheticResponse("Synthetic API response missing subscription.limit");
    }

    const requests = subscription.requests;
    if (typeof requests !== "number" || !Number.isFinite(requests) || requests < 0) {
      return invalidSyntheticResponse("Synthetic API response missing subscription.requests");
    }

    const renewsAt =
      typeof subscription.renewsAt === "string" && subscription.renewsAt.trim().length > 0
        ? subscription.renewsAt.trim()
        : undefined;

    const percentRemaining = clampPercent(((limit - requests) / limit) * 100);

    return {
      success: true,
      requestLimit: limit,
      usedRequests: requests,
      percentRemaining,
      resetTimeIso: renewsAt,
    };
  } catch (err) {
    return {
      success: false,
      error: sanitizeDisplayText(err instanceof Error ? err.message : String(err)),
    };
  }
}
