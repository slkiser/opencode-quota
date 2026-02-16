/**
 * Google Antigravity quota fetcher
 *
 * Uses OpenCode's antigravity-accounts.json at ~/.config/opencode/antigravity-accounts.json.
 * Requires the user to have opencode-antigravity-auth installed and logged in.
 */

import { readFile } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";

import { getOpencodeRuntimeDirCandidates } from "./opencode-runtime-paths.js";

import {
  ANTIGRAVITY_CLIENT_ID as GOOGLE_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET as GOOGLE_CLIENT_SECRET,
} from "opencode-antigravity-auth/dist/src/constants.js";

import type {
  AntigravityAccount,
  AntigravityAccountsFile,
  GoogleQuotaResponse,
  GoogleQuotaResult,
  GoogleModelQuota,
  GoogleModelId,
  GoogleAccountError,
  GoogleResult,
} from "./types.js";
import { GOOGLE_MODEL_KEYS } from "./types.js";
import { fetchWithTimeout } from "./http.js";
import {
  getCachedAccessToken,
  makeAccountCacheKey,
  setCachedAccessToken,
} from "./google-token-cache.js";

// =============================================================================
// Constants
// =============================================================================

const GOOGLE_QUOTA_API_URL = "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";
const USER_AGENT = "antigravity/1.11.9 darwin/arm64";

const GOOGLE_TOKEN_REFRESH_URL = "https://oauth2.googleapis.com/token";

// Network timeouts tuned for reliability.
const GOOGLE_TOKEN_TIMEOUT_MS = 8000;
const GOOGLE_QUOTA_TIMEOUT_MS = 6000;

// Multi-account fetching concurrency (reliability > speed).
const GOOGLE_ACCOUNTS_CONCURRENCY = 3;

// =============================================================================
// Helpers
// =============================================================================

export function getAntigravityAccountsCandidatePaths(): string[] {
  // Prefer OpenCode runtime dirs (xdg-basedir semantics), but include both
  // config and data as candidates for compatibility with older variants.
  const { configDirs, dataDirs } = getOpencodeRuntimeDirCandidates();

  const candidates = [
    ...configDirs.map((d) => join(d, "antigravity-accounts.json")),
    ...dataDirs.map((d) => join(d, "antigravity-accounts.json")),
  ];

  // Unique + stable order.
  return Array.from(new Set(candidates));
}

export function pickAntigravityAccountsPath(): string {
  for (const p of getAntigravityAccountsCandidatePaths()) {
    if (existsSync(p)) return p;
  }
  // Default to the first candidate for error/debug messaging.
  return getAntigravityAccountsCandidatePaths()[0]!;
}

/**
 * Read Antigravity accounts from storage
 */
export async function readAntigravityAccounts(): Promise<AntigravityAccount[] | null> {
  for (const path of getAntigravityAccountsCandidatePaths()) {
    try {
      const content = await readFile(path, "utf-8");
      const file = JSON.parse(content) as AntigravityAccountsFile;

      if (!file.accounts || file.accounts.length === 0) {
        continue;
      }

      // Filter to accounts with refresh tokens
      const validAccounts = file.accounts.filter((account) => account.refreshToken);
      return validAccounts.length > 0 ? validAccounts : null;
    } catch {
      // try next candidate
    }
  }

  return null;
}

export async function hasAntigravityAccountsConfigured(): Promise<boolean> {
  const accounts = await readAntigravityAccounts();
  return !!accounts && accounts.length > 0;
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

/**
 * Refresh Google access token
 */
async function refreshAccessToken(
  refreshToken: string,
  timeoutMs: number = GOOGLE_TOKEN_TIMEOUT_MS,
): Promise<{ accessToken: string; expiresIn: number } | { error: string }> {
  try {
    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });

    const response = await fetchWithTimeout(
      GOOGLE_TOKEN_REFRESH_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params,
      },
      timeoutMs,
    );

    if (!response.ok) {
      // Try to extract error code from response
      try {
        const errorData = (await response.json()) as {
          error?: string;
          error_description?: string;
        };
        if (errorData.error === "invalid_grant") {
          return { error: "Token revoked" };
        }
        return {
          error: errorData.error_description || `HTTP ${response.status}`,
        };
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

async function refreshAccessTokenWithCache(params: {
  refreshToken: string;
  projectId: string;
  email?: string;
  skewMs?: number;
  force?: boolean;
}): Promise<{ accessToken: string } | { error: string }> {
  const skewMs = params.skewMs ?? 2 * 60_000;
  const key = makeAccountCacheKey({
    refreshToken: params.refreshToken,
    projectId: params.projectId,
    email: params.email,
  });

  if (!params.force) {
    const cached = await getCachedAccessToken({ key, skewMs });
    if (cached) return { accessToken: cached.accessToken };
  }

  const refreshed = await refreshAccessToken(params.refreshToken);
  if ("error" in refreshed) return refreshed;

  await setCachedAccessToken({
    key,
    entry: {
      accessToken: refreshed.accessToken,
      expiresAt: Date.now() + Math.max(1, refreshed.expiresIn) * 1000,
      projectId: params.projectId,
      email: params.email,
    },
  });

  return { accessToken: refreshed.accessToken };
}

export async function refreshGoogleTokensForAllAccounts(params?: {
  skewMs?: number;
  force?: boolean;
}): Promise<null | {
  total: number;
  successCount: number;
  failures: Array<{ email?: string; error: string }>;
}> {
  const accounts = await readAntigravityAccounts();
  if (!accounts || accounts.length === 0) return null;

  const valid = accounts.filter((a) => !!a.refreshToken);
  if (valid.length === 0) return null;

  const results = await mapWithConcurrency({
    items: valid,
    concurrency: GOOGLE_ACCOUNTS_CONCURRENCY,
    fn: async (account) => {
      const email = account.email;
      const projectId = getProjectId(account);
      if (!projectId) return { ok: false as const, email, error: "No projectId" };

      const token = await refreshAccessTokenWithCache({
        refreshToken: account.refreshToken,
        projectId,
        email,
        skewMs: params?.skewMs,
        force: params?.force,
      });
      if ("error" in token) return { ok: false as const, email, error: token.error };
      return { ok: true as const, email };
    },
  });

  const failures = results.filter((r) => !r.ok).map((r) => ({ email: r.email, error: r.error }));
  const successCount = results.filter((r) => r.ok).length;

  return {
    total: valid.length,
    successCount,
    failures,
  };
}

/**
 * Fetch quota from Google API
 */
async function fetchGoogleQuota(
  accessToken: string,
  projectId: string,
  timeoutMs: number = GOOGLE_QUOTA_TIMEOUT_MS,
): Promise<GoogleQuotaResponse> {
  const response = await fetchWithTimeout(
    GOOGLE_QUOTA_API_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({ project: projectId }),
    },
    timeoutMs,
  );

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Google API auth error: ${response.status}`);
    }
    throw new Error(`Google API error: ${response.status}`);
  }

  return response.json() as Promise<GoogleQuotaResponse>;
}

/**
 * Extract model quotas from API response
 */
function extractModelQuotas(
  data: GoogleQuotaResponse,
  modelIds: GoogleModelId[],
  accountEmail?: string,
): GoogleModelQuota[] {
  const quotas: GoogleModelQuota[] = [];

  for (const modelId of modelIds) {
    const modelConfig = GOOGLE_MODEL_KEYS[modelId];
    if (!modelConfig) continue;

    let modelInfo = data.models[modelConfig.key];

    // Try alternate key if primary not found
    if (!modelInfo && modelConfig.altKey) {
      modelInfo = data.models[modelConfig.altKey];
    }

    if (modelInfo) {
      const remainingFraction = modelInfo.quotaInfo?.remainingFraction ?? 0;
      quotas.push({
        modelId,
        displayName: modelConfig.display,
        percentRemaining: Math.round(remainingFraction * 100),
        resetTimeIso: modelInfo.quotaInfo?.resetTime,
        accountEmail,
      });
    }
  }

  return quotas;
}

/**
 * Fetch quota for a single account
 */
function getProjectId(account: AntigravityAccount): string | undefined {
  return account.projectId || account.projectID || account.managedProjectId;
}

// NOTE: This plugin treats Google Antigravity as truly multi-account.
// Each account gets its own access token derived from its refresh token.

async function fetchAccountQuotaWithAntigravityRefresh(params: {
  account: AntigravityAccount;
  modelIds: GoogleModelId[];
}): Promise<{
  success: boolean;
  models?: GoogleModelQuota[];
  error?: string;
  accountEmail?: string;
}> {
  const email = params.account.email || "Unknown";
  const projectId = getProjectId(params.account);

  if (!projectId) {
    return { success: false, error: "No projectId", accountEmail: email };
  }

  try {
    const tokenResult = await refreshAccessTokenWithCache({
      refreshToken: params.account.refreshToken,
      projectId,
      email,
    });

    if ("error" in tokenResult)
      return { success: false, error: tokenResult.error, accountEmail: email };

    let data: GoogleQuotaResponse;
    try {
      data = await fetchGoogleQuota(tokenResult.accessToken, projectId);
    } catch (err) {
      // One auth retry: refresh token then retry quota call.
      if (err instanceof Error && err.message.includes("auth error")) {
        const retryToken = await refreshAccessToken(params.account.refreshToken);
        if ("error" in retryToken) {
          return { success: false, error: retryToken.error, accountEmail: email };
        }
        await setCachedAccessToken({
          key: makeAccountCacheKey({ refreshToken: params.account.refreshToken, projectId, email }),
          entry: {
            accessToken: retryToken.accessToken,
            expiresAt: Date.now() + Math.max(1, retryToken.expiresIn) * 1000,
            projectId,
            email,
          },
        });
        data = await fetchGoogleQuota(retryToken.accessToken, projectId);
      } else {
        throw err;
      }
    }
    const models = extractModelQuotas(data, params.modelIds, email);

    return { success: true, models, accountEmail: email };
  } catch (err) {
    if (err instanceof Error && err.message.includes("timeout")) {
      return { success: false, error: "API timeout", accountEmail: email };
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      accountEmail: email,
    };
  }
}

// =============================================================================
// Export
// =============================================================================

/**
 * Query Google Antigravity quota for ALL accounts
 *
 * Reads accounts from ~/.config/opencode/antigravity-accounts.json.
 * Refreshes access tokens and fetches quota for all accounts in parallel.
 *
 * @param modelIds - Model IDs to fetch quota for
 * @returns Quota result with all models and any errors, or null if not configured
 */
export async function queryGoogleQuota(modelIds: GoogleModelId[]): Promise<GoogleResult> {
  const accounts = await readAntigravityAccounts();
  if (!accounts || accounts.length === 0) {
    return null;
  }

  // Query accounts with bounded concurrency (reliability > speed).
  const results = await mapWithConcurrency({
    items: accounts,
    concurrency: GOOGLE_ACCOUNTS_CONCURRENCY,
    fn: async (account) => fetchAccountQuotaWithAntigravityRefresh({ account, modelIds }),
  });

  // Collect all successful models and errors
  const allModels: GoogleModelQuota[] = [];
  const errors: GoogleAccountError[] = [];

  for (const result of results) {
    if (result.success && result.models && result.models.length > 0) {
      allModels.push(...result.models);
    } else if (!result.success && result.error && result.accountEmail) {
      errors.push({ email: result.accountEmail, error: result.error });
    }
  }

  // Return combined result
  if (allModels.length === 0 && errors.length === 0) {
    return {
      success: false,
      error: "No quota data available",
    };
  }

  return {
    success: true,
    models: allModels,
    errors: errors.length > 0 ? errors : undefined,
  } as GoogleQuotaResult;
}

/**
 * Format Google quota for toast display
 *
 * @param result - Google quota result
 * @returns Formatted string like "G3Pro 100% * G3Flash 100% * Claude 0%" or null
 */
export function formatGoogleQuota(result: GoogleResult): string | null {
  if (!result) {
    return null;
  }

  if (!result.success) {
    return null;
  }

  if (result.models.length === 0) {
    return null;
  }

  return result.models.map((m) => `${m.displayName} ${m.percentRemaining}%`).join(" \u2022 ");
}
