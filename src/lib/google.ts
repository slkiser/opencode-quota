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
  inspectAntigravityCompanionPresence,
  resolveAntigravityClientCredentials,
  type GoogleAntigravityConfiguredCredentials,
} from "./google-antigravity-companion.js";

// NOTE: Google Antigravity auth differs intentionally from Qwen:
// - Qwen reads OpenCode auth.json key "qwen-code" first, then falls back to
//   legacy key "opencode-qwencode-auth", and uses local quota state.
// - Google refresh flow requires upstream OAuth client credentials from
//   opencode-antigravity-auth to match that plugin's runtime behavior.

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
const USER_AGENT_GEMINI_CLI = "GeminiCLI/1.0.0/gemini-2.5-pro (win32; x64)";
const GOOGLE_RETRIEVE_USER_QUOTA_URL = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";

const GOOGLE_TOKEN_REFRESH_URL = "https://oauth2.googleapis.com/token";

// Network timeouts tuned for reliability.
const GOOGLE_TOKEN_TIMEOUT_MS = 8000;
const GOOGLE_QUOTA_TIMEOUT_MS = 6000;

// Multi-account fetching concurrency (reliability > speed).
const GOOGLE_ACCOUNTS_CONCURRENCY = 3;

function getCompanionQuotaError(state: "missing" | "invalid"): string {
  return state === "missing"
    ? "Google Antigravity requires the opencode-antigravity-auth plugin"
    : "Installed opencode-antigravity-auth package is incompatible";
}

// =============================================================================
// Helpers
// =============================================================================

export interface GoogleAntigravityAuthPresence {
  state: "missing" | "present" | "invalid";
  selectedPath?: string;
  presentPaths: string[];
  candidatePaths: string[];
  accountCount: number;
  validAccountCount: number;
  error?: string;
}

type AntigravityAccountsReadResult =
  | {
      state: "present";
      path: string;
      file: AntigravityAccountsFile;
      validAccounts: AntigravityAccount[];
    }
  | {
      state: "invalid";
      path: string;
      error: string;
    };

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

async function readAntigravityAccountsFile(path: string): Promise<AntigravityAccountsReadResult> {
  try {
    const content = await readFile(path, "utf-8");
    const file = JSON.parse(content) as AntigravityAccountsFile;

    if (!Array.isArray(file.accounts)) {
      return {
        state: "invalid",
        path,
        error: "accounts file is missing an accounts array",
      };
    }

    const validAccounts = file.accounts.filter(
      (account) =>
        typeof account.refreshToken === "string" && account.refreshToken.trim().length > 0,
    );

    return {
      state: "present",
      path,
      file,
      validAccounts,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      state: "invalid",
      path,
      error: message,
    };
  }
}

/**
 * Read Antigravity accounts from storage
 */
export async function readAntigravityAccounts(): Promise<AntigravityAccount[] | null> {
  for (const path of getAntigravityAccountsCandidatePaths()) {
    if (!existsSync(path)) {
      continue;
    }

    const result = await readAntigravityAccountsFile(path);
    if (result.state === "invalid") {
      continue;
    }

    if (result.file.accounts.length === 0) {
      continue;
    }

    return result.validAccounts.length > 0 ? result.validAccounts : null;
  }

  return null;
}

export async function inspectAntigravityAccountsPresence(): Promise<GoogleAntigravityAuthPresence> {
  const candidatePaths = getAntigravityAccountsCandidatePaths();
  const presentPaths = candidatePaths.filter((path) => existsSync(path));

  if (presentPaths.length === 0) {
    return {
      state: "missing",
      presentPaths,
      candidatePaths,
      accountCount: 0,
      validAccountCount: 0,
    };
  }

  let firstInvalid: { path: string; error: string } | null = null;

  for (const path of presentPaths) {
    const result = await readAntigravityAccountsFile(path);
    if (result.state === "invalid") {
      if (!firstInvalid) {
        firstInvalid = { path: result.path, error: result.error };
      }
      continue;
    }

    if (result.file.accounts.length === 0) {
      continue;
    }

    return {
      state: "present",
      selectedPath: result.path,
      presentPaths,
      candidatePaths,
      accountCount: result.file.accounts.length,
      validAccountCount: result.validAccounts.length,
    };
  }

  return {
    state: "invalid",
    selectedPath: firstInvalid?.path,
    presentPaths,
    candidatePaths,
    accountCount: 0,
    validAccountCount: 0,
    error: firstInvalid?.error,
  };
}

export async function hasAntigravityAccountsConfigured(): Promise<boolean> {
  const presence = await inspectAntigravityAccountsPresence();
  return presence.state === "present" && presence.validAccountCount > 0;
}

export async function hasAntigravityQuotaRuntimeAvailable(): Promise<boolean> {
  const [authPresence, companionPresence] = await Promise.all([
    inspectAntigravityAccountsPresence(),
    inspectAntigravityCompanionPresence(),
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

/**
 * Refresh Google access token
 */
async function refreshAccessToken(
  params: {
    refreshToken: string;
    clientId: string;
    clientSecret: string;
    timeoutMs?: number;
  },
): Promise<{ accessToken: string; expiresIn: number } | { error: string }> {
  try {
    const body = new URLSearchParams({
      client_id: params.clientId,
      client_secret: params.clientSecret,
      refresh_token: params.refreshToken,
      grant_type: "refresh_token",
    });

    const response = await fetchWithTimeout(
      GOOGLE_TOKEN_REFRESH_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      },
      params.timeoutMs ?? GOOGLE_TOKEN_TIMEOUT_MS,
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
  timeoutMs?: number;
  credentials: GoogleAntigravityConfiguredCredentials;
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

  const refreshed = await refreshAccessToken({
    refreshToken: params.refreshToken,
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

  const credentials = await resolveAntigravityClientCredentials();
  if (credentials.state !== "configured") {
    const error = getCompanionQuotaError(credentials.state);
    return {
      total: valid.length,
      successCount: 0,
      failures: valid.map((account) => ({
        email: account.email,
        error,
      })),
    };
  }

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
        credentials,
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
 * Map a modelId to its rate-limit family for local override lookup.
 * Families: "claude", "gemini-flash", "gemini-pro", "gpt-oss"
 */
function getRateLimitFamily(
  _modelId: GoogleModelId,
  modelConfig: (typeof GOOGLE_MODEL_KEYS)[GoogleModelId],
): "claude" | "gemini-flash" | "gemini-pro" | "gpt-oss" | null {
  const key = modelConfig.key.toLowerCase();
  if (key.includes("claude")) return "claude";
  if (key.includes("flash")) return "gemini-flash";
  if (key.includes("pro")) return "gemini-pro";
  if (key.includes("gpt-oss")) return "gpt-oss";
  return null;
}

/**
 * Extract model quotas from API response
 */
function extractModelQuotas(
  data: GoogleQuotaResponse,
  modelIds: GoogleModelId[],
  account: AntigravityAccount,
): GoogleModelQuota[] {
  const quotas: GoogleModelQuota[] = [];
  const accountEmail = account.email || "Unknown";

  for (const modelId of modelIds) {
    const modelConfig = GOOGLE_MODEL_KEYS[modelId];
    if (!modelConfig) continue;

    let modelInfo = data.models[modelConfig.key];

    // Try alternate keys (pipe-separated) if primary not found
    if (!modelInfo && modelConfig.altKey) {
      const altKeys = modelConfig.altKey.split("|");
      for (const altKey of altKeys) {
        modelInfo = data.models[altKey.trim()];
        if (modelInfo) break;
      }
    }

    if (modelInfo) {
      let remainingFraction = modelInfo.quotaInfo?.remainingFraction ?? 0;
      let resetTimeIso: string | undefined = modelInfo.quotaInfo?.resetTime;

      // Apply local rate limit overrides (rate-limited state from companion plugin)
      if (account.rateLimitResetTimes) {
        const family = getRateLimitFamily(modelId, modelConfig);
        if (family && account.rateLimitResetTimes[family]) {
          const resetTimestamp = account.rateLimitResetTimes[family];
          if (resetTimestamp && resetTimestamp > Date.now()) {
            remainingFraction = 0;
            resetTimeIso = new Date(resetTimestamp).toISOString();
          }
        }
      }

      quotas.push({
        modelId,
        displayName: modelConfig.display,
        percentRemaining: Math.round(remainingFraction * 100),
        resetTimeIso,
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
  credentials: GoogleAntigravityConfiguredCredentials;
  timeoutMs?: number;
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
      credentials: params.credentials,
      timeoutMs: params.timeoutMs,
    });

    if ("error" in tokenResult)
      return { success: false, error: tokenResult.error, accountEmail: email };

    let data: GoogleQuotaResponse;
    try {
      data = await fetchGoogleQuota(tokenResult.accessToken, projectId, params.timeoutMs);
    } catch (err) {
      // One auth retry: refresh token then retry quota call.
      if (err instanceof Error && err.message.includes("auth error")) {
        const retryToken = await refreshAccessToken({
          refreshToken: params.account.refreshToken,
          clientId: params.credentials.clientId,
          clientSecret: params.credentials.clientSecret,
          timeoutMs: params.timeoutMs,
        });
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
        data = await fetchGoogleQuota(retryToken.accessToken, projectId, params.timeoutMs);
      } else {
        throw err;
      }
    }
    const models = extractModelQuotas(data, params.modelIds, params.account);

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
// Gemini CLI Quota Merging (more accurate rate limits)
// =============================================================================

/** Bucket returned by the Gemini CLI `retrieveUserQuota` endpoint. */
interface GeminiCliBucket {
  modelId?: string;
  remainingFraction?: number;
  resetTime?: string;
}

/** Map a `GoogleModelId` to the key expected by Gemini CLI's `retrieveUserQuota`. */
function modelIdToGemini3Key(modelId: GoogleModelId): string | null {
  const cfg = GOOGLE_MODEL_KEYS[modelId];
  if (!cfg) return null;
  if (cfg.display === "G3Pro") return "gemini-3.1-pro";
  if (cfg.display === "G3Flash") return "gemini-3-flash";
  if (cfg.display === "Claude") return "claude-sonnet-4-6";
  if (cfg.display === "GPT-OSS") return "gpt-oss-120b-medium";
  return null;
}

/**
 * Fetch the Gemini CLI user quota endpoint for the most accurate rate limit info.
 * Best-effort: never throws, returns `{ buckets: [] }` on any error.
 */
async function fetchGeminiCliQuota(
  accessToken: string,
  projectId: string,
): Promise<{ buckets?: GeminiCliBucket[] }> {
  try {
    const response = await fetchWithTimeout(
      GOOGLE_RETRIEVE_USER_QUOTA_URL,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT_GEMINI_CLI,
        },
        body: JSON.stringify({ project: projectId }),
      },
      GOOGLE_QUOTA_TIMEOUT_MS,
    );
    if (response.ok) {
      return (await response.json()) as { buckets?: GeminiCliBucket[] };
    }
    return { buckets: [] };
  } catch {
    return { buckets: [] };
  }
}

/**
 * Merge Gemini CLI quota buckets into Antigravity model data.
 * For each Antigravity model, if the CLI reports a LOWER remaining percentage,
 * the CLI value wins (CLI is more accurate for active rate limits).
 */
function mergeGeminiCliQuota(
  cliBuckets: GeminiCliBucket[] | undefined,
  antigravityModels: GoogleModelQuota[],
): GoogleModelQuota[] {
  if (!cliBuckets || cliBuckets.length === 0) return antigravityModels;

  const findBucketByDisplay = (display: string): GeminiCliBucket | null => {
    if (display === "G3Pro") {
      for (const b of cliBuckets) {
        if (!b.modelId) continue;
        if (
          b.modelId.startsWith("gemini-3.1-pro") ||
          b.modelId.startsWith("gemini-3-pro") ||
          b.modelId === "gemini-3.5-pro" ||
          b.modelId.startsWith("gemini-3.5-pro")
        ) {
          return b;
        }
      }
    }
    if (display === "G3Flash") {
      for (const b of cliBuckets) {
        if (!b.modelId) continue;
        if (
          b.modelId.startsWith("gemini-3-flash") ||
          b.modelId.startsWith("gemini-3.5-flash") ||
          b.modelId.startsWith("gemini-3.1-flash")
        ) {
          return b;
        }
      }
    }
    if (display === "Claude") {
      for (const b of cliBuckets) {
        if (!b.modelId) continue;
        if (b.modelId.startsWith("claude") || b.modelId === "claude-sonnet-4-6") {
          return b;
        }
      }
    }
    if (display === "GPT-OSS") {
      for (const b of cliBuckets) {
        if (b.modelId && b.modelId.startsWith("gpt-oss")) return b;
      }
    }
    return null;
  };

  return antigravityModels.map((m) => {
    const cfg = GOOGLE_MODEL_KEYS[m.modelId];
    if (!cfg) return m;
    const cliBucket = findBucketByDisplay(cfg.display);
    if (!cliBucket || typeof cliBucket.remainingFraction !== "number") return m;
    const cliPercent = Math.round(cliBucket.remainingFraction * 100);
    if (cliPercent < m.percentRemaining) {
      return {
        ...m,
        percentRemaining: cliPercent,
        resetTimeIso: cliBucket.resetTime || m.resetTimeIso,
      };
    }
    return m;
  });
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
export async function queryGoogleQuota(
  modelIds: GoogleModelId[],
  options: { requestTimeoutMs?: number } = {},
): Promise<GoogleResult> {
  const accounts = await readAntigravityAccounts();
  if (!accounts || accounts.length === 0) {
    return null;
  }

  const credentials = await resolveAntigravityClientCredentials();
  if (credentials.state !== "configured") {
    return {
      success: false,
      error: getCompanionQuotaError(credentials.state),
    };
  }

  // Query accounts with bounded concurrency (reliability > speed).
  const results = await mapWithConcurrency({
    items: accounts,
    concurrency: GOOGLE_ACCOUNTS_CONCURRENCY,
    fn: async (account) =>
      fetchAccountQuotaWithAntigravityRefresh({
        account,
        modelIds,
        credentials,
        timeoutMs: options.requestTimeoutMs,
      }),
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

  // Also fetch and merge Gemini CLI quota for more accurate rate limits
  if (accounts.length > 0 && allModels.length > 0) {
    try {
      const firstAccount = accounts[0]!;
      const projectId = getProjectId(firstAccount);
      if (projectId) {
        const tokenResult = await refreshAccessTokenWithCache({
          refreshToken: firstAccount.refreshToken,
          projectId,
          email: firstAccount.email,
          credentials,
        });
        if (!("error" in tokenResult)) {
          const cliData = await fetchGeminiCliQuota(tokenResult.accessToken, projectId);
          if (cliData && cliData.buckets) {
            const mergedModels = mergeGeminiCliQuota(cliData.buckets, allModels);
            return {
              success: true,
              models: mergedModels,
              errors: errors.length > 0 ? errors : undefined,
            } as GoogleQuotaResult;
          }
        }
      }
    } catch {
      // If Gemini CLI quota fetch fails, fall through to Antigravity-only result
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
