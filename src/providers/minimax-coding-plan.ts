/**
 * MiniMax Coding Plan provider wrapper.
 *
 * Fetches quota data from MiniMax API for coding plan users.
 */

import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderMatchContext,
  QuotaProviderResult,
} from "../lib/entries.js";
import {
  DEFAULT_MINIMAX_AUTH_CACHE_MAX_AGE_MS,
  resolveMiniMaxAuthCached,
  resolveMiniMaxChinaAuthCached,
  type ResolvedMiniMaxAuth,
} from "../lib/minimax-auth.js";
import { getMiniMaxQuotaEndpoint, type MiniMaxQuotaEndpointId } from "../lib/minimax-endpoints.js";
import { sanitizeDisplayText } from "../lib/display-sanitize.js";
import { fetchWithTimeout } from "../lib/http.js";
import {
  isAnyProviderIdAvailable,
  isCanonicalProviderAvailable,
} from "../lib/provider-availability.js";
import { normalizeQuotaProviderId } from "../lib/provider-metadata.js";
import type { MiniMaxResult, MiniMaxResultEntry } from "../lib/types.js";
import { attemptedErrorResult, attemptedResult, notAttemptedResult } from "./result-helpers.js";

const MINIMAX_PROVIDER_LABEL = "MiniMax Coding Plan";
const MINIMAX_CHINA_PROVIDER_LABEL = "MiniMax Coding Plan (CN)";
const USER_AGENT = "OpenCode-Quota-Toast/1.0";

interface MiniMaxModelRemain {
  model_name: string;
  current_interval_total_count?: number;
  /** Endpoint-specific raw count: international reports remaining, China reports used. */
  current_interval_usage_count?: number;
  remains_time: number;
  current_weekly_total_count?: number;
  /** Endpoint-specific raw count: international reports remaining, China reports used. */
  current_weekly_usage_count?: number;
  weekly_remains_time?: number;
  /** Provider-reported remaining percentage used by zero-count international responses. */
  current_interval_remaining_percent?: number;
  current_weekly_remaining_percent?: number;
}

interface MiniMaxApiResponse {
  model_remains: MiniMaxModelRemain[];
  base_resp: {
    status_code: number;
    status_msg: string;
  };
}

type MiniMaxCountSemantics = "remaining" | "used";

const MINIMAX_COUNT_SEMANTICS_BY_ENDPOINT: Record<MiniMaxQuotaEndpointId, MiniMaxCountSemantics> = {
  international: "remaining",
  china: "used",
};

interface MiniMaxWindowSpec {
  window: MiniMaxResultEntry["window"];
  name: string;
  label: string;
  getTotal(model: MiniMaxModelRemain): number | undefined;
  getCount(model: MiniMaxModelRemain): number | undefined;
  getResetOffsetMs(model: MiniMaxModelRemain): number | undefined;
  getPercentRemaining(model: MiniMaxModelRemain): number | undefined;
}

const MINIMAX_WINDOW_SPECS: readonly MiniMaxWindowSpec[] = [
  {
    window: "five_hour",
    name: "MiniMax Coding Plan 5h",
    label: "5h:",
    getTotal: (model) => model.current_interval_total_count,
    getCount: (model) => model.current_interval_usage_count,
    getResetOffsetMs: (model) => model.remains_time,
    getPercentRemaining: (model) => model.current_interval_remaining_percent,
  },
  {
    window: "weekly",
    name: "MiniMax Coding Plan Weekly",
    label: "Weekly:",
    getTotal: (model) => model.current_weekly_total_count,
    getCount: (model) => model.current_weekly_usage_count,
    getResetOffsetMs: (model) => model.weekly_remains_time,
    getPercentRemaining: (model) => model.current_weekly_remaining_percent,
  },
];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Type guard that validates a value is a well-formed MiniMax model record.
 *
 * Accepts the existing count shape or the international endpoint's percentage
 * fallback shape. A finite 5-hour reset offset remains required.
 */
function isMiniMaxModelRecord(value: unknown): value is MiniMaxModelRemain {
  if (value === null || typeof value !== "object" || !("model_name" in value)) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.model_name !== "string" || !isFiniteNumber(v.remains_time)) return false;

  const hasCounts =
    isFiniteNumber(v.current_interval_total_count) &&
    isFiniteNumber(v.current_interval_usage_count);
  const hasPercent = isFiniteNumber(v.current_interval_remaining_percent);
  return hasCounts || hasPercent;
}

function roundPercent(value: number): number {
  return Math.min(100, Math.round(value));
}

function sanitizeMiniMaxMessage(text: string, maxLength = 120): string {
  const sanitized = sanitizeDisplayText(text).replace(/\s+/g, " ").trim();
  return (sanitized || "unknown").slice(0, maxLength);
}

function clampRemaining(total: number, remaining: number): number {
  return Math.min(total, remaining);
}

function normalizeMiniMaxCounts(
  total: number,
  rawCount: number,
  countSemantics: MiniMaxCountSemantics,
): { used: number; remaining: number } {
  if (countSemantics === "used") {
    const used = Math.max(0, rawCount);
    return { used, remaining: total - used };
  }

  const remaining = clampRemaining(total, rawCount);
  return { used: total - remaining, remaining };
}

function isMiniMaxCodingModelName(
  modelName: string,
  endpointId: MiniMaxQuotaEndpointId = "international",
): boolean {
  const normalized = modelName.trim().toLowerCase();
  if (normalized === "minimax-m*" || normalized.startsWith("minimax-m")) {
    return true;
  }

  return endpointId === "international" && (normalized === "general" || normalized === "video");
}

function buildMiniMaxEntry(
  model: MiniMaxModelRemain,
  spec: MiniMaxWindowSpec,
  providerLabel: string,
  countSemantics: MiniMaxCountSemantics,
): MiniMaxResultEntry | null {
  const total = spec.getTotal(model);
  const rawCount = spec.getCount(model);
  const resetOffsetMs = spec.getResetOffsetMs(model);
  if (!isFiniteNumber(resetOffsetMs)) return null;

  if (isFiniteNumber(total) && isFiniteNumber(rawCount) && total > 0) {
    const { used, remaining } = normalizeMiniMaxCounts(total, rawCount, countSemantics);
    const percentRemaining = roundPercent((remaining / total) * 100);

    return {
      window: spec.window,
      name: spec.name.replace(MINIMAX_PROVIDER_LABEL, providerLabel),
      group: providerLabel,
      label: spec.label,
      right: `${used}/${total}`,
      percentRemaining,
      resetTimeIso: new Date(Date.now() + Math.max(0, resetOffsetMs)).toISOString(),
    };
  }

  if (countSemantics !== "remaining") return null;
  const percentRaw = spec.getPercentRemaining(model);
  if (!isFiniteNumber(percentRaw)) return null;
  const percentRemaining = roundPercent(percentRaw);

  return {
    window: spec.window,
    name: spec.name.replace(MINIMAX_PROVIDER_LABEL, providerLabel),
    group: providerLabel,
    label: spec.label,
    right: `${100 - percentRemaining}%`,
    percentRemaining,
    resetTimeIso: new Date(Date.now() + Math.max(0, resetOffsetMs)).toISOString(),
  };
}

function buildMiniMaxEntries(
  model: MiniMaxModelRemain,
  providerLabel: string,
  countSemantics: MiniMaxCountSemantics,
): MiniMaxResultEntry[] {
  return MINIMAX_WINDOW_SPECS.flatMap((spec) => {
    const entry = buildMiniMaxEntry(model, spec, providerLabel, countSemantics);
    return entry ? [entry] : [];
  });
}

function getWorstPercent(model: MiniMaxModelRemain, countSemantics: MiniMaxCountSemantics): number {
  const percents = buildMiniMaxEntries(model, MINIMAX_PROVIDER_LABEL, countSemantics).map(
    (entry) => entry.percentRemaining,
  );
  return percents.length > 0 ? Math.min(...percents) : Number.POSITIVE_INFINITY;
}

function selectCanonicalMiniMaxModel(
  models: MiniMaxModelRemain[],
  countSemantics: MiniMaxCountSemantics,
): MiniMaxModelRemain | null {
  if (models.length === 0) return null;

  const wildcardModel =
    models.find((model) => model.model_name.trim().toLowerCase() === "minimax-m*") ?? null;
  if (wildcardModel && Number.isFinite(getWorstPercent(wildcardModel, countSemantics))) {
    return wildcardModel;
  }

  return (
    [...models].sort((left, right) => {
      const percentDiff =
        getWorstPercent(left, countSemantics) - getWorstPercent(right, countSemantics);
      if (percentDiff !== 0) return percentDiff;
      return left.model_name.localeCompare(right.model_name);
    })[0] ?? null
  );
}

/**
 * Fetch MiniMax coding plan quota from the API.
 *
 * Parses usage for MiniMax coding-plan models returned by the selected endpoint.
 *
 * @param apiKey - MiniMax API key
 * @returns Quota entries on success, error on failure, or empty entries when
 *          the API returns successfully but no models have reportable quota.
 */
export async function queryMiniMaxQuota(
  apiKey: string,
  options: { requestTimeoutMs?: number; endpoint?: MiniMaxQuotaEndpointId; label?: string } = {},
): Promise<MiniMaxResult> {
  const endpointId = options.endpoint ?? "international";
  const endpoint = getMiniMaxQuotaEndpoint(endpointId);
  const countSemantics = MINIMAX_COUNT_SEMANTICS_BY_ENDPOINT[endpointId];
  try {
    return await fetchWithTimeout(endpoint.quotaUrl, {
      request: {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "User-Agent": USER_AGENT,
        },
      },
      timeoutMs: options.requestTimeoutMs,
      consume: async (response) => {
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
            isMiniMaxModelRecord(model) && isMiniMaxCodingModelName(model.model_name, endpointId),
        );
        const canonicalModel = selectCanonicalMiniMaxModel(matchingModels, countSemantics);
        const entries = canonicalModel
          ? buildMiniMaxEntries(
              canonicalModel,
              options.label ?? MINIMAX_PROVIDER_LABEL,
              countSemantics,
            )
          : [];

        return { success: true, entries };
      },
    });
  } catch (err) {
    return {
      success: false,
      error: sanitizeMiniMaxMessage(err instanceof Error ? err.message : String(err)),
    };
  }
}

type MiniMaxProviderSpec = {
  id: "minimax-coding-plan" | "minimax-china-coding-plan";
  label: string;
  endpoint: MiniMaxQuotaEndpointId;
  resolveAuthCached: (params?: { maxAgeMs?: number }) => Promise<ResolvedMiniMaxAuth>;
};

function isMiniMaxChinaExplicitlyEnabled(context?: QuotaProviderMatchContext): boolean {
  if (!context || context.enabledProviders === "auto") return false;
  return context.enabledProviders.some(
    (providerId) => normalizeQuotaProviderId(providerId) === "minimax-china-coding-plan",
  );
}

function matchesMiniMaxCurrentModel(
  model: string,
  spec: MiniMaxProviderSpec,
  context?: QuotaProviderMatchContext,
): boolean {
  const [provider = "", modelId] = model.toLowerCase().split("/", 2);
  if (!modelId || !isMiniMaxCodingModelName(modelId)) return false;

  const normalizedProvider = normalizeQuotaProviderId(provider);
  if (spec.id === "minimax-coding-plan") {
    return normalizedProvider === "minimax-coding-plan";
  }

  return (
    normalizedProvider === "minimax-china-coding-plan" ||
    (provider === "minimax" && isMiniMaxChinaExplicitlyEnabled(context))
  );
}

async function isMiniMaxProviderRuntimeAvailable(
  ctx: QuotaProviderContext,
  spec: MiniMaxProviderSpec,
): Promise<boolean> {
  const providerAvailable = await isCanonicalProviderAvailable({
    ctx,
    providerId: spec.id,
    fallbackOnError: false,
  });
  if (providerAvailable) return true;

  if (spec.id !== "minimax-china-coding-plan" || !isMiniMaxChinaExplicitlyEnabled(ctx.config)) {
    return false;
  }

  return isAnyProviderIdAvailable({
    ctx,
    candidateIds: ["minimax"],
    fallbackOnError: false,
  });
}

function createMiniMaxProvider(spec: MiniMaxProviderSpec): QuotaProvider {
  return {
    id: spec.id,

    async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
      const providerAvailable = await isMiniMaxProviderRuntimeAvailable(ctx, spec);
      if (!providerAvailable) {
        return false;
      }

      const auth = await spec.resolveAuthCached({
        maxAgeMs: DEFAULT_MINIMAX_AUTH_CACHE_MAX_AGE_MS,
      });
      return auth.state === "configured" || auth.state === "invalid";
    },

    matchesCurrentModel(model: string, context?: QuotaProviderMatchContext): boolean {
      return matchesMiniMaxCurrentModel(model, spec, context);
    },

    async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
      const auth = await spec.resolveAuthCached({
        maxAgeMs: DEFAULT_MINIMAX_AUTH_CACHE_MAX_AGE_MS,
      });

      if (auth.state === "none") {
        return notAttemptedResult();
      }

      if (auth.state === "invalid") {
        return attemptedErrorResult(spec.label, auth.error);
      }

      const result = await queryMiniMaxQuota(auth.apiKey, {
        endpoint: spec.endpoint,
        label: spec.label,
        requestTimeoutMs: ctx.config?.requestTimeoutMs,
      });

      if (!result.success) {
        return attemptedErrorResult(spec.label, result.error);
      }

      return attemptedResult(
        result.entries.map((entry) => ({
          ...entry,
          accounting: {
            resultType: "quota",
            acquisitionMethod: "remote_api",
            ownership: "maintained",
            authority: "provider_reported",
          },
        })),
      );
    },
  };
}

export const minimaxCodingPlanProvider: QuotaProvider = createMiniMaxProvider({
  id: "minimax-coding-plan",
  label: MINIMAX_PROVIDER_LABEL,
  endpoint: "international",
  resolveAuthCached: resolveMiniMaxAuthCached,
});

export const minimaxChinaCodingPlanProvider: QuotaProvider = createMiniMaxProvider({
  id: "minimax-china-coding-plan",
  label: MINIMAX_CHINA_PROVIDER_LABEL,
  endpoint: "china",
  resolveAuthCached: resolveMiniMaxChinaAuthCached,
});
