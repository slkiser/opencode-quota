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
  GoogleAgyResult,
  GoogleAccountError,
  GeminiCliOAuthAuthData,
  RetrieveUserQuotaSummaryGroup,
  RetrieveUserQuotaSummaryResponse,
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
const AGY_USER_AGENT = "antigravity/1.18.3 darwin/arm64";

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

async function retrieveUserQuotaSummary(
  accessToken: string,
  projectId: string,
  timeoutMs: number = AGY_QUOTA_TIMEOUT_MS,
): Promise<RetrieveUserQuotaSummaryResponse> {
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

  return response.json() as Promise<RetrieveUserQuotaSummaryResponse>;
}

async function fetchAccountQuota(params: {
  account: AgyAccount;
  credentials: AgyConfiguredCredentials;
  timeoutMs?: number;
}): Promise<{
  success: boolean;
  summaryGroups?: RetrieveUserQuotaSummaryGroup[];
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

    const summaryResult = await (async () => {
      try {
        return await retrieveUserQuotaSummary(
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
            throw new Error(retryToken.error);
          }
          return await retrieveUserQuotaSummary(
            retryToken.accessToken,
            params.account.projectId,
            params.timeoutMs,
          );
        }
        throw err;
      }
    })();

    if (!summaryResult.groups || summaryResult.groups.length === 0) {
      return { success: false, error: "Quota summary API unavailable", accountEmail };
    }

    return {
      success: true,
      summaryGroups: summaryResult.groups,
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

function mergeSummaryGroupsAcrossAccounts(
  groups: RetrieveUserQuotaSummaryGroup[],
): RetrieveUserQuotaSummaryGroup[] {
  if (groups.length === 0) return [];

  const aggregated = new Map<string, RetrieveUserQuotaSummaryGroup>();

  for (const group of groups) {
    const existing = aggregated.get(group.displayName);
    if (!existing) {
      aggregated.set(group.displayName, {
        displayName: group.displayName,
        description: group.description,
        buckets: group.buckets.map((b) => ({ ...b })),
      });
    } else {
      for (const bucket of group.buckets) {
        const existingIdx = existing.buckets.findIndex((b) => b.bucketId === bucket.bucketId);
        if (existingIdx === -1) {
          existing.buckets.push({ ...bucket });
        } else {
          const existingBucket = existing.buckets[existingIdx]!;
          existingBucket.remainingFraction = Math.min(existingBucket.remainingFraction ?? 1, bucket.remainingFraction ?? 1);
          if (bucket.disabled) existingBucket.disabled = true;
          const existingTs = Date.parse(existingBucket.resetTime ?? "");
          const bucketTs = Date.parse(bucket.resetTime ?? "");
          if (Number.isFinite(bucketTs) && (!Number.isFinite(existingTs) || bucketTs < existingTs)) {
            existingBucket.resetTime = bucket.resetTime;
          }
        }
      }
    }
  }

  return Array.from(aggregated.values());
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

  const allSummaryGroups: RetrieveUserQuotaSummaryGroup[] = [];
  const errors: GoogleAccountError[] = [];

  for (const result of results) {
    if (result.success && result.summaryGroups && result.summaryGroups.length > 0) {
      allSummaryGroups.push(...result.summaryGroups);
    }
    if (!result.success && result.error && result.accountEmail) {
      errors.push({ email: result.accountEmail, error: result.error });
    }
  }

  const mergedGroups = mergeSummaryGroupsAcrossAccounts(allSummaryGroups);

  if (mergedGroups.length === 0 && errors.length === 0) {
    return {
      success: false,
      error: "No Google AGY quota data available",
    };
  }

  return {
    success: true,
    summaryGroups: mergedGroups,
    errors: errors.length > 0 ? errors : undefined,
  };
}

export function clearAgyRuntimeCacheForTests(): void {
  clearAgyCompanionCacheForTests();
}