/**
 * GitHub Copilot quota fetcher
 *
 * Strategy (new Copilot API reality):
 *
 * 1) Preferred: GitHub public billing API using a fine-grained PAT
 *    configured in ~/.config/opencode/copilot-quota-token.json.
 * 2) Best-effort: internal endpoint using OpenCode's stored OAuth token
 *    (legacy formats or via token exchange).
 */

import type {
  CopilotAuthData,
  CopilotQuotaConfig,
  CopilotTier,
  CopilotUsageResponse,
  CopilotQuotaResult,
  QuotaError,
  CopilotResult,
} from "./types.js";
import { fetchWithTimeout } from "./http.js";
import { readAuthFile } from "./opencode-auth.js";

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// =============================================================================
// Constants
// =============================================================================

const GITHUB_API_BASE_URL = "https://api.github.com";
const COPILOT_INTERNAL_USER_URL = `${GITHUB_API_BASE_URL}/copilot_internal/user`;
const COPILOT_TOKEN_EXCHANGE_URL = `${GITHUB_API_BASE_URL}/copilot_internal/v2/token`;

// Keep these aligned with current Copilot/VSC versions to avoid API heuristics.
const COPILOT_VERSION = "0.35.0";
const EDITOR_VERSION = "vscode/1.107.0";
const EDITOR_PLUGIN_VERSION = `copilot-chat/${COPILOT_VERSION}`;
const USER_AGENT = `GitHubCopilotChat/${COPILOT_VERSION}`;

const COPILOT_QUOTA_CONFIG_PATH = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  "opencode",
  "copilot-quota-token.json",
);

// =============================================================================
// Helpers
// =============================================================================

/**
 * Build headers for GitHub API requests
 */
const COPILOT_HEADERS: Record<string, string> = {
  "User-Agent": USER_AGENT,
  "Editor-Version": EDITOR_VERSION,
  "Editor-Plugin-Version": EDITOR_PLUGIN_VERSION,
  "Copilot-Integration-Id": "vscode-chat",
};

function buildBearerHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    ...COPILOT_HEADERS,
  };
}

function buildLegacyTokenHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: `token ${token}`,
    ...COPILOT_HEADERS,
  };
}

type GitHubRestAuthScheme = "bearer" | "token";

function buildGitHubRestHeaders(
  token: string,
  scheme: GitHubRestAuthScheme,
): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: scheme === "bearer" ? `Bearer ${token}` : `token ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": USER_AGENT,
  };
}

function preferredSchemesForToken(token: string): GitHubRestAuthScheme[] {
  const t = token.trim();

  // Fine-grained PATs usually prefer Bearer.
  if (t.startsWith("github_pat_")) {
    return ["bearer", "token"];
  }

  // Classic PATs historically prefer legacy `token`.
  if (t.startsWith("ghp_")) {
    return ["token", "bearer"];
  }

  return ["bearer", "token"];
}

async function readGitHubRestErrorMessage(response: Response): Promise<string> {
  const text = await response.text();

  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const msg = typeof obj.message === "string" ? obj.message : null;
      const doc = typeof obj.documentation_url === "string" ? obj.documentation_url : null;
      if (msg && doc) return `${msg} (${doc})`;
      if (msg) return msg;
    }
  } catch {
    // ignore
  }

  return text.slice(0, 160);
}

async function fetchGitHubRestJsonOnce<T>(
  url: string,
  token: string,
  scheme: GitHubRestAuthScheme,
): Promise<
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; message: string }
> {
  const response = await fetchWithTimeout(url, {
    headers: buildGitHubRestHeaders(token, scheme),
  });

  if (response.ok) {
    return { ok: true, status: response.status, data: (await response.json()) as T };
  }

  return {
    ok: false,
    status: response.status,
    message: await readGitHubRestErrorMessage(response),
  };
}

/**
 * Read Copilot auth data from auth.json
 *
 * Tries multiple key names to handle different OpenCode versions/configs.
 */
async function readCopilotAuth(): Promise<CopilotAuthData | null> {
  const authData = await readAuthFile();
  if (!authData) return null;

  // Try known key names in priority order
  const copilotAuth =
    authData["github-copilot"] ??
    (authData as Record<string, CopilotAuthData | undefined>)["copilot"] ??
    (authData as Record<string, CopilotAuthData | undefined>)["copilot-chat"];

  if (!copilotAuth || copilotAuth.type !== "oauth" || !copilotAuth.refresh) {
    return null;
  }

  return copilotAuth;
}

/**
 * Read optional Copilot quota config from user's config file.
 * Returns null if file doesn't exist or is invalid.
 */
function readQuotaConfig(): CopilotQuotaConfig | null {
  try {
    if (!existsSync(COPILOT_QUOTA_CONFIG_PATH)) {
      return null;
    }

    const content = readFileSync(COPILOT_QUOTA_CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(content) as CopilotQuotaConfig;

    if (!parsed || typeof parsed !== "object") return null;

    if (typeof parsed.token !== "string" || parsed.token.trim() === "") return null;
    if (typeof parsed.tier !== "string" || parsed.tier.trim() === "") return null;

    // Username is optional now that we prefer the /user/... billing endpoint.
    if (parsed.username != null) {
      if (typeof parsed.username !== "string" || parsed.username.trim() === "") return null;
    }

    const validTiers: CopilotTier[] = ["free", "pro", "pro+", "business", "enterprise"];
    if (!validTiers.includes(parsed.tier as CopilotTier)) return null;

    return parsed;
  } catch {
    return null;
  }
}

// Public billing API response types (keep local; only used here)
interface BillingUsageItem {
  product: string;
  sku: string;
  model?: string;
  unitType: string;
  grossQuantity: number;
  netQuantity: number;
  limit?: number;
}

interface BillingUsageResponse {
  timePeriod: { year: number; month?: number };
  user: string;
  usageItems: BillingUsageItem[];
}

const COPILOT_PLAN_LIMITS: Record<CopilotTier, number> = {
  free: 50,
  pro: 300,
  "pro+": 1500,
  business: 300,
  enterprise: 1000,
};

function getApproxNextResetIso(nowMs: number = Date.now()): string {
  const now = new Date(nowMs);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)).toISOString();
}

async function fetchPublicBillingUsage(config: CopilotQuotaConfig): Promise<BillingUsageResponse> {
  const token = config.token;
  const schemes = preferredSchemesForToken(token);

  // Prefer authenticated-user endpoint; fall back to /users/{username} for older behavior.
  const urls: string[] = [`${GITHUB_API_BASE_URL}/user/settings/billing/premium_request/usage`];
  if (config.username) {
    urls.push(
      `${GITHUB_API_BASE_URL}/users/${config.username}/settings/billing/premium_request/usage`,
    );
  }

  for (const url of urls) {
    let lastUnauthorized: { status: number; message: string } | null = null;

    for (const scheme of schemes) {
      const res = await fetchGitHubRestJsonOnce<BillingUsageResponse>(url, token, scheme);

      if (res.ok) {
        return res.data;
      }

      if (res.status === 401) {
        lastUnauthorized = { status: res.status, message: res.message };
        continue; // retry with alternate scheme
      }

      // If /user/... isn't supported for some reason, fall back to /users/... when available.
      if (res.status === 404 && url.includes("/user/")) {
        break;
      }

      throw new Error(`GitHub API error ${res.status}: ${res.message}`);
    }

    if (lastUnauthorized) {
      throw new Error(
        `GitHub API error ${lastUnauthorized.status}: ${lastUnauthorized.message} (token rejected; verify PAT and permissions)`,
      );
    }
  }

  throw new Error("GitHub API error 404: Not Found");
}

function toQuotaResultFromBilling(
  data: BillingUsageResponse,
  tier: CopilotTier,
): CopilotQuotaResult {
  const items = Array.isArray(data.usageItems) ? data.usageItems : [];

  const premiumItems = items.filter(
    (item) =>
      item &&
      typeof item === "object" &&
      typeof item.sku === "string" &&
      (item.sku === "Copilot Premium Request" || item.sku.includes("Premium")),
  );

  const used = premiumItems.reduce((sum, item) => sum + (item.grossQuantity || 0), 0);

  const limits = premiumItems
    .map((item) => item.limit)
    .filter((n): n is number => typeof n === "number" && n > 0);

  // Prefer API-provided limits when available (more future-proof than hardcoding).
  const total = limits.length ? Math.max(...limits) : COPILOT_PLAN_LIMITS[tier];

  if (!total || total <= 0) {
    throw new Error(`Unsupported Copilot tier: ${tier}`);
  }

  const remaining = Math.max(0, total - used);
  const percentRemaining = Math.max(0, Math.min(100, Math.round((remaining / total) * 100)));

  return {
    success: true,
    used,
    total,
    percentRemaining,
    resetTimeIso: getApproxNextResetIso(),
  };
}

interface CopilotTokenResponse {
  token: string;
  expires_at: number;
  refresh_in: number;
  endpoints: { api: string };
}

async function exchangeForCopilotToken(oauthToken: string): Promise<string | null> {
  try {
    const response = await fetchWithTimeout(COPILOT_TOKEN_EXCHANGE_URL, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${oauthToken}`,
        ...COPILOT_HEADERS,
      },
    });

    if (!response.ok) {
      return null;
    }

    const tokenData = (await response.json()) as CopilotTokenResponse;
    if (!tokenData || typeof tokenData.token !== "string") return null;
    return tokenData.token;
  } catch {
    return null;
  }
}

/**
 * Fetch Copilot usage from GitHub internal API.
 * Tries multiple authentication methods to handle old/new token formats.
 */
async function fetchCopilotUsage(authData: CopilotAuthData): Promise<CopilotUsageResponse> {
  const oauthToken = authData.refresh || authData.access;
  if (!oauthToken) {
    throw new Error("No OAuth token found in auth data");
  }

  const cachedAccessToken = authData.access;
  const tokenExpiry = authData.expires || 0;

  // Strategy 1: If we have a valid cached access token (from previous exchange), use it.
  if (cachedAccessToken && cachedAccessToken !== oauthToken && tokenExpiry > Date.now()) {
    const response = await fetchWithTimeout(COPILOT_INTERNAL_USER_URL, {
      headers: buildBearerHeaders(cachedAccessToken),
    });

    if (response.ok) {
      return response.json() as Promise<CopilotUsageResponse>;
    }
  }

  // Strategy 2: Try direct call with OAuth token (newer tokens generally expect Bearer).
  const directBearerResponse = await fetchWithTimeout(COPILOT_INTERNAL_USER_URL, {
    headers: buildBearerHeaders(oauthToken),
  });

  if (directBearerResponse.ok) {
    return directBearerResponse.json() as Promise<CopilotUsageResponse>;
  }

  // Strategy 2b: Legacy auth format.
  const directLegacyResponse = await fetchWithTimeout(COPILOT_INTERNAL_USER_URL, {
    headers: buildLegacyTokenHeaders(oauthToken),
  });

  if (directLegacyResponse.ok) {
    return directLegacyResponse.json() as Promise<CopilotUsageResponse>;
  }

  // Strategy 3: Exchange OAuth token for Copilot session token (new auth flow).
  const copilotToken = await exchangeForCopilotToken(oauthToken);
  if (!copilotToken) {
    const errorText = await directLegacyResponse.text();
    throw new Error(`GitHub Copilot quota unavailable: ${errorText.slice(0, 160)}`);
  }

  const exchangedResponse = await fetchWithTimeout(COPILOT_INTERNAL_USER_URL, {
    headers: buildBearerHeaders(copilotToken),
  });

  if (!exchangedResponse.ok) {
    const errorText = await exchangedResponse.text();
    throw new Error(`GitHub API error ${exchangedResponse.status}: ${errorText.slice(0, 160)}`);
  }

  return exchangedResponse.json() as Promise<CopilotUsageResponse>;
}

// =============================================================================
// Export
// =============================================================================

/**
 * Query GitHub Copilot premium requests quota
 *
 * @returns Quota result, error, or null if not configured
 */
export async function queryCopilotQuota(): Promise<CopilotResult> {
  // Strategy 1: Try public billing API with user's fine-grained PAT.
  const quotaConfig = readQuotaConfig();
  if (quotaConfig) {
    try {
      const billing = await fetchPublicBillingUsage(quotaConfig);
      return toQuotaResultFromBilling(billing, quotaConfig.tier);
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      } as QuotaError;
    }
  }

  // Strategy 2: Best-effort internal API using OpenCode auth.
  const auth = await readCopilotAuth();
  if (!auth) {
    return null; // Not configured
  }

  try {
    const data = await fetchCopilotUsage(auth);
    const premium = data.quota_snapshots.premium_interactions;

    if (!premium) {
      return {
        success: false,
        error: "No premium quota data",
      } as QuotaError;
    }

    if (premium.unlimited) {
      return {
        success: true,
        used: 0,
        total: -1, // Indicate unlimited
        percentRemaining: 100,
        resetTimeIso: data.quota_reset_date,
      } as CopilotQuotaResult;
    }

    const total = premium.entitlement;
    const used = total - premium.remaining;
    const percentRemaining = Math.round(premium.percent_remaining);

    return {
      success: true,
      used,
      total,
      percentRemaining,
      resetTimeIso: data.quota_reset_date,
    } as CopilotQuotaResult;
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    } as QuotaError;
  }
}

/**
 * Format Copilot quota for toast display
 *
 * @param result - Copilot quota result
 * @returns Formatted string like "Copilot 229/300 (24%)" or null
 */
export function formatCopilotQuota(result: CopilotResult): string | null {
  if (!result) {
    return null;
  }

  if (!result.success) {
    return null;
  }

  if (result.total === -1) {
    return "Copilot Unlimited";
  }

  const percentUsed = 100 - result.percentRemaining;
  return `Copilot ${result.used}/${result.total} (${percentUsed}%)`;
}
