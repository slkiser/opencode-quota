/** MiniMax Token Plan quota (international and China endpoints), one canonical model per account. */

import type { ErrorFacts } from "../core/errors.js";
import type { Amount } from "../core/types.js";
import { API_KEY_VENDORS, type ApiKeyLoginSpec, readVendorKeys } from "../lib/api-key-resolver.js";
import { sanitizeDisplayText } from "../lib/display-sanitize.js";
import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderMatchContext,
} from "../lib/entries.js";
import { failureFacts, requestJson } from "../lib/http.js";
import { asRecord } from "../lib/json-guards.js";
import {
  isAnyProviderIdAvailable,
  isCanonicalProviderAvailable,
} from "../lib/provider-availability.js";
import { normalizeQuotaProviderId } from "../lib/provider-metadata.js";
import { accountingDecimalFromNumber } from "./accounting-decimal.js";
import { vendorKeysPolicy } from "./cache-policies.js";
import {
  FIVE_HOUR,
  failedAccount,
  fetchError,
  type ProviderFetchResult,
  type ProviderRow,
  quotaRow,
  WEEKLY,
} from "./contract.js";
import { fetchStoredKeys, isKeyVendorAvailable } from "./key-vendor.js";
import { statusDetailsFromRecord, vendorKeyDetails, vendorKeyState } from "./result-helpers.js";

const USER_AGENT = "OpenCode-Quota-Toast/1.0";
const REQUEST_UNIT = { kind: "count", unit: "request" } as const;

type MiniMaxQuotaEndpointId = "international" | "china";

/** Each region's quota URL. */
const MINIMAX_QUOTA_URLS: Readonly<Record<MiniMaxQuotaEndpointId, string>> = {
  international: "https://api.minimax.io/v1/api/openplatform/coding_plan/remains",
  // CN Token Plan docs use this path on minimaxi.com; api.minimaxi.com returns MiniMax base_resp auth errors for it.
  china: "https://api.minimaxi.com/v1/token_plan/remains",
};

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
  /** Provider-reported remaining percentage used by supported percentage-only responses. */
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

interface MiniMaxWindowSpec {
  slot: typeof FIVE_HOUR | typeof WEEKLY;
  getTotal(model: MiniMaxModelRemain): number | undefined;
  getCount(model: MiniMaxModelRemain): number | undefined;
  getResetOffsetMs(model: MiniMaxModelRemain): number | undefined;
  getPercentRemaining(model: MiniMaxModelRemain): number | undefined;
}

const MINIMAX_WINDOW_SPECS: readonly MiniMaxWindowSpec[] = [
  {
    slot: FIVE_HOUR,
    getTotal: (model) => model.current_interval_total_count,
    getCount: (model) => model.current_interval_usage_count,
    getResetOffsetMs: (model) => model.remains_time,
    getPercentRemaining: (model) => model.current_interval_remaining_percent,
  },
  {
    slot: WEEKLY,
    getTotal: (model) => model.current_weekly_total_count,
    getCount: (model) => model.current_weekly_usage_count,
    getResetOffsetMs: (model) => model.weekly_remains_time,
    getPercentRemaining: (model) => model.current_weekly_remaining_percent,
  },
];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Accepts the count shape or the percentage-only shape; a finite 5-hour reset offset is required. */
function isMiniMaxModelRecord(value: unknown): value is MiniMaxModelRemain {
  const v = asRecord(value);
  if (!v || typeof v.model_name !== "string" || !isFiniteNumber(v.remains_time)) return false;
  const hasCounts =
    isFiniteNumber(v.current_interval_total_count) &&
    isFiniteNumber(v.current_interval_usage_count);
  return hasCounts || isFiniteNumber(v.current_interval_remaining_percent);
}

function isMiniMaxCodingModelName(modelName: string): boolean {
  const normalized = modelName.trim().toLowerCase();
  return normalized.startsWith("minimax-m") || normalized === "general";
}

function roundPercent(value: number): number {
  return Math.min(100, Math.round(value));
}

function requests(value: number): Amount {
  return { decimal: accountingDecimalFromNumber(value), unit: REQUEST_UNIT };
}

function sanitizeMiniMaxMessage(text: string): string {
  const sanitized = sanitizeDisplayText(text).replace(/\s+/g, " ").trim();
  return (sanitized || "unknown").slice(0, 120);
}

/**
 * Used, limit and remaining for a row with a positive total. The raw count is
 * endpoint-specific: China reports the used count, international the remaining count.
 */
function countAmounts(total: number, rawCount: number, endpointId: MiniMaxQuotaEndpointId) {
  const reportsUsed = endpointId === "china";
  const used = reportsUsed ? Math.max(0, rawCount) : total - Math.min(total, rawCount);
  const remaining = reportsUsed ? total - used : Math.min(total, rawCount);
  return { used, remaining };
}

function minimaxRow(
  model: MiniMaxModelRemain,
  spec: MiniMaxWindowSpec,
  endpointId: MiniMaxQuotaEndpointId,
): ProviderRow | null {
  const resetOffsetMs = spec.getResetOffsetMs(model);
  if (!isFiniteNumber(resetOffsetMs)) return null;
  const resetsAt = new Date(Date.now() + Math.max(0, resetOffsetMs)).toISOString();

  const total = spec.getTotal(model);
  const rawCount = spec.getCount(model);
  if (isFiniteNumber(total) && total > 0 && isFiniteNumber(rawCount)) {
    const { used, remaining } = countAmounts(total, rawCount, endpointId);
    return {
      ...quotaRow({
        ...spec.slot,
        percentRemaining: roundPercent((remaining / total) * 100),
        resetsAt,
      }),
      used: requests(used),
      limit: requests(total),
      remaining: requests(remaining),
    };
  }

  // New plan rows (general bucket, total=0) only report a percent. China counts never fall
  // back to it except on general rows.
  const percent =
    endpointId === "international" || model.model_name.trim().toLowerCase() === "general"
      ? spec.getPercentRemaining(model)
      : undefined;
  if (!isFiniteNumber(percent)) return null;
  return quotaRow({ ...spec.slot, percentRemaining: roundPercent(percent), resetsAt });
}

function minimaxRows(model: MiniMaxModelRemain, endpointId: MiniMaxQuotaEndpointId): ProviderRow[] {
  return MINIMAX_WINDOW_SPECS.flatMap((spec) => {
    const row = minimaxRow(model, spec, endpointId);
    return row ? [row] : [];
  });
}

function getWorstPercent(model: MiniMaxModelRemain, endpointId: MiniMaxQuotaEndpointId): number {
  const percents = minimaxRows(model, endpointId).flatMap((row) =>
    row.percentRemaining === undefined ? [] : [row.percentRemaining],
  );
  return percents.length > 0 ? Math.min(...percents) : Number.POSITIVE_INFINITY;
}

/** The `MiniMax-M*` wildcard row when it reports quota, else the model with the least left. */
function selectCanonicalMiniMaxModel(
  models: MiniMaxModelRemain[],
  endpointId: MiniMaxQuotaEndpointId,
): MiniMaxModelRemain | null {
  const wildcardModel = models.find(
    (model) => model.model_name.trim().toLowerCase() === "minimax-m*",
  );
  if (wildcardModel && Number.isFinite(getWorstPercent(wildcardModel, endpointId))) {
    return wildcardModel;
  }

  return (
    [...models].sort((left, right) => {
      const percentDiff = getWorstPercent(left, endpointId) - getWorstPercent(right, endpointId);
      if (percentDiff !== 0) return percentDiff;
      return left.model_name.localeCompare(right.model_name);
    })[0] ?? null
  );
}

/** The rows of one key (none when no coding model reports quota), or the error. */
async function queryMiniMaxQuota(
  apiKey: string,
  endpointId: MiniMaxQuotaEndpointId,
  requestTimeoutMs: number | undefined,
): Promise<{ rows: ProviderRow[] } | { error: string; facts?: ErrorFacts }> {
  const reply = await requestJson(MINIMAX_QUOTA_URLS[endpointId], {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": USER_AGENT },
    secrets: [apiKey],
    timeoutMs: requestTimeoutMs,
  });
  if (!reply.ok) {
    const { failure } = reply;
    return {
      error:
        failure.kind === "http"
          ? `MiniMax API error ${failure.status}: ${sanitizeMiniMaxMessage(failure.detail)}`
          : sanitizeMiniMaxMessage(failure.detail),
      facts: failureFacts(failure),
    };
  }

  try {
    const payload = reply.json as MiniMaxApiResponse;
    if (payload.base_resp?.status_code !== 0) {
      return {
        error: `MiniMax API error: ${sanitizeMiniMaxMessage(payload.base_resp?.status_msg ?? "unknown")}`,
      };
    }

    const matchingModels = (payload.model_remains ?? []).filter(
      (model): model is MiniMaxModelRemain =>
        isMiniMaxModelRecord(model) && isMiniMaxCodingModelName(model.model_name),
    );
    const canonicalModel = selectCanonicalMiniMaxModel(matchingModels, endpointId);
    return { rows: canonicalModel ? minimaxRows(canonicalModel, endpointId) : [] };
  } catch (err) {
    return { error: sanitizeMiniMaxMessage(err instanceof Error ? err.message : String(err)) };
  }
}

type MiniMaxSpec = {
  id: "minimax-coding-plan" | "minimax-china-coding-plan";
  label: string;
  endpoint: MiniMaxQuotaEndpointId;
  auth: ApiKeyLoginSpec;
};

/** The ambiguous `minimax` runtime id counts for China only when China is explicitly enabled. */
function isMiniMaxChinaExplicitlyEnabled(context?: QuotaProviderMatchContext): boolean {
  if (!context || context.automaticDiscovery || context.enabledProviders === "auto") return false;
  return context.enabledProviders.some(
    (providerId) => normalizeQuotaProviderId(providerId) === "minimax-china-coding-plan",
  );
}

async function fetchMiniMaxQuota(
  spec: MiniMaxSpec,
  ctx: QuotaProviderContext,
): Promise<ProviderFetchResult> {
  const keys = await readVendorKeys(spec.auth, ctx.locationDirectory);
  const configured = vendorKeyState(keys).state === "configured";
  const debug = [
    ...vendorKeyDetails(spec.auth, keys, ctx.locationDirectory),
    ...statusDetailsFromRecord({ api_endpoint: configured ? spec.endpoint : undefined }),
  ];
  const query = (apiKey: string) =>
    queryMiniMaxQuota(apiKey, spec.endpoint, ctx.config?.requestTimeoutMs);

  if (!keys.envOrConfig) {
    const stored = await fetchStoredKeys({
      providerName: spec.label,
      keys,
      brokenFirst: true,
      async fetchKey(apiKey) {
        const result = await query(apiKey);
        return "error" in result
          ? { rows: [], errors: [fetchError(result.error, result.facts)] }
          : { rows: result.rows, errors: [] };
      },
    });
    return { ...stored, debug };
  }

  const result = await query(keys.envOrConfig.key);
  if ("error" in result) {
    return {
      attempted: true,
      accounts: [failedAccount(spec.label, result.error, result.facts)],
      debug: [...debug, { key: "live_fetch_error", value: result.error }],
    };
  }

  return {
    attempted: true,
    accounts: [{ name: spec.label, rows: result.rows, errors: [] }],
    debug,
  };
}

function minimaxProvider(spec: MiniMaxSpec): QuotaProvider {
  return {
    id: spec.id,
    cachePolicy: vendorKeysPolicy(spec.id, spec.endpoint),

    async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
      return await isKeyVendorAvailable({
        ctx,
        providerId: spec.id,
        availability: "listed-and-key",
        readKeys: () => readVendorKeys(spec.auth, ctx.locationDirectory),
        // The China plan also counts OpenCode's `minimax` when the user enabled the China plan.
        isListed: async () =>
          (await isCanonicalProviderAvailable({
            ctx,
            providerId: spec.id,
            fallbackOnError: false,
          })) ||
          (spec.id === "minimax-china-coding-plan" &&
            isMiniMaxChinaExplicitlyEnabled(ctx.config) &&
            (await isAnyProviderIdAvailable({
              ctx,
              candidateIds: ["minimax"],
              fallbackOnError: false,
            }))),
      });
    },

    matchesCurrentModel(model: string, context?: QuotaProviderMatchContext): boolean {
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
    },

    fetch: (ctx: QuotaProviderContext) => fetchMiniMaxQuota(spec, ctx),
  };
}

// The international and China plans have separate keys; the China env key never
// configures the international provider.
export const minimaxCodingPlanProvider = minimaxProvider({
  id: "minimax-coding-plan",
  label: "MiniMax Token Plan",
  endpoint: "international",
  auth: API_KEY_VENDORS["minimax-coding-plan"],
});

export const minimaxChinaCodingPlanProvider = minimaxProvider({
  id: "minimax-china-coding-plan",
  label: "MiniMax Token Plan (CN)",
  endpoint: "china",
  auth: API_KEY_VENDORS["minimax-china-coding-plan"],
});
