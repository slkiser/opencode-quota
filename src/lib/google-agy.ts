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
  GoogleAgyQuotaSummaryBucket,
  GoogleAgyQuotaSummaryResponse,
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
const AGY_QUOTA_SUMMARY_API_URL = `${AGY_CODE_ASSIST_ENDPOINT}/v1internal:retrieveUserQuotaSummary`;
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

function createAgyAccountKey(
  account: Pick<AgyAccount, "sourceKey" | "refreshToken" | "projectId">,
): string {
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
      const data = result?.data as {
        provider?: Record<string, { options?: Record<string, unknown> }>;
      };
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
  const sourceKey =
    accounts[0]?.sourceKey ?? AGY_AUTH_KEYS.find((key) => auth?.[key]?.type === "oauth");

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

async function retrieveGoogleAgyQuotaSummary(
  accessToken: string,
  projectId: string,
  timeoutMs: number = AGY_QUOTA_TIMEOUT_MS,
): Promise<GoogleAgyQuotaSummaryResponse> {
  const response = await fetchWithTimeout(
    AGY_QUOTA_SUMMARY_API_URL,
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

  return response.json() as Promise<GoogleAgyQuotaSummaryResponse>;
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

function normalizeSummaryWindow(
  value: unknown,
): Pick<GoogleAgyQuotaBucket, "window" | "windowLabel"> | undefined {
  const normalized = normalizeString(value)
    ?.toUpperCase()
    .replace(/[\s-]+/gu, "_");
  if (normalized === "WEEKLY") {
    return { window: "weekly", windowLabel: "Weekly" };
  }
  if (normalized === "FIVE_HOUR" || normalized === "5H") {
    return { window: "five_hour", windowLabel: "5h" };
  }
  return undefined;
}

function normalizeSummaryFamily(value: unknown): string | undefined {
  const displayName = normalizeString(value);
  if (!displayName) {
    return undefined;
  }
  const normalized = displayName.toLowerCase();
  if (normalized.includes("gemini")) {
    return "Gemini Models";
  }
  if (normalized.includes("claude") || normalized.includes("gpt")) {
    return "Claude and GPT models";
  }
  return displayName;
}

function normalizeResetTimeIso(value: unknown): string | undefined {
  const raw = normalizeString(value);
  if (!raw) return undefined;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function summaryFamilyRank(family: string): number {
  if (family === "Gemini Models") return 0;
  if (family === "Claude and GPT models") return 1;
  return 2;
}

function summaryWindowRank(window: GoogleAgyQuotaBucket["window"]): number {
  return window === "weekly" ? 0 : 1;
}

function compareSummaryBuckets(left: GoogleAgyQuotaBucket, right: GoogleAgyQuotaBucket): number {
  if (left.accountIndex !== right.accountIndex) {
    return left.accountIndex - right.accountIndex;
  }

  const familyRank = summaryFamilyRank(left.family) - summaryFamilyRank(right.family);
  if (familyRank !== 0) {
    return familyRank;
  }

  const familyName = left.family.localeCompare(right.family);
  if (familyName !== 0) {
    return familyName;
  }

  const windowRank = summaryWindowRank(left.window) - summaryWindowRank(right.window);
  if (windowRank !== 0) {
    return windowRank;
  }

  const bucketLabel = (left.bucketLabel ?? "").localeCompare(right.bucketLabel ?? "");
  if (bucketLabel !== 0) {
    return bucketLabel;
  }
  return (left.bucketId ?? "").localeCompare(right.bucketId ?? "");
}

function normalizeSummaryBucket(params: {
  bucket: GoogleAgyQuotaSummaryBucket;
  family: string;
  account: AgyAccount;
  accountIndex: number;
}): GoogleAgyQuotaBucket | undefined {
  if (params.bucket.disabled) {
    return undefined;
  }

  const window = normalizeSummaryWindow(params.bucket.window);
  const remainingFraction = params.bucket.remainingFraction;
  if (!window || typeof remainingFraction !== "number" || !Number.isFinite(remainingFraction)) {
    return undefined;
  }

  const bucketId = normalizeString(params.bucket.bucketId);
  const bucketLabel = normalizeString(params.bucket.displayName);
  const remainingAmount =
    normalizeString(params.bucket.remainingAmount) ?? normalizeString(params.bucket.remaining);
  const resetTimeIso = normalizeResetTimeIso(params.bucket.resetTime);

  return {
    family: params.family,
    ...window,
    ...(bucketId ? { bucketId } : {}),
    ...(bucketLabel ? { bucketLabel } : {}),
    remainingFraction,
    percentRemaining: Math.round(Math.min(1, Math.max(0, remainingFraction)) * 100),
    ...(resetTimeIso ? { resetTimeIso } : {}),
    ...(remainingAmount ? { remainingAmount } : {}),
    ...(params.account.email ? { accountEmail: params.account.email } : {}),
    accountKey: createAgyAccountKey(params.account),
    accountIndex: params.accountIndex,
    sourceKey: params.account.sourceKey,
  };
}

function mapSummaryBuckets(
  response: GoogleAgyQuotaSummaryResponse,
  account: AgyAccount,
  accountIndex: number,
): GoogleAgyQuotaBucket[] {
  if (!response || typeof response !== "object") {
    return [];
  }

  const normalized: GoogleAgyQuotaBucket[] = [];

  for (const group of Array.isArray(response.groups) ? response.groups : []) {
    const family = normalizeSummaryFamily(group?.displayName);
    if (!family || !Array.isArray(group?.buckets)) {
      continue;
    }
    for (const bucket of group.buckets) {
      if (!bucket || typeof bucket !== "object") {
        continue;
      }
      const row = normalizeSummaryBucket({ bucket, family, account, accountIndex });
      if (row) {
        normalized.push(row);
      }
    }
  }

  if (normalized.length === 0 && Array.isArray(response.buckets)) {
    const family = normalizeSummaryFamily(response.description) ?? "Quota Summary";
    for (const bucket of response.buckets) {
      if (!bucket || typeof bucket !== "object") {
        continue;
      }
      const row = normalizeSummaryBucket({ bucket, family, account, accountIndex });
      if (row) {
        normalized.push(row);
      }
    }
  }

  const deduplicated = new Map<string, GoogleAgyQuotaBucket>();
  for (const bucket of normalized) {
    const bucketIdentity = bucket.bucketId ?? bucket.bucketLabel ?? bucket.window;
    const identity = `${bucket.family}\0${bucket.window}\0${bucketIdentity}`;
    const existing = deduplicated.get(identity);
    if (!existing || bucket.remainingFraction < existing.remainingFraction) {
      deduplicated.set(identity, bucket);
    }
  }

  return Array.from(deduplicated.values()).sort(compareSummaryBuckets);
}

async function fetchAccountQuota(params: {
  account: AgyAccount;
  accountIndex: number;
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

    let summary: GoogleAgyQuotaSummaryResponse;
    try {
      summary = await retrieveGoogleAgyQuotaSummary(
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
        summary = await retrieveGoogleAgyQuotaSummary(
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
      buckets: mapSummaryBuckets(summary, params.account, params.accountIndex),
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
    fn: async (account, accountIndex) =>
      fetchAccountQuota({
        account,
        accountIndex,
        credentials,
        timeoutMs: options.requestTimeoutMs,
      }),
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
    buckets: allBuckets.sort(compareSummaryBuckets),
    errors: errors.length > 0 ? errors : undefined,
  };
}

export function clearAgyRuntimeCacheForTests(): void {
  clearAgyCompanionCacheForTests();
}
