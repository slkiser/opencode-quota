import { sanitizeSingleLineDisplayText } from "./display-sanitize.js";
import type { NineRouterHttpResult } from "./nine-router-http.js";
import { createNineRouterManagementRequest } from "./nine-router-http.js";

export { NINE_ROUTER_MAX_BODY_BYTES } from "./nine-router-http.js";

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
  });
}
const MAX_CONNECTIONS = 500;
const MAX_DISCOVERY_CONNECTIONS = 5000;
const MAX_DISCOVERY_PAGES = 10;

export type NineRouterAccount = {
  readonly id: string;
  readonly provider: string;
  readonly name?: string;
  readonly displayName?: string;
  readonly email?: string;
};
export type NineRouterUsageWindow = {
  readonly kind: string;
  readonly percentRemaining: number;
  readonly resetTimeIso?: string;
};
type NineRouterConfig = {
  readonly request: (path: string, timeoutMs?: number) => Promise<NineRouterHttpResult>;
};
export type NineRouterConfigResult =
  | { readonly success: true; readonly root: string }
  | { readonly success: false; readonly error: string };
export type NineRouterAccountsResult =
  | {
      readonly success: true;
      readonly accounts: readonly NineRouterAccount[];
      readonly errors?: readonly { readonly error: string }[];
    }
  | { readonly success: false; readonly error: string; readonly retryAfterMs?: number };
export type NineRouterUsageResult =
  | {
      readonly success: true;
      readonly windows: readonly NineRouterUsageWindow[];
      readonly errors?: readonly { readonly error: string }[];
    }
  | {
      readonly success: false;
      readonly error: string;
      readonly retryAfterMs?: number;
      readonly safeDisplayMessage?: true;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
function safeConfigError(): NineRouterConfigResult {
  return { success: false, error: "nineRouter management configuration is invalid" };
}
function safeConnectionId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return id && id.length <= 256 && !hasControlCharacter(id) ? id : null;
}
function safeProvider(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const provider = value.trim().toLowerCase();
  return provider && Array.from(provider).length <= 128 && !hasControlCharacter(provider)
    ? provider
    : null;
}
function safeQuotaKey(value: string): string | null {
  const key = value.trim();
  return key && Array.from(key).length <= 128 && !hasControlCharacter(key) ? key : null;
}
function safeMessage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const message = sanitizeSingleLineDisplayText(value);
  return message && Array.from(message).length <= 500 ? message : null;
}
function safeLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = sanitizeSingleLineDisplayText(value);
  return label && Array.from(label).length <= 256 ? label : null;
}
function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}
function safePagination(
  value: unknown,
  page: number,
): { readonly total: number; readonly totalPages: number } | null {
  if (!isRecord(value)) return null;
  const responsePage = value.page,
    responsePageSize = value.pageSize,
    total = value.total,
    totalPages = value.totalPages;
  if (
    !isInteger(responsePage) ||
    responsePage !== page ||
    !isInteger(responsePageSize) ||
    responsePageSize !== MAX_CONNECTIONS ||
    !isInteger(total) ||
    total < 0 ||
    total > MAX_DISCOVERY_CONNECTIONS ||
    !isInteger(totalPages) ||
    totalPages < 0 ||
    totalPages > MAX_DISCOVERY_PAGES ||
    (total === 0 ? totalPages > 1 : totalPages !== Math.ceil(total / responsePageSize)) ||
    (total > 0 && responsePage > totalPages)
  )
    return null;
  return { total, totalPages };
}
const managementConfigs = new WeakMap<object, NineRouterConfig>();
export function resolveNineRouterConfig(
  env: NodeJS.ProcessEnv = process.env,
): NineRouterConfigResult {
  const rootValue = env.OPENCODE_NINEROUTER_URL?.trim(),
    key = env.OPENCODE_NINEROUTER_API_KEY?.trim();
  if (!rootValue || !key) return safeConfigError();
  let root: URL;
  try {
    root = new URL(rootValue);
  } catch {
    return safeConfigError();
  }
  const pathname = root.pathname.replace(/\/+$/u, "") || "/";
  if (
    root.username ||
    root.password ||
    root.search ||
    root.hash ||
    (root.protocol !== "https:" && !(root.protocol === "http:" && isLoopback(root.hostname))) ||
    pathname.toLowerCase() === "/v1"
  )
    return safeConfigError();
  const normalizedRoot = `${root.origin}${pathname === "/" ? "" : pathname}`;
  const result: NineRouterConfigResult = { success: true, root: normalizedRoot };
  managementConfigs.set(result, {
    request: createNineRouterManagementRequest(normalizedRoot, key),
  });
  return result;
}
function configFromResult(result: NineRouterConfigResult): NineRouterConfig | null {
  return result.success ? (managementConfigs.get(result) ?? null) : null;
}
export async function fetchNineRouterAccounts(
  result: NineRouterConfigResult,
  provider?: string,
): Promise<NineRouterAccountsResult> {
  const config = configFromResult(result);
  if (!config) return { success: false, error: "nineRouter management configuration is invalid" };
  const requestedProvider = provider === undefined ? undefined : safeProvider(provider);
  if (requestedProvider === null)
    return { success: false, error: "Invalid nineRouter provider response" };
  const accounts: NineRouterAccount[] = [],
    errors: { error: string }[] = [],
    connectionIds = new Set<string>();
  let total: number | null = null,
    totalPages: number | null = null;
  for (let page = 1; totalPages === null || page <= totalPages; page += 1) {
    const providerQuery =
      requestedProvider === undefined ? "" : `provider=${encodeURIComponent(requestedProvider)}&`;
    const response = await config.request(
      `/api/providers/client?${providerQuery}accountStatus=active&page=${page}&pageSize=500&sort=priority`,
    );
    if (!response.success) return response;
    if (!isRecord(response.body) || !Array.isArray(response.body.connections))
      return { success: false, error: "Invalid nineRouter provider response" };
    const pagination = safePagination(response.body.pagination, page);
    if (
      !pagination ||
      (total !== null && pagination.total !== total) ||
      (totalPages !== null && pagination.totalPages !== totalPages) ||
      response.body.connections.length > MAX_CONNECTIONS
    )
      return { success: false, error: "Invalid nineRouter provider response" };
    total = pagination.total;
    totalPages = pagination.totalPages;
    if (totalPages === 0) break;
    for (const value of response.body.connections) {
      const id = isRecord(value) ? safeConnectionId(value.id) : null,
        connectionProvider = isRecord(value) ? safeProvider(value.provider) : null,
        active = isRecord(value) && value.isActive !== false;
      if (
        !id ||
        !connectionProvider ||
        !active ||
        (requestedProvider !== undefined && connectionProvider !== requestedProvider)
      ) {
        errors.push({ error: "Invalid account identifier" });
        continue;
      }
      if (connectionIds.has(id)) continue;
      connectionIds.add(id);
      const name = safeLabel(value.name),
        displayName = safeLabel(value.displayName),
        email = safeLabel(value.email);
      accounts.push({
        id,
        provider: connectionProvider,
        ...(name ? { name } : {}),
        ...(displayName ? { displayName } : {}),
        ...(email ? { email } : {}),
      });
    }
  }
  return { success: true, accounts, ...(errors.length ? { errors } : {}) };
}
function parseResetTime(value: unknown): string | undefined {
  const timestamp =
      typeof value === "string"
        ? Date.parse(value)
        : typeof value === "number"
          ? value * (value < 1e12 ? 1000 : 1)
          : Number.NaN,
    date = new Date(timestamp);
  return Number.isFinite(timestamp) && timestamp > 0 && Number.isFinite(date.getTime())
    ? date.toISOString()
    : undefined;
}
function parseResetAfterSeconds(value: unknown): string | undefined {
  const timestamp =
      typeof value === "number" && Number.isFinite(value) ? Date.now() + value * 1000 : Number.NaN,
    date = new Date(timestamp);
  return Number.isFinite(timestamp) && timestamp > 0 && Number.isFinite(date.getTime())
    ? date.toISOString()
    : undefined;
}
function parseQuota(key: string, value: unknown): NineRouterUsageWindow | null {
  if (!isRecord(value)) return null;
  const percent =
    value.unlimited === true
      ? 100
      : typeof value.remainingPercentage === "number" && Number.isFinite(value.remainingPercentage)
        ? value.remainingPercentage
        : typeof value.used_percent === "number" && Number.isFinite(value.used_percent)
          ? 100 - value.used_percent
          : typeof value.percent_used === "number" && Number.isFinite(value.percent_used)
            ? 100 - value.percent_used
            : typeof value.used === "number" &&
                Number.isFinite(value.used) &&
                typeof value.total === "number" &&
                Number.isFinite(value.total) &&
                value.total > 0
              ? (100 * (value.total - value.used)) / value.total
              : Number.NaN;
  if (!Number.isFinite(percent)) return null;
  const resetTimeIso =
    value.resetAt !== undefined
      ? parseResetTime(value.resetAt)
      : value.reset_at !== undefined
        ? parseResetTime(value.reset_at)
        : value.resets_at !== undefined
          ? parseResetTime(value.resets_at)
          : value.reset_after_seconds !== undefined
            ? parseResetAfterSeconds(value.reset_after_seconds)
            : undefined;
  return {
    kind: key,
    percentRemaining: Math.min(100, Math.max(0, percent)),
    ...(resetTimeIso ? { resetTimeIso } : {}),
  };
}
export async function fetchNineRouterUsage(
  result: NineRouterConfigResult,
  id: string,
  timeoutMs?: number,
): Promise<NineRouterUsageResult> {
  const config = configFromResult(result);
  if (!config) return { success: false, error: "nineRouter management configuration is invalid" };
  const safeId = safeConnectionId(id);
  if (!safeId) return { success: false, error: "Invalid account identifier" };
  const response = await config.request(`/api/usage/${encodeURIComponent(safeId)}`, timeoutMs);
  if (!response.success) return response;
  if (!isRecord(response.body) || !isRecord(response.body.quotas)) {
    const message = isRecord(response.body) ? safeMessage(response.body.message) : null;
    return {
      success: false,
      error: message ?? "Invalid nineRouter usage response",
      ...(message ? { safeDisplayMessage: true as const } : {}),
    };
  }
  const keys = new Map<string, string>(),
    collisions = new Set<string>();
  for (const rawKey of Object.keys(response.body.quotas)) {
    const key = safeQuotaKey(rawKey);
    if (!key) continue;
    const prior = keys.get(key);
    if (prior !== undefined && prior !== rawKey) collisions.add(key);
    keys.set(key, rawKey);
  }
  const windows: NineRouterUsageWindow[] = [];
  for (const [key, rawKey] of keys) {
    if (collisions.has(key)) continue;
    const quota = parseQuota(key, response.body.quotas[rawKey]);
    if (quota) windows.push(quota);
  }
  const errors = collisions.size
    ? [{ error: "Ambiguous nineRouter quota key after normalization" }]
    : [];
  if (windows.length || errors.length)
    return { success: true, windows, ...(errors.length ? { errors } : {}) };
  const message = safeMessage(response.body.message);
  return {
    success: false,
    error: message ?? "Invalid nineRouter usage response",
    ...(message ? { safeDisplayMessage: true as const } : {}),
  };
}
