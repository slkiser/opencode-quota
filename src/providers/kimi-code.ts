/**
 * Kimi Code quota (global and China endpoints): the three usage ratios. Each key stored in OpenCode
 * is queried as its own account; without stored keys, the key the resolver finds is.
 */

import type { DebugDetail } from "../core/types.js";
import { API_KEY_VENDORS, type ApiKeyLoginSpec, readVendorKeys } from "../lib/api-key-resolver.js";
import { sanitizeDisplaySnippet, sanitizeDisplayText } from "../lib/display-sanitize.js";
import type { QuotaProvider, QuotaProviderContext } from "../lib/entries.js";
import { clampPercent } from "../lib/format-utils.js";
import { errorWords, failureFacts, requestJson } from "../lib/http.js";
import { normalizeQuotaProviderId } from "../lib/provider-metadata.js";
import type { QuotaError } from "../lib/types.js";
import { vendorKeysPolicy } from "./cache-policies.js";
import {
  failedAccount,
  fetchError,
  FIVE_HOUR,
  MONTHLY,
  type ProviderFetchResult,
  type ProviderRow,
  quotaRow,
  WEEKLY,
} from "./contract.js";
import { fetchStoredKeys, isKeyVendorAvailable } from "./key-vendor.js";
import { statusDetailsFromRecord, vendorKeyDetails } from "./result-helpers.js";

type KimiSpec = {
  id: "kimi-code-plan-global" | "kimi-code-plan-cn";
  label: string;
  endpoint: "global" | "cn";
  apiBaseUrl: string;
  auth: ApiKeyLoginSpec;
};

/** One window of the reply: one of the usage ratios. */
type KimiWindow = {
  /** The shared window this usage key reports: its row key, label and kind. */
  row: typeof FIVE_HOUR | typeof WEEKLY | typeof MONTHLY;
  percentRemaining: number;
  resetTimeIso?: string;
};

type KimiReply = { success: true; windows: KimiWindow[]; monthlyCodeRatio?: string } | QuotaError;

const USER_AGENT = "OpenCode-Quota-Toast/1.0";

function getFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function parseResetTimeIso(data: Record<string, unknown>): string | undefined {
  for (const key of ["reset_at", "resetAt", "reset_time", "resetTime"]) {
    const val = data[key];
    if (typeof val === "string" && val.trim().length > 0) {
      const ms = Date.parse(val);
      if (Number.isFinite(ms)) {
        return new Date(ms).toISOString();
      }
    }
  }

  for (const key of ["reset_in", "resetIn", "ttl"]) {
    const seconds = getFiniteNumber(data[key]);
    if (seconds !== undefined && seconds > 0) {
      return new Date(Date.now() + Math.round(seconds * 1000)).toISOString();
    }
  }

  const window = data.window;
  if (window !== null && typeof window === "object") {
    const w = window as Record<string, unknown>;
    const windowSeconds = getFiniteNumber(w.duration);
    if (windowSeconds !== undefined && windowSeconds > 0) {
      return new Date(Date.now() + Math.round(windowSeconds * 1000)).toISOString();
    }
  }

  return undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The windows the reply reports, in display order, exactly the keys the first-party CLI reads:
 * `usage` and `limits` carry the same numbers rounded to whole units. `used_ratio` is a fraction,
 * so 0.15 means 15% used.
 *
 * `limit_month_code` is the Code share inside the monthly pool, not an allowance of its own, so
 * it is no row; its ratio is a debug detail.
 */
const USAGE_WINDOWS = [
  // Each usage key reports one shared window, so its row key, label and kind come from there.
  { usage: "limit_5h", window: FIVE_HOUR },
  { usage: "limit_7d", window: WEEKLY },
  { usage: "limit_month_total", window: MONTHLY },
] as const;

/** The Code share of the monthly pool, as a debug detail; absent without it. */
function monthlyCodeRatio(payload: Record<string, unknown>): string | undefined {
  const item = asObject(asObject(payload.usages)?.limit_month_code);
  const ratio = getFiniteNumber(item?.used_ratio);
  return ratio === undefined ? undefined : ratio.toString();
}

function parseKimiWindows(payload: Record<string, unknown>): KimiWindow[] {
  const usages = asObject(payload.usages);
  if (!usages) return [];

  return USAGE_WINDOWS.flatMap(({ usage, window }) => {
    const item = asObject(usages[usage]);
    const usedRatio = getFiniteNumber(item?.used_ratio);
    if (!item || usedRatio === undefined) return [];
    return [
      {
        row: window,
        percentRemaining: clampPercent(100 - usedRatio * 100),
        resetTimeIso: parseResetTimeIso(item),
      },
    ];
  });
}

async function queryKimiWindows(
  spec: KimiSpec,
  apiKey: string,
  requestTimeoutMs?: number,
): Promise<KimiReply> {
  const reply = await requestJson(`${spec.apiBaseUrl}/usages`, {
    headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": USER_AGENT },
    secrets: [apiKey],
    timeoutMs: requestTimeoutMs,
  });
  if (!reply.ok) {
    const { failure } = reply;
    return {
      success: false,
      error:
        failure.kind === "http"
          ? `Kimi API error ${failure.status}${errorWords(sanitizeDisplaySnippet(failure.detail, 120))}`
          : failure.detail,
      facts: failureFacts(failure),
    };
  }

  try {
    const payload = reply.json as Record<string, unknown>;
    // Read the keys first: a `null` body must fail with Object.keys' error.
    const topLevelKeys = Object.keys(payload);
    const windows = parseKimiWindows(payload);
    const codeRatio = monthlyCodeRatio(payload);
    if (windows.length > 0)
      return { success: true, windows, ...(codeRatio ? { monthlyCodeRatio: codeRatio } : {}) };

    const keys = topLevelKeys.length ? topLevelKeys.join(", ") : "(empty)";
    return { success: false, error: `Unexpected response structure (keys: ${keys})` };
  } catch (err) {
    return {
      success: false,
      error: sanitizeDisplayText(err instanceof Error ? err.message : String(err)),
    };
  }
}

/** One row per window, under the key every other provider uses for that window. */
function kimiRows(windows: readonly KimiWindow[]): ProviderRow[] {
  return windows.map((window) =>
    quotaRow({
      key: window.row.key,
      label: window.row.label,
      window: window.row.window,
      percentRemaining: window.percentRemaining,
      resetsAt: window.resetTimeIso,
    }),
  );
}

/** The Code share of each login's monthly pool, as debug details for /quota_status. */
function monthlyCodeDetails(ratios: ReadonlyMap<string, string>): DebugDetail[] {
  return [...ratios].map(([login, ratio]) => ({
    key: "monthly_code_ratio",
    value: login ? `${login}: ${ratio}` : ratio,
  }));
}

async function fetchKimiQuota(
  spec: KimiSpec,
  ctx: QuotaProviderContext,
): Promise<ProviderFetchResult> {
  const keys = await readVendorKeys(spec.auth, ctx.locationDirectory);
  const authDetails = [
    ...vendorKeyDetails(spec.auth, keys, ctx.locationDirectory),
    ...statusDetailsFromRecord({ api_endpoint: spec.endpoint }),
  ];
  const query = (apiKey: string) => queryKimiWindows(spec, apiKey, ctx.config?.requestTimeoutMs);
  // The Code share of the monthly pool, per login: it is not a row of its own.
  const codeRatios = new Map<string, string>();

  if (!keys.envOrConfig) {
    const stored = await fetchStoredKeys({
      providerName: spec.label,
      keys,
      brokenFirst: true,
      async fetchKey(apiKey, row) {
        const result = await query(apiKey);
        if (result.success && result.monthlyCodeRatio)
          codeRatios.set(row.id, result.monthlyCodeRatio);
        return result.success
          ? { rows: kimiRows(result.windows), errors: [] }
          : { rows: [], errors: [fetchError(result.error, result.facts)] };
      },
    });
    return { ...stored, debug: [...authDetails, ...monthlyCodeDetails(codeRatios)] };
  }

  const result = await query(keys.envOrConfig.key);
  if (!result.success) {
    return {
      attempted: true,
      accounts: [failedAccount(spec.label, result.error, result.facts)],
      debug: [...authDetails, { key: "live_fetch_error", value: result.error }],
    };
  }
  if (result.monthlyCodeRatio) codeRatios.set("", result.monthlyCodeRatio);
  return {
    attempted: true,
    accounts: [{ name: spec.label, rows: kimiRows(result.windows), errors: [] }],
    debug: [...authDetails, ...monthlyCodeDetails(codeRatios)],
  };
}

function kimiProvider(spec: KimiSpec): QuotaProvider {
  return {
    id: spec.id,
    cachePolicy: vendorKeysPolicy(spec.id, spec.endpoint),

    async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
      return await isKeyVendorAvailable({
        ctx,
        providerId: spec.id,
        availability: "listed-and-key",
        readKeys: () => readVendorKeys(spec.auth, ctx.locationDirectory),
      });
    },

    matchesCurrentModel(model: string): boolean {
      const [provider = "", modelId] = model.toLowerCase().split("/", 2);
      return Boolean(modelId) && normalizeQuotaProviderId(provider) === spec.id;
    },

    fetch: (ctx: QuotaProviderContext) => fetchKimiQuota(spec, ctx),
  };
}

// Each region has its own key; the legacy aliases (`kimi`, `kimi-code`, ...) belong to CN.
export const kimiCodePlanGlobalProvider = kimiProvider({
  id: "kimi-code-plan-global",
  label: "Kimi Code",
  endpoint: "global",
  apiBaseUrl: "https://api.kimi.ai/coding/v1",
  auth: API_KEY_VENDORS["kimi-code-plan-global"],
});

export const kimiCodePlanCnProvider = kimiProvider({
  id: "kimi-code-plan-cn",
  label: "Kimi Code (CN)",
  endpoint: "cn",
  apiBaseUrl: "https://api.kimi.com/coding/v1",
  auth: API_KEY_VENDORS["kimi-code-plan-cn"],
});
