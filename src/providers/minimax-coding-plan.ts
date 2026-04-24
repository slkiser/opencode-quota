/**
 * MiniMax Coding Plan provider wrapper.
 *
 * Fetches quota data from MiniMax API for coding plan users.
 */

import type { QuotaProvider, QuotaProviderContext, QuotaProviderResult } from "../lib/entries.js";
import {
  DEFAULT_MINIMAX_AUTH_CACHE_MAX_AGE_MS,
  resolveMiniMaxAuthCached,
} from "../lib/minimax-auth.js";
import { sanitizeDisplayText } from "../lib/display-sanitize.js";
import { fetchWithTimeout } from "../lib/http.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { normalizeQuotaProviderId } from "../lib/provider-metadata.js";
import type { MiniMaxResult, MiniMaxResultEntry } from "../lib/types.js";
import { attemptedErrorResult, attemptedResult, notAttemptedResult } from "./result-helpers.js";

const MINIMAX_API_URL = "https://api.minimax.io/v1/api/openplatform/coding_plan/remains";
const MINIMAX_PROVIDER_LABEL = "MiniMax Coding Plan";
const USER_AGENT = "OpenCode-Quota-Toast/1.0";

interface MiniMaxModelRemain {
  model_name: string;
  current_interval_total_count: number;
  /** Actually returns remaining quota (not usage). Usage = total - this value. */
  current_interval_usage_count: number;
  remains_time: number;
  current_weekly_total_count: number;
  /** Actually returns remaining quota (not usage). Usage = total - this value. */
  current_weekly_usage_count: number;
  weekly_remains_time: number;
}

interface MiniMaxApiResponse {
  model_remains: MiniMaxModelRemain[];
  base_resp: {
    status_code: number;
    status_msg: string;
  };
}

interface MiniMaxWindowSpec {
  window: MiniMaxResultEntry["window"];
  name: string;
  label: string;
  getTotal(model: MiniMaxModelRemain): number;
  getRemaining(model: MiniMaxModelRemain): number;
  getResetOffsetMs(model: MiniMaxModelRemain): number;
}

const MINIMAX_WINDOW_SPECS: readonly MiniMaxWindowSpec[] = [
  {
    window: "five_hour",
    name: "MiniMax Coding Plan 5h",
    label: "5h:",
    getTotal: (model) => model.current_interval_total_count,
    getRemaining: (model) => model.current_interval_usage_count,
    getResetOffsetMs: (model) => model.remains_time,
  },
  {
    window: "weekly",
    name: "MiniMax Coding Plan Weekly",
    label: "Weekly:",
    getTotal: (model) => model.current_weekly_total_count,
    getRemaining: (model) => model.current_weekly_usage_count,
    getResetOffsetMs: (model) => model.weekly_remains_time,
  },
];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Type guard that validates a value is a well-formed MiniMax model record.
 *
 * Checks for `model_name` (string) and all required numeric fields to prevent
 * `NaN` arithmetic when the API response shape is unexpected.
 */
function isMiniMaxModelRecord(value: unknown): value is MiniMaxModelRemain {
  if (value === null || typeof value !== "object" || !("model_name" in value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.model_name === "string" &&
    isFiniteNumber(v.current_interval_total_count) &&
    isFiniteNumber(v.current_interval_usage_count) &&
    isFiniteNumber(v.remains_time) &&
    isFiniteNumber(v.current_weekly_total_count) &&
    isFiniteNumber(v.current_weekly_usage_count) &&
    isFiniteNumber(v.weekly_remains_time)
  );
}

function roundPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function sanitizeMiniMaxMessage(text: string, maxLength = 120): string {
  const sanitized = sanitizeDisplayText(text).replace(/\s+/g, " ").trim();
  return (sanitized || "unknown").slice(0, maxLength);
}

function clampRemaining(total: number, remaining: number): number {
  return Math.max(0, Math.min(total, remaining));
}

function isMiniMaxCodingModelName(modelName: string): boolean {
  const normalized = modelName.trim().toLowerCase();
  return normalized === "minimax-m*" || normalized.startsWith("minimax-m");
}

function buildMiniMaxEntry(model: MiniMaxModelRemain, spec: MiniMaxWindowSpec): MiniMaxResultEntry | null {
  const total = spec.getTotal(model);
  if (total <= 0) return null;
  const remaining = clampRemaining(total, spec.getRemaining(model));
  const used = total - remaining;
  const percentRemaining = roundPercent((remaining / total) * 100);

  return {
    window: spec.window,
    name: spec.name,
    group: MINIMAX_PROVIDER_LABEL,
    label: spec.label,
    right: `${used}/${total}`,
    percentRemaining,
    resetTimeIso: new Date(Date.now() + Math.max(0, spec.getResetOffsetMs(model))).toISOString(),
  };
}

function buildMiniMaxEntries(model: MiniMaxModelRemain): MiniMaxResultEntry[] {
  return MINIMAX_WINDOW_SPECS.flatMap((spec) => {
    const entry = buildMiniMaxEntry(model, spec);
    return entry ? [entry] : [];
  });
}

function getWorstPercent(model: MiniMaxModelRemain): number {
  const percents = buildMiniMaxEntries(model).map((entry) => entry.percentRemaining);
  return percents.length > 0 ? Math.min(...percents) : Number.POSITIVE_INFINITY;
}

function selectCanonicalMiniMaxModel(models: MiniMaxModelRemain[]): MiniMaxModelRemain | null {
  if (models.length === 0) return null;

  const wildcardModel =
    models.find((model) => model.model_name.trim().toLowerCase() === "minimax-m*") ?? null;
  if (wildcardModel && Number.isFinite(getWorstPercent(wildcardModel))) {
    return wildcardModel;
  }

  return [...models].sort((left, right) => {
    const percentDiff = getWorstPercent(left) - getWorstPercent(right);
    if (percentDiff !== 0) return percentDiff;
    return left.model_name.localeCompare(right.model_name);
  })[0] ?? null;
}

/**
 * Fetch MiniMax coding plan quota from the API.
 *
 * Parses usage specifically for `MiniMax-M*` text models.
 *
 * @param apiKey - MiniMax API key
 * @returns Quota entries on success, error on failure, or empty entries when
 *          the API returns successfully but no models have reportable quota.
 */
export async function queryMiniMaxQuota(apiKey: string): Promise<MiniMaxResult> {
  try {
    const response = await fetchWithTimeout(MINIMAX_API_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": USER_AGENT,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      return {
        success: false,
        error: `MiniMax API error ${response.status}: ${sanitizeMiniMaxMessage(text, 120)}`,
      };
    }

    const payload = (await response.json()) as MiniMaxApiResponse;

    if (payload.base_resp?.status_code !== 0) {
      return {
        success: false,
        error: `MiniMax API error: ${sanitizeMiniMaxMessage(payload.base_resp?.status_msg ?? "unknown")}`,
      };
    }

    const matchingModels = (payload.model_remains ?? []).filter(
      (model): model is MiniMaxModelRemain =>
        isMiniMaxModelRecord(model) && isMiniMaxCodingModelName(model.model_name),
    );
    const canonicalModel = selectCanonicalMiniMaxModel(matchingModels);
    const entries = canonicalModel ? buildMiniMaxEntries(canonicalModel) : [];

    return { success: true, entries };
  } catch (err) {
    return {
      success: false,
      error: sanitizeMiniMaxMessage(err instanceof Error ? err.message : String(err)),
    };
  }
}

export const minimaxCodingPlanProvider: QuotaProvider = {
  id: "minimax-coding-plan",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const providerAvailable = await isCanonicalProviderAvailable({
      ctx,
      providerId: "minimax-coding-plan",
      fallbackOnError: false,
    });
    if (!providerAvailable) {
      return false;
    }

    const auth = await resolveMiniMaxAuthCached({
      maxAgeMs: DEFAULT_MINIMAX_AUTH_CACHE_MAX_AGE_MS,
    });
    return auth.state === "configured" || auth.state === "invalid";
  },

  matchesCurrentModel(model: string): boolean {
    const [provider, modelId] = model.toLowerCase().split("/", 2);
    return normalizeQuotaProviderId(provider) === "minimax-coding-plan" && Boolean(modelId) && isMiniMaxCodingModelName(modelId);
  },

  async fetch(_ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const auth = await resolveMiniMaxAuthCached({
      maxAgeMs: DEFAULT_MINIMAX_AUTH_CACHE_MAX_AGE_MS,
    });

    if (auth.state === "none") {
      return notAttemptedResult();
    }

    if (auth.state === "invalid") {
      return attemptedErrorResult(MINIMAX_PROVIDER_LABEL, auth.error);
    }

    const result = await queryMiniMaxQuota(auth.apiKey);

    if (!result.success) {
      return attemptedErrorResult(MINIMAX_PROVIDER_LABEL, result.error);
    }

    return attemptedResult(result.entries);
  },
};
