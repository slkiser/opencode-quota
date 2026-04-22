/**
 * Synthetic quota fetcher
 *
 * Resolves API key from multiple sources and queries:
 * https://api.synthetic.new/v2/quotas
 */

import type { QuotaError, SyntheticResult, SyntheticQuotaWindow } from "./types.js";
import { sanitizeDisplaySnippet, sanitizeDisplayText } from "./display-sanitize.js";
import { clampPercent } from "./format-utils.js";
import { fetchWithTimeout } from "./http.js";
import {
  getSyntheticKeyDiagnostics,
  hasSyntheticApiKey,
  resolveSyntheticApiKey,
  type SyntheticKeySource,
} from "./synthetic-config.js";

const SYNTHETIC_QUOTA_URL = "https://api.synthetic.new/v2/quotas";
const SYNTHETIC_CREDIT_AMOUNT_PATTERN = /^\$(\d+)(?:\.(\d{1,2}))?$/;

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

function normalizeResetTimeIso(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return new Date(parsed).toISOString();
}

function normalizeSyntheticAmount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(6));
}

function parseSyntheticCreditAmount(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  const match = SYNTHETIC_CREDIT_AMOUNT_PATTERN.exec(trimmed);
  if (!match) {
    return null;
  }

  const whole = Number.parseInt(match[1] ?? "0", 10);
  const fractionalDigits = (match[2] ?? "").padEnd(2, "0");
  const fractional = fractionalDigits ? Number.parseInt(fractionalDigits, 10) : 0;
  if (!Number.isFinite(whole) || !Number.isFinite(fractional)) {
    return null;
  }

  return normalizeSyntheticAmount((whole * 100 + fractional) / 100);
}

function buildRollingFiveHourWindow(payload: Record<string, unknown>): SyntheticQuotaWindow | QuotaError {
  const rolling = asRecord(payload.rollingFiveHourLimit);
  if (!rolling) {
    return invalidSyntheticResponse("Synthetic API response missing rollingFiveHourLimit quota window");
  }

  const max = rolling.max;
  const remaining = rolling.remaining;

  if (typeof max !== "number" || !Number.isFinite(max) || max <= 0) {
    return invalidSyntheticResponse("Synthetic API response missing rollingFiveHourLimit quota window");
  }

  if (typeof remaining !== "number" || !Number.isFinite(remaining) || remaining < 0) {
    return invalidSyntheticResponse("Synthetic API response missing rollingFiveHourLimit quota window");
  }

  const used = normalizeSyntheticAmount(max - remaining);
  if (!Number.isFinite(used) || used < 0) {
    return invalidSyntheticResponse("Synthetic API response missing rollingFiveHourLimit quota window");
  }

  return {
    limit: max,
    used,
    percentRemaining: clampPercent((remaining / max) * 100),
    resetTimeIso: normalizeResetTimeIso(rolling.nextTickAt),
  };
}

function buildWeeklyTokenWindow(payload: Record<string, unknown>): SyntheticQuotaWindow | QuotaError {
  const weekly = asRecord(payload.weeklyTokenLimit);
  if (!weekly) {
    return invalidSyntheticResponse("Synthetic API response missing weeklyTokenLimit quota window");
  }

  const limit = parseSyntheticCreditAmount(weekly.maxCredits);
  const remaining = parseSyntheticCreditAmount(weekly.remainingCredits);
  if (limit === null || limit <= 0 || remaining === null || remaining < 0) {
    return invalidSyntheticResponse("Synthetic API response missing weeklyTokenLimit quota window");
  }

  const used = normalizeSyntheticAmount(limit - remaining);
  if (!Number.isFinite(used) || used < 0) {
    return invalidSyntheticResponse("Synthetic API response missing weeklyTokenLimit quota window");
  }

  const payloadPercentRemaining = weekly.percentRemaining;
  const hasValidPayloadPercentRemaining =
    typeof payloadPercentRemaining === "number" &&
    Number.isFinite(payloadPercentRemaining) &&
    payloadPercentRemaining >= 0 &&
    payloadPercentRemaining <= 100;
  const percentRemaining = hasValidPayloadPercentRemaining
    ? clampPercent(payloadPercentRemaining)
    : clampPercent((remaining / limit) * 100);

  return {
    limit,
    used,
    percentRemaining,
    resetTimeIso: normalizeResetTimeIso(weekly.nextRegenAt),
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

    const data = (await resp.json()) as unknown;
    const record = asRecord(data);
    if (!record) {
      return invalidSyntheticResponse("Synthetic API response missing rollingFiveHourLimit quota window");
    }

    const rollingFiveHour = buildRollingFiveHourWindow(record);
    if (!("limit" in rollingFiveHour)) {
      return rollingFiveHour;
    }

    const weekly = buildWeeklyTokenWindow(record);
    if (!("limit" in weekly)) {
      return weekly;
    }

    return {
      success: true,
      windows: {
        fiveHour: rollingFiveHour,
        weekly,
      },
    };
  } catch (err) {
    return {
      success: false,
      error: sanitizeDisplayText(err instanceof Error ? err.message : String(err)),
    };
  }
}
