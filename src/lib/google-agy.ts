import crypto from "node:crypto";
import { readAuthFileCached } from "./opencode-auth.js";
import { fetchWithTimeout } from "./http.js";
import {
  getCachedAccessToken,
  makeAccountCacheKey,
  setCachedAccessToken,
} from "./google-token-cache.js";
import {
  clearAgyCompanionCacheForTests,
  inspectAgyCompanionPresence,
  resolveAgyClientCredentials,
  type AgyConfiguredCredentials,
} from "./google-agy-companion.js";
import type {
  AuthData,
  GoogleAgyAuthSourceKey,
  GoogleAgyQuotaBucket,
  GoogleAgyQuotaWindow,
  GoogleAgyResult,
  GoogleAccountError,
  GeminiCliOAuthAuthData,
} from "./types.js";

export const DEFAULT_AGY_AUTH_CACHE_MAX_AGE_MS = 5_000;

export const AGY_AUTH_KEYS = [
  "google-agy",
  "opencode-agy-auth",
  "google-agy-auth",
] as const satisfies readonly GoogleAgyAuthSourceKey[];

const AGY_CODE_ASSIST_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const AGY_QUOTA_API_URL = `${AGY_CODE_ASSIST_ENDPOINT}/v1internal:retrieveUserQuota`;
const AGY_TOKEN_REFRESH_URL = "https://oauth2.googleapis.com/token";
const AGY_TOKEN_TIMEOUT_MS = 8_000;
const AGY_QUOTA_TIMEOUT_MS = 6_000;
const AGY_ACCOUNTS_CONCURRENCY = 3;
const AGY_USER_AGENT = "antigravity/cli/1.0.3 darwin/amd64";

function createAgyActivityRequestId(): string {
  return crypto.randomUUID();
}

type RefreshParts = {
  refreshToken: string;
  projectId?: string;
  managedProjectId?: string;
};

export type AgyAccount = {
  sourceKey: GoogleAgyAuthSourceKey;
  refreshToken: string;
  projectId: string;
  email?: string;
  accessToken?: string;
  expiresAt?: number;
};

function createAgyAccountKey(account: Pick<AgyAccount, "sourceKey" | "refreshToken" | "projectId">): string {
  return crypto
    .createHash("sha256")
    .update(account.sourceKey)
    .update("\0")
    .update(account.projectId)
    .update("\0")
    .update(account.refreshToken)
    .digest("hex");
}

export type AgyAuthPresence =
  | {
      state: "missing";
      sourceKey?: undefined;
      accountCount: 0;
      validAccountCount: 0;
    }
  | {
      state: "present";
      sourceKey: GoogleAgyAuthSourceKey;
      accountCount: number;
      validAccountCount: number;
    }
  | {
      state: "invalid";
      sourceKey?: GoogleAgyAuthSourceKey;
      accountCount: number;
      validAccountCount: number;
      error: string;
    };

type RetrieveUserQuotaBucket = {
  remainingAmount?: string;
  remainingFraction?: number;
  resetTime?: string;
  tokenType?: string;
  modelId?: string;
};

type RetrieveUserQuotaResponse = {
  buckets?: RetrieveUserQuotaBucket[];
};

type ConfigClient = {
  config?: {
    get?: () => Promise<{ data?: unknown }>;
  };
};

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function parseAgyRefreshParts(refresh: string | undefined): RefreshParts {
  const [refreshToken = "", projectId = "", managedProjectId = ""] = (refresh ?? "").split("|");
  return {
    refreshToken: refreshToken.trim(),
    ...(normalizeString(projectId) ? { projectId: projectId.trim() } : {}),
    ...(normalizeString(managedProjectId) ? { managedProjectId: managedProjectId.trim() } : {}),
  };
}

export function resolveAgyAccounts(
  auth: AuthData | null | undefined,
  configuredProjectId?: string,
): AgyAccount[] {
  if (!auth) {
    return [];
  }

  const accounts: AgyAccount[] = [];
  const seen = new Set<string>();

  for (const sourceKey of AGY_AUTH_KEYS) {
    const entry = auth[sourceKey] as GeminiCliOAuthAuthData | undefined;
    if (!entry || entry.type !== "oauth") {
      continue;
    }

    const parts = parseAgyRefreshParts(entry.refresh);
    if (!parts.refreshToken) {
      continue;
    }

    const projectId =
      normalizeString(entry.managedProjectId) ??
      normalizeString(entry.quotaProjectId) ??
      parts.managedProjectId ??
      normalizeString(entry.projectId) ??
      normalizeString(entry.projectID) ??
      parts.projectId ??
      normalizeString(configuredProjectId);

    if (!projectId) {
      continue;
    }

    const email =
      normalizeString(entry.email) ??
      normalizeString(entry.accountEmail) ??
      normalizeString(entry.login);

    const key = `${parts.refreshToken}\n${projectId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    accounts.push({
      sourceKey,
      refreshToken: parts.refreshToken,
      projectId,
      ...(email ? { email } : {}),
      ...(normalizeString(entry.access) ? { accessToken: entry.access!.trim() } : {}),
      ...(typeof entry.expires === "number" ? { expiresAt: entry.expires } : {}),
    });
  }

  return accounts;
}

export async function resolveAgyConfiguredProjectId(
  client?: ConfigClient,
): Promise<string | undefined> {
  const explicitEnvProjectId = normalizeString(process.env.OPENCODE_AGY_PROJECT_ID);
  if (explicitEnvProjectId) {
    return explicitEnvProjectId;
  }

  if (client?.config?.get) {
    try {
      const result = await client.config.get();
      const data = result?.data as { provider?: Record<string, { options?: Record<string, unknown> }> };
      const configProjectId = normalizeString(data?.provider?.["google-agy"]?.options?.projectId);
      if (configProjectId) {
        return configProjectId;
      }
    } catch {
      // ignore and fall back
    }
  }

  return (
    normalizeString(process.env.GOOGLE_CLOUD_PROJECT) ??
    normalizeString(process.env.GOOGLE_CLOUD_PROJECT_ID)
  );
}

export async function inspectAgyAuthPresence(client?: ConfigClient): Promise<AgyAuthPresence> {
  const [auth, configuredProjectId] = await Promise.all([
    readAuthFileCached({ maxAgeMs: DEFAULT_AGY_AUTH_CACHE_MAX_AGE_MS }),
    resolveAgyConfiguredProjectId(client),
  ]);

  let accountCount = 0;
  if (auth) {
    for (const sourceKey of AGY_AUTH_KEYS) {
      const entry = auth[sourceKey];
      if (entry && entry.type === "oauth") {
        accountCount++;
      }
    }
  }

  if (accountCount === 0) {
    return { state: "missing", accountCount: 0, validAccountCount: 0 };
  }

  const accounts = resolveAgyAccounts(auth, configuredProjectId);
  const sourceKey = accounts[0]?.sourceKey ?? AGY_AUTH_KEYS.find((key) => auth?.[key]?.type === "oauth");

  if (accounts.length === 0) {
    return {
      state: "invalid",
      ...(sourceKey ? { sourceKey } : {}),
      accountCount,
      validAccountCount: 0,
      error: "Google AGY OAuth auth is missing a refresh token or project id",
    };
  }

  return {
    state: "present",
    sourceKey: accounts[0]!.sourceKey,
    accountCount,
    validAccountCount: accounts.length,
  };
}

export async function hasAgyQuotaRuntimeAvailable(client?: ConfigClient): Promise<boolean> {
  const [authPresence, companionPresence] = await Promise.all([
    inspectAgyAuthPresence(client),
    inspectAgyCompanionPresence(),
  ]);

  return (
    authPresence.state === "present" &&
    authPresence.validAccountCount > 0 &&
    companionPresence.state === "present"
  );
}

async function mapWithConcurrency<T, R>(params: {
  items: T[];
  concurrency: number;
  fn: (item: T, index: number) => Promise<R>;
}): Promise<R[]> {
  const n = Math.max(1, Math.trunc(params.concurrency));
  const results = new Array<R>(params.items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(n, params.items.length) }, async () => {
    while (true) {
      const idx = nextIndex++;
      if (idx >= params.items.length) return;
      results[idx] = await params.fn(params.items[idx]!, idx);
    }
  });

  await Promise.all(workers);
  return results;
}

async function refreshAccessToken(params: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  timeoutMs?: number;
}): Promise<{ accessToken: string; expiresIn: number } | { error: string }> {
  try {
    const response = await fetchWithTimeout(
      AGY_TOKEN_REFRESH_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: params.clientId,
          client_secret: params.clientSecret,
          refresh_token: params.refreshToken,
          grant_type: "refresh_token",
        }),
      },
      params.timeoutMs ?? AGY_TOKEN_TIMEOUT_MS,
    );

    if (!response.ok) {
      try {
        const errorData = (await response.json()) as {
          error?: string;
          error_description?: string;
        };
        if (errorData.error === "invalid_grant") {
          return { error: "Token revoked" };
        }
        return { error: errorData.error_description || `HTTP ${response.status}` };
      } catch {
        return { error: `HTTP ${response.status}` };
      }
    }

    const data = (await response.json()) as {
      access_token: string;
      expires_in: number;
    };

    return {
      accessToken: data.access_token,
      expiresIn: data.expires_in,
    };
  } catch (err) {
    if (err instanceof Error && err.message.includes("timeout")) {
      return { error: "Token refresh timeout" };
    }
    return { error: "Token refresh failed" };
  }
}

async function refreshAgyAccessTokenWithCache(params: {
  account: AgyAccount;
  credentials: AgyConfiguredCredentials;
  skewMs?: number;
  force?: boolean;
  timeoutMs?: number;
}): Promise<{ accessToken: string } | { error: string }> {
  const skewMs = params.skewMs ?? 2 * 60_000;
  const key = makeAccountCacheKey({
    refreshToken: params.account.refreshToken,
    projectId: params.account.projectId,
    email: params.account.email,
  });

  if (!params.force) {
    const cached = await getCachedAccessToken({ key, skewMs });
    if (cached) return { accessToken: cached.accessToken };

    if (
      params.account.accessToken &&
      typeof params.account.expiresAt === "number" &&
      params.account.expiresAt > Date.now() + skewMs
    ) {
      return { accessToken: params.account.accessToken };
    }
  }

  const refreshed = await refreshAccessToken({
    refreshToken: params.account.refreshToken,
    clientId: params.credentials.clientId,
    clientSecret: params.credentials.clientSecret,
    timeoutMs: params.timeoutMs,
  });
  if ("error" in refreshed) return refreshed;

  await setCachedAccessToken({
    key,
    entry: {
      accessToken: refreshed.accessToken,
      expiresAt: Date.now() + Math.max(1, refreshed.expiresIn) * 1000,
      projectId: params.account.projectId,
      email: params.account.email,
    },
  });

  return { accessToken: refreshed.accessToken };
}

async function retrieveGoogleAgyQuota(
  accessToken: string,
  projectId: string,
  timeoutMs: number = AGY_QUOTA_TIMEOUT_MS,
): Promise<RetrieveUserQuotaResponse> {
  const response = await fetchWithTimeout(
    AGY_QUOTA_API_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": AGY_USER_AGENT,
        "x-activity-request-id": createAgyActivityRequestId(),
      },
      body: JSON.stringify({ project: projectId }),
    },
    timeoutMs,
  );

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Google AGY quota auth error: ${response.status}`);
    }
    throw new Error(`Google AGY quota API error: ${response.status}`);
  }

  return response.json() as Promise<RetrieveUserQuotaResponse>;
}

export function formatDisplayName(modelId: string): string {
  // Replace all underscores with hyphens
  let cleaned = modelId.replace(/_/g, "-").trim();

  // Special cases for well-known prefixes
  if (cleaned.toLowerCase().startsWith("claude-")) {
    // Handle versions like claude-3-5-sonnet -> Claude 3.5 Sonnet
    return cleaned
      .split("-")
      .map((part, i) => {
        if (i === 0) return "Claude";
        if (/^\d+$/.test(part) && /^\d+$/.test(cleaned.split("-")[i + 1] || "")) {
          return part + "." + cleaned.split("-")[i + 1];
        }
        if (/^\d+$/.test(part) && /^\d+$/.test(cleaned.split("-")[i - 1] || "")) {
          return ""; // Skip second part of version
        }
        return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
      })
      .filter(Boolean)
      .join(" ");
  }

  // Replace gpt-oss (case-insensitive) with a temporary placeholder
  cleaned = cleaned.replace(/gpt-oss/gi, "GPT_OSS");
  // Replace digit-digit with digit.digit (e.g. 4-6 to 4.6)
  cleaned = cleaned.replace(/(\d+)-(\d+)/g, "$1.$2");

  let suffix = "";
  if (cleaned.toLowerCase().endsWith("-medium")) {
    suffix = " (Medium)";
    cleaned = cleaned.slice(0, -7);
  } else if (cleaned.toLowerCase().endsWith("-large")) {
    suffix = " (Large)";
    cleaned = cleaned.slice(0, -6);
  }

  const parts = cleaned.split("-").filter(Boolean);
  const formattedParts = parts.map((part) => {
    if (part === "GPT_OSS") {
      return "GPT-OSS";
    }
    const lower = part.toLowerCase();
    if (lower === "gpt") return "GPT";
    if (lower === "oss") return "OSS";
    // If it's a size like 120b, capitalize it to 120B
    if (/^\d+[a-zA-Z]+$/.test(part)) {
      return part.toUpperCase();
    }
    // If it's a version number like 3.5 or 4.6, keep as-is
    if (/^[0-9]+(?:\.[0-9]+)*$/.test(part)) {
      return part;
    }
    return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
  });

  return formattedParts.join(" ") + suffix;
}

/**
 * Infer the quota window type from a bucket's tokenType and/or resetTime.
 *
 * Priority:
 * 1. If tokenType explicitly names a window ("weekly", "monthly", "daily", "session"),
 *    use that directly.
 * 2. If the resetTime is at least 7 days from now, it is a monthly window.
 * 3. If the resetTime is at least 24 hours from now, it is a weekly window.
 * 4. Otherwise fall back to "unknown".
 *
 * The Antigravity API often returns tokenType="WTUS" (weekly token usage)
 * regardless of the actual window, so reset-time inference is the reliable path.
 */
export function detectQuotaWindow(
  tokenType: string | undefined | null,
  resetTimeIso?: string | undefined | null,
): GoogleAgyQuotaWindow {
  const type = (tokenType ?? "").toLowerCase().trim();
  if (type === "daily" || type === "weekly" || type === "monthly" || type === "session") {
    return type;
  }

  // Infer window from reset distance when tokenType is opaque.
  if (resetTimeIso) {
    try {
      const now = Date.now();
      const reset = new Date(resetTimeIso).getTime();
      const hoursUntilReset = (reset - now) / 3_600_000;
      if (Number.isFinite(hoursUntilReset)) {
        if (hoursUntilReset <= 24) return "daily";
        if (hoursUntilReset <= 24 * 7) return "weekly";
        return "monthly";
      }
    } catch {
      // Fall through to "unknown".
    }
  }

  return "unknown";
}

function aggregateAgyBuckets(buckets: GoogleAgyQuotaBucket[]): GoogleAgyQuotaBucket[] {
  // Group by composite key (modelId + window) so the same model with different
  // quota windows (e.g. Claude weekly + Claude monthly) produces separate entries.
  const grouped = new Map<string, GoogleAgyQuotaBucket>();
  for (const bucket of buckets) {
    const compositeKey = `${bucket.modelId}::${bucket.window ?? "unknown"}`;
    const existing = grouped.get(compositeKey);
    if (!existing || bucket.percentRemaining < existing.percentRemaining) {
      grouped.set(compositeKey, bucket);
    }
  }
  return Array.from(grouped.values());
}

function mapQuotaBuckets(
  buckets: RetrieveUserQuotaBucket[] | undefined,
  account: AgyAccount,
): GoogleAgyQuotaBucket[] {
  if (!buckets) {
    return [];
  }

  const normalizedBuckets = buckets
    .filter((bucket) => normalizeString(bucket.modelId))
    .map((bucket) => {
      const modelId = normalizeString(bucket.modelId)!;
      const remainingFraction = bucket.remainingFraction;

      let percentRemaining: number;
      if (typeof remainingFraction === "number" && Number.isFinite(remainingFraction)) {
        percentRemaining = Math.round(remainingFraction * 100);
      } else if (
        normalizeString(bucket.remainingAmount) &&
        bucket.remainingAmount?.toLowerCase().includes("unlimited")
      ) {
        percentRemaining = 100;
      } else {
        percentRemaining = 0;
      }

      const tokenType = normalizeString(bucket.tokenType);
      const resetTimeIso = normalizeString(bucket.resetTime);
      const window = detectQuotaWindow(tokenType, resetTimeIso);

      return {
        modelId,
        displayName: formatDisplayName(modelId),
        percentRemaining,
        ...(normalizeString(bucket.resetTime) ? { resetTimeIso: bucket.resetTime!.trim() } : {}),
        ...(normalizeString(bucket.remainingAmount)
          ? { remainingAmount: bucket.remainingAmount!.trim() }
          : {}),
        ...(tokenType ? { tokenType } : {}),
        window,
        ...(account.email ? { accountEmail: account.email } : {}),
        accountKey: createAgyAccountKey(account),
        sourceKey: account.sourceKey,
      };
    });

  return aggregateAgyBuckets(normalizedBuckets);
}

async function fetchAccountQuota(params: {
  account: AgyAccount;
  credentials: AgyConfiguredCredentials;
  timeoutMs?: number;
}): Promise<{
  success: boolean;
  buckets?: GoogleAgyQuotaBucket[];
  error?: string;
  accountEmail?: string;
}> {
  const accountEmail = params.account.email || params.account.sourceKey;

  try {
    const tokenResult = await refreshAgyAccessTokenWithCache({
      account: params.account,
      credentials: params.credentials,
      timeoutMs: params.timeoutMs,
    });
    if ("error" in tokenResult) {
      return { success: false, error: tokenResult.error, accountEmail };
    }

    let quota: RetrieveUserQuotaResponse;
    try {
      quota = await retrieveGoogleAgyQuota(
        tokenResult.accessToken,
        params.account.projectId,
        params.timeoutMs,
      );
    } catch (err) {
      if (err instanceof Error && err.message.includes("auth error")) {
        const retryToken = await refreshAgyAccessTokenWithCache({
          account: params.account,
          credentials: params.credentials,
          force: true,
          timeoutMs: params.timeoutMs,
        });
        if ("error" in retryToken) {
          return { success: false, error: retryToken.error, accountEmail };
        }
        quota = await retrieveGoogleAgyQuota(
          retryToken.accessToken,
          params.account.projectId,
          params.timeoutMs,
        );
      } else {
        throw err;
      }
    }

    return {
      success: true,
      buckets: mapQuotaBuckets(quota.buckets, params.account),
      accountEmail,
    };
  } catch (err) {
    if (err instanceof Error && err.message.includes("timeout")) {
      return { success: false, error: "API timeout", accountEmail };
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      accountEmail,
    };
  }
}

export async function queryGoogleAgyQuota(
  client?: ConfigClient,
  options: { requestTimeoutMs?: number } = {},
): Promise<GoogleAgyResult> {
  const [auth, configuredProjectId] = await Promise.all([
    readAuthFileCached({ maxAgeMs: DEFAULT_AGY_AUTH_CACHE_MAX_AGE_MS }),
    resolveAgyConfiguredProjectId(client),
  ]);
  const accounts = resolveAgyAccounts(auth, configuredProjectId);
  if (accounts.length === 0) {
    return null;
  }

  const credentials = await resolveAgyClientCredentials();
  if (credentials.state !== "configured") {
    return {
      success: false,
      error: credentials.error || "Google AGY companion auth plugin not found",
    };
  }

  const results = await mapWithConcurrency({
    items: accounts,
    concurrency: AGY_ACCOUNTS_CONCURRENCY,
    fn: async (account) =>
      fetchAccountQuota({ account, credentials, timeoutMs: options.requestTimeoutMs }),
  });

  const allBuckets: GoogleAgyQuotaBucket[] = [];
  const errors: GoogleAccountError[] = [];

  for (const result of results) {
    if (result.success && result.buckets && result.buckets.length > 0) {
      allBuckets.push(...result.buckets);
    } else if (!result.success && result.error && result.accountEmail) {
      errors.push({ email: result.accountEmail, error: result.error });
    }
  }

  if (allBuckets.length === 0 && errors.length === 0) {
    return {
      success: false,
      error: "No Google AGY quota data available",
    };
  }

  return {
    success: true,
    buckets: allBuckets,
    errors: errors.length > 0 ? errors : undefined,
  };
}

export function clearAgyRuntimeCacheForTests(): void {
  clearAgyCompanionCacheForTests();
}