import type { KimiResult, KimiQuotaWindow, QuotaError } from "./types.js";
import { sanitizeDisplaySnippet, sanitizeDisplayText } from "./display-sanitize.js";
import { clampPercent } from "./format-utils.js";
import { fetchWithTimeout } from "./http.js";
import { resolveKimiAuthCached, DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS } from "./kimi-auth.js";

const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";
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

function getNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
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
    const val = getNonEmptyString(item[key] ?? detail[key]);
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

function toUsageRow(
  data: Record<string, unknown>,
  defaultLabel: string,
): {
  label: string;
  used: number;
  limit: number;
  percentRemaining: number;
  resetTimeIso?: string;
} | null {
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
    label: getNonEmptyString(data.name ?? data.title) ?? defaultLabel,
    used: safeUsed,
    limit: safeLimit,
    percentRemaining,
    resetTimeIso: parseResetTimeIso(data),
  };
}

function extractPayloadData(payload: Record<string, unknown>): {
  usage: unknown;
  limits: unknown;
  topLevelKeys: string[];
} {
  const topLevelKeys = Object.keys(payload);

  if (payload.data !== null && typeof payload.data === "object") {
    const data = payload.data as Record<string, unknown>;
    return {
      usage: data.usage ?? payload.usage,
      limits: data.limits ?? payload.limits,
      topLevelKeys,
    };
  }

  return { usage: payload.usage, limits: payload.limits, topLevelKeys };
}

function describeUnexpectedPayload(topLevelKeys: string[]): string {
  const keys = topLevelKeys.length ? topLevelKeys.join(", ") : "(empty)";
  return `Unexpected response structure (keys: ${keys})`;
}

function parseKimiUsagePayload(payload: Record<string, unknown>): {
  windows: KimiQuotaWindow[];
  topLevelKeys: string[];
} {
  const { usage, limits, topLevelKeys } = extractPayloadData(payload);
  const windows: KimiQuotaWindow[] = [];

  if (usage !== null && typeof usage === "object") {
    const row = toUsageRow(usage as Record<string, unknown>, "Weekly limit");
    if (row) {
      windows.push({
        label: row.label,
        used: row.used,
        limit: row.limit,
        percentRemaining: row.percentRemaining,
        resetTimeIso: row.resetTimeIso,
      });
    }
  }

  if (Array.isArray(limits)) {
    for (let i = 0; i < limits.length; i++) {
      const item = limits[i];
      if (item === null || typeof item !== "object") continue;
      const itemMap = item as Record<string, unknown>;

      const detailRaw = itemMap.detail;
      const detail =
        detailRaw !== null && typeof detailRaw === "object"
          ? (detailRaw as Record<string, unknown>)
          : itemMap;

      const windowRaw = itemMap.window;
      const window =
        windowRaw !== null && typeof windowRaw === "object"
          ? (windowRaw as Record<string, unknown>)
          : {};

      const label = buildLimitLabel(itemMap, detail, window, i);
      const row = toUsageRow(detail, label);
      if (row) {
        windows.push({
          label: row.label,
          used: row.used,
          limit: row.limit,
          percentRemaining: row.percentRemaining,
          resetTimeIso: row.resetTimeIso,
        });
      }
    }
  }

  return { windows, topLevelKeys };
}

type FetchResult =
  | { ok: true; windows: KimiQuotaWindow[]; topLevelKeys: string[] }
  | { ok: false; error: string };

async function fetchKimiQuotaFromUrl(url: string, apiKey: string): Promise<FetchResult> {
  try {
    const resp = await fetchWithTimeout(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": USER_AGENT,
      },
    });

    if (!resp.ok) {
      const text = await resp.text();
      return {
        ok: false,
        error: `Kimi API error ${resp.status}: ${sanitizeDisplaySnippet(text, 120)}`,
      };
    }

    const payload = (await resp.json()) as Record<string, unknown>;
    const { windows, topLevelKeys } = parseKimiUsagePayload(payload);
    return { ok: true, windows, topLevelKeys };
  } catch (err) {
    return {
      ok: false,
      error: sanitizeDisplayText(err instanceof Error ? err.message : String(err)),
    };
  }
}

export async function queryKimiQuota(): Promise<KimiResult> {
  const auth = await resolveKimiAuthCached({ maxAgeMs: DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS });
  if (auth.state === "none") return null;
  if (auth.state === "invalid") {
    return { success: false, error: auth.error };
  }

  const result = await fetchKimiQuotaFromUrl(KIMI_USAGE_URL, auth.apiKey);
  if (result.ok && result.windows.length > 0) {
    return {
      success: true,
      label: "Kimi Code",
      windows: result.windows,
    };
  }

  if (!result.ok) {
    return { success: false, error: result.error };
  }

  // Succeeded structurally but had no usable windows.
  return {
    success: false,
    error: describeUnexpectedPayload(result.topLevelKeys),
  };
}
