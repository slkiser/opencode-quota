/**
 * Kimi Code quota (global and China endpoints): the weekly usage and each named limit. Each key
 * stored in OpenCode is queried as its own account; without stored keys, the key the resolver
 * finds is.
 */

import { classifyWindow } from "../core/windows.js";
import { API_KEY_VENDORS, type ApiKeyLoginSpec, readVendorKeys } from "../lib/api-key-resolver.js";
import { sanitizeDisplaySnippet, sanitizeDisplayText } from "../lib/display-sanitize.js";
import type { QuotaProvider, QuotaProviderContext } from "../lib/entries.js";
import { clampPercent } from "../lib/format-utils.js";
import { failureFacts, requestJson } from "../lib/http.js";
import { nonEmptyString } from "../lib/json-guards.js";
import { normalizeQuotaProviderId } from "../lib/provider-metadata.js";
import type { QuotaError } from "../lib/types.js";
import { vendorKeysPolicy } from "./cache-policies.js";
import {
  failedAccount,
  fetchError,
  keySlug,
  type ProviderFetchResult,
  type ProviderRow,
  quotaRow,
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

/** One window of the reply: the weekly usage or one of the limits. */
type KimiWindow = {
  label: string;
  used: number;
  limit: number;
  percentRemaining: number;
  resetTimeIso?: string;
};

type KimiReply = { success: true; windows: KimiWindow[] } | QuotaError;

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

function buildLimitLabel(
  item: Record<string, unknown>,
  detail: Record<string, unknown>,
  window: Record<string, unknown>,
  index: number,
): string {
  for (const key of ["name", "title", "scope"]) {
    const val = nonEmptyString(item[key] ?? detail[key]);
    if (val) return val;
  }

  const duration = getFiniteNumber(window.duration ?? item.duration ?? detail.duration);
  const timeUnit = String(window.timeUnit ?? item.timeUnit ?? detail.timeUnit ?? "");

  if (duration !== undefined && duration > 0) {
    if (timeUnit.includes("MINUTE")) {
      if (duration >= 60 && duration % 60 === 0) {
        return `${duration / 60}h limit`;
      }
      return `${duration}m limit`;
    }
    if (timeUnit.includes("HOUR")) {
      return `${duration}h limit`;
    }
    if (timeUnit.includes("DAY")) {
      return `${duration}d limit`;
    }
    return `${duration}s limit`;
  }

  return `Limit #${index + 1}`;
}

function toUsageWindow(data: Record<string, unknown>, defaultLabel: string): KimiWindow | null {
  const limit = getFiniteNumber(data.limit);
  let used = getFiniteNumber(data.used);

  if (used === undefined) {
    const remaining = getFiniteNumber(data.remaining);
    if (remaining !== undefined && limit !== undefined) {
      used = limit - remaining;
    }
  }

  if (used === undefined && limit === undefined) {
    return null;
  }

  const safeUsed = used ?? 0;
  const safeLimit = limit ?? 0;
  const percentRemaining =
    safeLimit > 0 ? clampPercent(((safeLimit - safeUsed) / safeLimit) * 100) : 0;

  return {
    label: nonEmptyString(data.name ?? data.title) ?? defaultLabel,
    used: safeUsed,
    limit: safeLimit,
    percentRemaining,
    resetTimeIso: parseResetTimeIso(data),
  };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The weekly `usage` row, then one row per `limits` item (each may sit under `data`). */
function parseKimiWindows(payload: Record<string, unknown>): KimiWindow[] {
  const data = asObject(payload.data);
  const usage = asObject(data?.usage ?? payload.usage);
  const limits = data?.limits ?? payload.limits;
  const windows: KimiWindow[] = [];

  const usageWindow = usage ? toUsageWindow(usage, "Weekly limit") : null;
  if (usageWindow) windows.push(usageWindow);

  if (Array.isArray(limits)) {
    for (const [index, item] of limits.entries()) {
      const itemMap = asObject(item);
      if (!itemMap) continue;
      const detail = asObject(itemMap.detail) ?? itemMap;
      const window = asObject(itemMap.window) ?? {};
      const limitWindow = toUsageWindow(detail, buildLimitLabel(itemMap, detail, window, index));
      if (limitWindow) windows.push(limitWindow);
    }
  }

  return windows;
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
          ? `Kimi API error ${failure.status}: ${sanitizeDisplaySnippet(failure.detail, 120)}`
          : failure.detail,
      facts: failureFacts(failure),
    };
  }

  try {
    const payload = reply.json as Record<string, unknown>;
    // Read the keys first: a `null` body must fail with Object.keys' error.
    const topLevelKeys = Object.keys(payload);
    const windows = parseKimiWindows(payload);
    if (windows.length > 0) return { success: true, windows };

    const keys = topLevelKeys.length ? topLevelKeys.join(", ") : "(empty)";
    return { success: false, error: `Unexpected response structure (keys: ${keys})` };
  } catch (err) {
    return {
      success: false,
      error: sanitizeDisplayText(err instanceof Error ? err.message : String(err)),
    };
  }
}

/** The weekly window keeps the key `weekly`; every other limit is `limit.<its name>`. */
function kimiRows(windows: readonly KimiWindow[]): ProviderRow[] {
  return windows.flatMap((window) => {
    const name = window.label.replace(/:+$/u, "").trim();
    const kind = classifyWindow(name);
    const values = { percentRemaining: window.percentRemaining, resetsAt: window.resetTimeIso };
    if (kind === "week") return [quotaRow({ key: "weekly", label: name, window: kind, ...values })];
    const limit = keySlug(name.replace(/\s+limit$/iu, "")) || keySlug(name);
    return limit ? [quotaRow({ key: `limit.${limit}`, label: name, window: kind, ...values })] : [];
  });
}

async function fetchKimiQuota(
  spec: KimiSpec,
  ctx: QuotaProviderContext,
): Promise<ProviderFetchResult> {
  const keys = await readVendorKeys(spec.auth);
  const authDetails = [
    ...vendorKeyDetails(spec.auth, keys),
    ...statusDetailsFromRecord({ api_endpoint: spec.endpoint, api_base_url: spec.apiBaseUrl }),
  ];
  const query = (apiKey: string) => queryKimiWindows(spec, apiKey, ctx.config?.requestTimeoutMs);

  if (!keys.envOrConfig) {
    const stored = await fetchStoredKeys({
      providerName: spec.label,
      keys,
      brokenFirst: true,
      async fetchKey(apiKey) {
        const result = await query(apiKey);
        return result.success
          ? { rows: kimiRows(result.windows), errors: [] }
          : { rows: [], errors: [fetchError(result.error, result.facts)] };
      },
    });
    return { ...stored, debug: authDetails };
  }

  const result = await query(keys.envOrConfig.key);
  if (!result.success) {
    return {
      attempted: true,
      accounts: [failedAccount(spec.label, result.error, result.facts)],
      debug: [...authDetails, { key: "live_fetch_error", value: result.error }],
    };
  }
  return {
    attempted: true,
    accounts: [{ name: spec.label, rows: kimiRows(result.windows), errors: [] }],
    debug: [
      ...authDetails,
      ...result.windows.map((window) => ({
        key: window.label.toLowerCase().replace(/\s+/g, "_"),
        value: `used=${window.used}/${window.limit} percent_remaining=${window.percentRemaining} reset_at=${window.resetTimeIso ?? "(none)"}`,
      })),
    ],
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
        readKeys: () => readVendorKeys(spec.auth),
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
