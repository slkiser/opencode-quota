/**
 * GitHub Copilot premium request usage fetcher.
 *
 * The plugin uses GitHub billing APIs for PAT-backed usage checks and
 * `GET /copilot_internal/user` for OAuth-backed personal quota checks.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";

import type {
  AuthData,
  CopilotAuthData,
  CopilotEnterpriseUsageResult,
  CopilotOrganizationUsageResult,
  CopilotQuotaConfig,
  CopilotQuotaResult,
  CopilotResult,
  CopilotTier,
  QuotaError,
} from "./types.js";
import { fetchWithTimeout } from "./http.js";
import { readAuthFile } from "./opencode-auth.js";
import { getOpencodeRuntimeDirCandidates } from "./opencode-runtime-paths.js";

const GITHUB_API_BASE_URL = "https://api.github.com";
const COPILOT_INTERNAL_USER_URL = `${GITHUB_API_BASE_URL}/copilot_internal/user`;
const GITHUB_API_VERSION = "2022-11-28";
const COPILOT_QUOTA_CONFIG_FILENAME = "copilot-quota-token.json";
const USER_AGENT = "opencode-quota/copilot-billing";

type GitHubRestAuthScheme = "bearer" | "token";
type CopilotAuthKeyName =
  | "github-copilot"
  | "copilot"
  | "copilot-chat"
  | "github-copilot-chat";
type CopilotPatTokenKind = "github_pat" | "ghp" | "ghu" | "ghs" | "other";
type EffectiveCopilotAuthSource = "pat" | "oauth" | "none";
type CopilotQuotaApi = "github_billing_api" | "copilot_internal_user" | "none";
type CopilotBillingMode = "user_quota" | "organization_usage" | "enterprise_usage" | "none";
type CopilotRemainingTotalsState =
  | "available"
  | "not_available_from_org_usage"
  | "not_available_from_enterprise_usage"
  | "unavailable";

interface UserBillingTarget {
  scope: "user";
  username?: string;
}

interface OrganizationBillingTarget {
  scope: "organization";
  organization: string;
  username?: string;
  billingPeriod: BillingPeriodQuery;
}

interface EnterpriseBillingTarget {
  scope: "enterprise";
  enterprise: string;
  organization?: string;
  username?: string;
  billingPeriod: BillingPeriodQuery;
}

type CopilotBillingTarget = UserBillingTarget | OrganizationBillingTarget | EnterpriseBillingTarget;
type CopilotRequestTarget =
  | { scope: "user"; username: string }
  | OrganizationBillingTarget
  | EnterpriseBillingTarget;

export type CopilotPatState = "absent" | "invalid" | "valid";

export interface CopilotPatReadResult {
  state: CopilotPatState;
  checkedPaths: string[];
  selectedPath?: string;
  config?: CopilotQuotaConfig;
  error?: string;
  tokenKind?: CopilotPatTokenKind;
}

export interface CopilotQuotaAuthDiagnostics {
  pat: CopilotPatReadResult;
  oauth: {
    configured: boolean;
    keyName: CopilotAuthKeyName | null;
    hasRefreshToken: boolean;
    hasAccessToken: boolean;
  };
  effectiveSource: EffectiveCopilotAuthSource;
  override: "pat_overrides_oauth" | "none";
  quotaApi: CopilotQuotaApi;
  billingMode: CopilotBillingMode;
  billingScope: "user" | "organization" | "enterprise" | "none";
  billingApiAccessLikely: boolean;
  remainingTotalsState: CopilotRemainingTotalsState;
  queryPeriod?: {
    year: number;
    month: number;
  };
  usernameFilter?: string;
  billingTargetError?: string;
  tokenCompatibilityError?: string;
}

interface BillingUsageItem {
  product?: string;
  sku?: string;
  model?: string;
  unitType?: string;
  unit_type?: string;
  grossQuantity?: number;
  gross_quantity?: number;
  netQuantity?: number;
  net_quantity?: number;
  limit?: number;
}

interface BillingUsageResponse {
  timePeriod?: { year: number; month?: number };
  time_period?: { year: number; month?: number };
  user?: string;
  organization?: string;
  enterprise?: string;
  usageItems?: BillingUsageItem[];
  usage_items?: BillingUsageItem[];
}

interface GitHubViewerResponse {
  login?: string;
}

function getNestedValue(source: unknown, path: string[]): unknown {
  let current = source;

  for (const key of path) {
    if (!current || typeof current !== "object" || !(key in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }

  return current;
}

function getFirstNestedValue(source: unknown, paths: string[][]): unknown {
  for (const path of paths) {
    const value = getNestedValue(source, path);
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

function coerceFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function coerceNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function getFirstNestedNumber(source: unknown, paths: string[][]): number | undefined {
  return coerceFiniteNumber(getFirstNestedValue(source, paths));
}

function getFirstNestedString(source: unknown, paths: string[][]): string | undefined {
  return coerceNonEmptyString(getFirstNestedValue(source, paths));
}

function normalizeCopilotTier(value: string | undefined): CopilotTier | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "free") return "free";
  if (normalized === "pro") return "pro";
  if (normalized === "pro+" || normalized === "pro_plus" || normalized === "pro-plus") {
    return "pro+";
  }
  if (normalized === "business") return "business";
  if (normalized === "enterprise") return "enterprise";
  return undefined;
}

interface BillingPeriodQuery {
  year: number;
  month: number;
  day?: number;
}

const COPILOT_PLAN_LIMITS: Record<CopilotTier, number> = {
  free: 50,
  pro: 300,
  "pro+": 1500,
  business: 300,
  enterprise: 1000,
};

function dedupeStrings(values: Array<string | undefined | null>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }

  return out;
}

function classifyPatTokenKind(token: string): CopilotPatTokenKind {
  if (token.startsWith("github_pat_")) return "github_pat";
  if (token.startsWith("ghp_")) return "ghp";
  if (token.startsWith("ghu_")) return "ghu";
  if (token.startsWith("ghs_")) return "ghs";
  return "other";
}

function getCurrentBillingPeriod(now: Date = new Date()): BillingPeriodQuery {
  return {
    year: now.getFullYear(),
    month: now.getMonth() + 1,
  };
}

function buildBillingPeriodQueryParams(
  period: BillingPeriodQuery,
  options?: {
    includeDay?: boolean;
    username?: string;
    organization?: string;
  },
): URLSearchParams {
  const searchParams = new URLSearchParams();
  searchParams.set("year", String(period.year));
  searchParams.set("month", String(period.month));

  if (options?.includeDay && typeof period.day === "number") {
    searchParams.set("day", String(period.day));
  }

  if (options?.organization) {
    searchParams.set("organization", options.organization);
  }

  if (options?.username) {
    searchParams.set("user", options.username);
  }

  return searchParams;
}

function getBillingModeForTarget(target: CopilotBillingTarget | null): CopilotBillingMode {
  if (!target) return "none";
  if (target.scope === "organization") return "organization_usage";
  if (target.scope === "enterprise") return "enterprise_usage";
  return "user_quota";
}

function getBillingScopeForTarget(
  target: CopilotBillingTarget | null,
): "user" | "organization" | "enterprise" | "none" {
  return target?.scope ?? "none";
}

function getRemainingTotalsStateForTarget(
  target: CopilotBillingTarget | null,
): CopilotRemainingTotalsState {
  if (!target) return "unavailable";
  if (target.scope === "organization") return "not_available_from_org_usage";
  if (target.scope === "enterprise") return "not_available_from_enterprise_usage";
  return "available";
}

function resolvePatBillingTarget(config: CopilotQuotaConfig): {
  target: CopilotBillingTarget | null;
  error?: string;
} {
  const billingPeriod = getCurrentBillingPeriod();

  if (config.tier === "business") {
    if (config.enterprise) {
      return {
        target: null,
        error:
          'Copilot business usage is organization-scoped. Remove "enterprise" and keep "organization" in copilot-quota-token.json.',
      };
    }

    if (!config.organization) {
      return {
        target: null,
        error:
          'Copilot business usage requires an organization-scoped billing report. Add "organization": "your-org-slug" to copilot-quota-token.json.',
      };
    }

    return {
      target: {
        scope: "organization",
        organization: config.organization,
        username: config.username,
        billingPeriod,
      },
    };
  }

  if (config.tier === "enterprise") {
    if (config.enterprise) {
      return {
        target: {
          scope: "enterprise",
          enterprise: config.enterprise,
          organization: config.organization,
          username: config.username,
          billingPeriod,
        },
      };
    }

    if (config.organization) {
      return {
        target: {
          scope: "organization",
          organization: config.organization,
          username: config.username,
          billingPeriod,
        },
      };
    }

    return {
      target: null,
      error:
        'Copilot enterprise usage requires an enterprise- or organization-scoped billing report. Add "enterprise": "your-enterprise-slug" or "organization": "your-org-slug" to copilot-quota-token.json.',
    };
  }

  if (config.organization || config.enterprise) {
    return {
      target: null,
      error:
        `Copilot ${config.tier} usage is user-scoped. Remove "organization"/"enterprise" from copilot-quota-token.json or switch to a managed tier.`,
    };
  }

  return {
    target: {
      scope: "user",
      username: config.username,
    },
  };
}

function validatePatTargetCompatibility(
  target: CopilotBillingTarget,
  tokenKind?: CopilotPatTokenKind,
): string | null {
  if (target.scope !== "enterprise" || !tokenKind) {
    return null;
  }

  if (tokenKind === "github_pat") {
    return (
      "GitHub's enterprise premium usage endpoint does not support fine-grained personal access tokens. " +
      "Use a classic PAT or another supported non-fine-grained token for enterprise billing."
    );
  }

  if (tokenKind === "ghu" || tokenKind === "ghs") {
    return (
      "GitHub's enterprise premium usage endpoint does not support GitHub App user or installation access tokens."
    );
  }

  return null;
}

export function getCopilotPatConfigCandidatePaths(): string[] {
  const { configDirs } = getOpencodeRuntimeDirCandidates();
  return dedupeStrings(
    configDirs.map((configDir) => join(configDir, COPILOT_QUOTA_CONFIG_FILENAME)),
  );
}

function validateQuotaConfig(raw: unknown): { config: CopilotQuotaConfig | null; error?: string } {
  if (!raw || typeof raw !== "object") {
    return { config: null, error: "Config must be a JSON object" };
  }

  const obj = raw as Record<string, unknown>;
  const token = typeof obj.token === "string" ? obj.token.trim() : "";
  const tier = typeof obj.tier === "string" ? obj.tier.trim() : "";

  if (!token) {
    return { config: null, error: "Missing required string field: token" };
  }

  const validTiers: CopilotTier[] = ["free", "pro", "pro+", "business", "enterprise"];
  if (!validTiers.includes(tier as CopilotTier)) {
    return {
      config: null,
      error: "Invalid tier; expected one of: free, pro, pro+, business, enterprise",
    };
  }

  const usernameRaw = obj.username;
  let username: string | undefined;
  if (usernameRaw != null) {
    if (typeof usernameRaw !== "string" || !usernameRaw.trim()) {
      return { config: null, error: "username must be a non-empty string when provided" };
    }
    username = usernameRaw.trim();
  }

  const organizationRaw = obj.organization;
  let organization: string | undefined;
  if (organizationRaw != null) {
    if (typeof organizationRaw !== "string" || !organizationRaw.trim()) {
      return { config: null, error: "organization must be a non-empty string when provided" };
    }
    organization = organizationRaw.trim();
  }

  const enterpriseRaw = obj.enterprise;
  let enterprise: string | undefined;
  if (enterpriseRaw != null) {
    if (typeof enterpriseRaw !== "string" || !enterpriseRaw.trim()) {
      return { config: null, error: "enterprise must be a non-empty string when provided" };
    }
    enterprise = enterpriseRaw.trim();
  }

  return {
    config: {
      token,
      tier: tier as CopilotTier,
      username,
      organization,
      enterprise,
    },
  };
}

export function readQuotaConfigWithMeta(): CopilotPatReadResult {
  const checkedPaths = getCopilotPatConfigCandidatePaths();

  for (const path of checkedPaths) {
    if (!existsSync(path)) continue;

    try {
      const content = readFileSync(path, "utf-8");
      const parsed = JSON.parse(content) as unknown;
      const validated = validateQuotaConfig(parsed);

      if (!validated.config) {
        return {
          state: "invalid",
          checkedPaths,
          selectedPath: path,
          error: validated.error ?? "Invalid config",
        };
      }

      return {
        state: "valid",
        checkedPaths,
        selectedPath: path,
        config: validated.config,
        tokenKind: classifyPatTokenKind(validated.config.token),
      };
    } catch (error) {
      return {
        state: "invalid",
        checkedPaths,
        selectedPath: path,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return { state: "absent", checkedPaths };
}

function selectCopilotAuth(authData: AuthData | null): {
  auth: CopilotAuthData | null;
  keyName: CopilotAuthKeyName | null;
} {
  if (!authData) {
    return { auth: null, keyName: null };
  }

  const candidates: Array<[CopilotAuthKeyName, CopilotAuthData | undefined]> = [
    ["github-copilot", authData["github-copilot"]],
    ["copilot", authData.copilot],
    ["copilot-chat", authData["copilot-chat"]],
    ["github-copilot-chat", authData["github-copilot-chat"]],
  ];

  for (const [keyName, auth] of candidates) {
    if (!auth || auth.type !== "oauth") continue;
    if (!auth.access && !auth.refresh) continue;
    return { auth, keyName };
  }

  return { auth: null, keyName: null };
}

export function getCopilotQuotaAuthDiagnostics(authData: AuthData | null): CopilotQuotaAuthDiagnostics {
  const pat = readQuotaConfigWithMeta();
  const { auth, keyName } = selectCopilotAuth(authData);
  const resolvedPatTarget =
    pat.state === "valid" && pat.config ? resolvePatBillingTarget(pat.config) : { target: null };
  const tokenCompatibilityError =
    pat.state === "valid" && resolvedPatTarget.target
      ? validatePatTargetCompatibility(resolvedPatTarget.target, pat.tokenKind)
      : null;

  const patBlocksOAuth = pat.state !== "absent";
  let effectiveSource: EffectiveCopilotAuthSource = "none";
  if (patBlocksOAuth) effectiveSource = "pat";
  else if (auth) effectiveSource = "oauth";

  const billingTarget =
    pat.state === "valid"
      ? resolvedPatTarget.target
      : !patBlocksOAuth && auth
        ? ({ scope: "user" } as const)
        : null;
  const billingMode = getBillingModeForTarget(billingTarget);
  const oauthHasAccessToken = Boolean(auth?.access?.trim());
  const quotaApi: CopilotQuotaApi =
    effectiveSource === "pat"
      ? pat.state === "valid"
        ? "github_billing_api"
        : "none"
      : effectiveSource === "oauth" && oauthHasAccessToken
        ? "copilot_internal_user"
        : "none";

  return {
    pat,
    oauth: {
      configured: Boolean(auth),
      keyName,
      hasRefreshToken: Boolean(auth?.refresh),
      hasAccessToken: oauthHasAccessToken,
    },
    effectiveSource,
    override: patBlocksOAuth && auth ? "pat_overrides_oauth" : "none",
    quotaApi,
    billingMode,
    billingScope: getBillingScopeForTarget(billingTarget),
    billingApiAccessLikely:
      effectiveSource === "pat"
        ? Boolean(billingTarget) && !resolvedPatTarget.error && !tokenCompatibilityError
        : quotaApi === "copilot_internal_user",
    remainingTotalsState: getRemainingTotalsStateForTarget(billingTarget),
    queryPeriod:
      billingTarget && billingTarget.scope !== "user"
        ? billingTarget.billingPeriod
        : undefined,
    usernameFilter: pat.state === "valid" ? pat.config?.username : undefined,
    billingTargetError: pat.state === "valid" ? resolvedPatTarget.error : undefined,
    tokenCompatibilityError: tokenCompatibilityError ?? undefined,
  };
}

function buildGitHubRestHeaders(
  token: string,
  scheme: GitHubRestAuthScheme,
): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: scheme === "bearer" ? `Bearer ${token}` : `token ${token}`,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": USER_AGENT,
  };
}

function preferredSchemesForToken(token: string): GitHubRestAuthScheme[] {
  if (token.startsWith("ghp_")) {
    return ["token", "bearer"];
  }

  return ["bearer", "token"];
}

async function readGitHubRestErrorMessage(response: Response): Promise<string> {
  const text = await response.text();

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const message = typeof parsed.message === "string" ? parsed.message : null;
    const documentationUrl =
      typeof parsed.documentation_url === "string" ? parsed.documentation_url : null;

    if (message && documentationUrl) {
      return `${message} (${documentationUrl})`;
    }

    if (message) {
      return message;
    }
  } catch {
    // ignore parse failures
  }

  return text.slice(0, 160);
}

async function fetchGitHubRestJsonOnce<T>(
  url: string,
  token: string,
  scheme: GitHubRestAuthScheme,
): Promise<{ ok: true; status: number; data: T } | { ok: false; status: number; message: string }> {
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

async function resolveGitHubUsername(token: string): Promise<string> {
  const url = `${GITHUB_API_BASE_URL}/user`;
  let unauthorized: { status: number; message: string } | null = null;

  for (const scheme of preferredSchemesForToken(token)) {
    const result = await fetchGitHubRestJsonOnce<GitHubViewerResponse>(url, token, scheme);

    if (result.ok) {
      const login = result.data.login?.trim();
      if (login) return login;
      throw new Error("GitHub /user response did not include a login");
    }

    if (result.status === 401) {
      unauthorized = { status: result.status, message: result.message };
      continue;
    }

    throw new Error(`GitHub API error ${result.status}: ${result.message}`);
  }

  if (unauthorized) {
    throw new Error(
      `GitHub API error ${unauthorized.status}: ${unauthorized.message} (token rejected while resolving username)`,
    );
  }

  throw new Error("Unable to resolve GitHub username for Copilot billing request");
}

function getBillingRequestUrl(target: CopilotRequestTarget): string {
  if (target.scope === "enterprise") {
    const base = `${GITHUB_API_BASE_URL}/enterprises/${encodeURIComponent(target.enterprise)}/settings/billing/premium_request/usage`;
    const searchParams = buildBillingPeriodQueryParams(target.billingPeriod, {
      organization: target.organization,
      username: target.username,
    });
    return `${base}?${searchParams.toString()}`;
  }

  if (target.scope === "organization") {
    const base = `${GITHUB_API_BASE_URL}/organizations/${encodeURIComponent(target.organization)}/settings/billing/premium_request/usage`;
    const searchParams = buildBillingPeriodQueryParams(target.billingPeriod, {
      username: target.username,
    });
    return `${base}?${searchParams.toString()}`;
  }

  return `${GITHUB_API_BASE_URL}/users/${encodeURIComponent(target.username)}/settings/billing/premium_request/usage`;
}

async function fetchPremiumRequestUsage(params: {
  token: string;
  target: CopilotBillingTarget;
}): Promise<{ response: BillingUsageResponse; billingPeriod?: BillingPeriodQuery }> {
  const requestTarget: CopilotRequestTarget =
    params.target.scope === "user"
      ? {
          scope: "user",
          username: params.target.username ?? (await resolveGitHubUsername(params.token)),
        }
      : params.target;

  const url = getBillingRequestUrl(requestTarget);

  let unauthorized: { status: number; message: string } | null = null;

  for (const scheme of preferredSchemesForToken(params.token)) {
    const result = await fetchGitHubRestJsonOnce<BillingUsageResponse>(url, params.token, scheme);

    if (result.ok) {
      return {
        response: result.data,
        billingPeriod: requestTarget.scope === "user" ? undefined : requestTarget.billingPeriod,
      };
    }

    if (result.status === 401) {
      unauthorized = { status: result.status, message: result.message };
      continue;
    }

    throw new Error(`GitHub API error ${result.status}: ${result.message}`);
  }

  if (unauthorized) {
    throw new Error(
      `GitHub API error ${unauthorized.status}: ${unauthorized.message} (token rejected for Copilot premium request usage)`,
    );
  }

  throw new Error("Unable to fetch Copilot premium request usage");
}

async function fetchCopilotInternalUser(token: string): Promise<unknown> {
  const result = await fetchGitHubRestJsonOnce<unknown>(COPILOT_INTERNAL_USER_URL, token, "bearer");
  if (result.ok) {
    return result.data;
  }

  throw new Error(`GitHub API error ${result.status}: ${result.message}`);
}

function toUserQuotaResultFromCopilotInternal(response: unknown): CopilotQuotaResult {
  const totalPaths = [
    ["quota", "limit"],
    ["quota", "total"],
    ["monthly_quota", "limit"],
    ["monthly_quota", "total"],
    ["monthly_premium_requests", "limit"],
    ["monthly_premium_requests", "total"],
    ["premium_requests", "limit"],
    ["premium_requests", "total"],
    ["limit"],
    ["total"],
    ["quota_limit"],
    ["monthly_limit"],
    ["included_premium_requests"],
  ];
  const usedPaths = [
    ["quota", "used"],
    ["monthly_quota", "used"],
    ["monthly_premium_requests", "used"],
    ["premium_requests", "used"],
    ["used"],
    ["quota_used"],
    ["monthly_used"],
    ["premium_requests_used"],
  ];
  const remainingPaths = [
    ["quota", "remaining"],
    ["monthly_quota", "remaining"],
    ["monthly_premium_requests", "remaining"],
    ["premium_requests", "remaining"],
    ["remaining"],
    ["quota_remaining"],
    ["monthly_remaining"],
    ["premium_requests_remaining"],
  ];
  const resetPaths = [
    ["quota", "reset_at"],
    ["monthly_quota", "reset_at"],
    ["monthly_premium_requests", "reset_at"],
    ["premium_requests", "reset_at"],
    ["reset_at"],
    ["quota_reset_at"],
  ];
  const tierPaths = [
    ["plan", "type"],
    ["plan", "name"],
    ["plan"],
    ["subscription_plan"],
    ["sku"],
  ];

  let total = getFirstNestedNumber(response, totalPaths);
  let used = getFirstNestedNumber(response, usedPaths);
  const remaining = getFirstNestedNumber(response, remainingPaths);
  const resetTimeIso = getFirstNestedString(response, resetPaths) ?? getApproxNextResetIso();
  const tier = normalizeCopilotTier(getFirstNestedString(response, tierPaths));

  if (total === undefined && used !== undefined && remaining !== undefined) {
    total = used + remaining;
  }
  if (used === undefined && total !== undefined && remaining !== undefined) {
    used = Math.max(0, total - remaining);
  }
  if (total === undefined && tier) {
    total = COPILOT_PLAN_LIMITS[tier];
  }

  if (!Number.isFinite(total) || total === undefined || total <= 0 || used === undefined || used < 0) {
    throw new Error(
      "GitHub /copilot_internal/user response did not include usable personal quota fields.",
    );
  }

  return {
    success: true,
    mode: "user_quota",
    used,
    total,
    percentRemaining: computePercentRemainingFromUsed({ used, total }),
    resetTimeIso,
  };
}

function getApproxNextResetIso(nowMs: number = Date.now()): string {
  const now = new Date(nowMs);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

function computePercentRemainingFromUsed(params: { used: number; total: number }): number {
  const { used, total } = params;
  if (!Number.isFinite(total) || total <= 0) return 0;
  if (!Number.isFinite(used) || used <= 0) return 100;
  const remaining = Math.max(0, total - Math.max(0, used));
  return Math.max(0, Math.min(100, Math.floor((remaining * 100) / total)));
}

function getPremiumUsageItems(
  response: BillingUsageResponse,
  options?: { allowEmpty?: boolean },
): BillingUsageItem[] {
  const items = Array.isArray(response.usageItems)
    ? response.usageItems
    : Array.isArray(response.usage_items)
      ? response.usage_items
      : [];

  const premiumItems = items.filter((item) => {
    if (!item || typeof item !== "object") return false;
    if (typeof item.sku !== "string") return false;
    return item.sku === "Copilot Premium Request" || item.sku.includes("Premium");
  });

  if (premiumItems.length === 0 && items.length > 0) {
    const skus = items.map((item) => (typeof item?.sku === "string" ? item.sku : "?")).join(", ");
    throw new Error(
      `No premium-request items found in billing response (${items.length} items, SKUs: ${skus}). Expected an item with SKU containing "Premium".`,
    );
  }

  if (premiumItems.length === 0 && options?.allowEmpty) {
    return [];
  }

  if (premiumItems.length === 0) {
    throw new Error("Billing API returned empty usageItems array for Copilot premium requests.");
  }

  return premiumItems;
}

function sumUsedUnits(items: BillingUsageItem[]): number {
  return items.reduce((sum, item) => {
    const used =
      item.grossQuantity ??
      item.gross_quantity ??
      item.netQuantity ??
      item.net_quantity ??
      0;
    return sum + (typeof used === "number" ? used : 0);
  }, 0);
}

function formatBillingPeriod(period: { year: number; month: number }): string {
  return `${period.year}-${String(period.month).padStart(2, "0")}`;
}

function getBillingResponsePeriod(
  response: BillingUsageResponse,
  fallbackPeriod: BillingPeriodQuery,
): { year: number; month: number } {
  const timePeriod = response.timePeriod ?? response.time_period;
  const year = typeof timePeriod?.year === "number" ? timePeriod.year : fallbackPeriod.year;
  const month = typeof timePeriod?.month === "number" ? timePeriod.month : fallbackPeriod.month;
  return { year, month };
}

function toUserQuotaResultFromBilling(
  response: BillingUsageResponse,
  fallbackTier?: CopilotTier,
): CopilotQuotaResult {
  const premiumItems = getPremiumUsageItems(response);
  const used = sumUsedUnits(premiumItems);

  const apiLimits = premiumItems
    .map((item) => item.limit)
    .filter((limit): limit is number => typeof limit === "number" && limit > 0);

  const total = apiLimits.length > 0 ? Math.max(...apiLimits) : fallbackTier ? COPILOT_PLAN_LIMITS[fallbackTier] : undefined;

  if (!total || total <= 0) {
    throw new Error(
      "Copilot billing response did not include a limit. Configure copilot-quota-token.json with your tier so the plugin can compute quota totals.",
    );
  }

  return {
    success: true,
    mode: "user_quota",
    used,
    total,
    percentRemaining: computePercentRemainingFromUsed({ used, total }),
    resetTimeIso: getApproxNextResetIso(),
  };
}

function toOrganizationUsageResultFromBilling(params: {
  response: BillingUsageResponse;
  organization: string;
  username?: string;
  billingPeriod: BillingPeriodQuery;
}): CopilotOrganizationUsageResult {
  const premiumItems = getPremiumUsageItems(params.response, { allowEmpty: true });

  return {
    success: true,
    mode: "organization_usage",
    organization: params.organization,
    username: params.username,
    period: getBillingResponsePeriod(params.response, params.billingPeriod),
    used: sumUsedUnits(premiumItems),
    resetTimeIso: getApproxNextResetIso(),
  };
}

function toEnterpriseUsageResultFromBilling(params: {
  response: BillingUsageResponse;
  enterprise: string;
  organization?: string;
  username?: string;
  billingPeriod: BillingPeriodQuery;
}): CopilotEnterpriseUsageResult {
  const premiumItems = getPremiumUsageItems(params.response, { allowEmpty: true });

  return {
    success: true,
    mode: "enterprise_usage",
    enterprise: params.enterprise,
    organization: params.organization,
    username: params.username,
    period: getBillingResponsePeriod(params.response, params.billingPeriod),
    used: sumUsedUnits(premiumItems),
    resetTimeIso: getApproxNextResetIso(),
  };
}

function toQuotaError(message: string): QuotaError {
  return { success: false, error: message };
}

/**
 * Query GitHub Copilot premium request usage.
 *
 * PAT configuration wins over OpenCode OAuth auth when both are present.
 */
export async function queryCopilotQuota(): Promise<CopilotResult> {
  const pat = readQuotaConfigWithMeta();

  if (pat.state === "invalid") {
    return toQuotaError(
      `Invalid copilot-quota-token.json: ${pat.error ?? "unknown error"}${pat.selectedPath ? ` (${pat.selectedPath})` : ""}`,
    );
  }

  if (pat.state === "valid" && pat.config) {
    const resolvedTarget = resolvePatBillingTarget(pat.config);
    if (!resolvedTarget.target) {
      return toQuotaError(resolvedTarget.error ?? "Unable to resolve Copilot billing scope.");
    }

    const tokenCompatibilityError = validatePatTargetCompatibility(
      resolvedTarget.target,
      pat.tokenKind,
    );
    if (tokenCompatibilityError) {
      return toQuotaError(tokenCompatibilityError);
    }

    try {
      const { response, billingPeriod } = await fetchPremiumRequestUsage({
        token: pat.config.token,
        target: resolvedTarget.target,
      });

      if (resolvedTarget.target.scope === "organization") {
        return toOrganizationUsageResultFromBilling({
          response,
          organization: resolvedTarget.target.organization,
          username: resolvedTarget.target.username,
          billingPeriod: billingPeriod ?? resolvedTarget.target.billingPeriod,
        });
      }

      if (resolvedTarget.target.scope === "enterprise") {
        return toEnterpriseUsageResultFromBilling({
          response,
          enterprise: resolvedTarget.target.enterprise,
          organization: resolvedTarget.target.organization,
          username: resolvedTarget.target.username,
          billingPeriod: billingPeriod ?? resolvedTarget.target.billingPeriod,
        });
      }

      return toUserQuotaResultFromBilling(response, pat.config.tier);
    } catch (error) {
      return toQuotaError(error instanceof Error ? error.message : String(error));
    }
  }

  const authData = await readAuthFile();
  const { auth } = selectCopilotAuth(authData);
  if (!auth) {
    return null;
  }

  const accessToken = auth.access?.trim();
  if (!accessToken) {
    return toQuotaError(
      "Copilot OAuth auth is configured but missing an access token required for GitHub /copilot_internal/user.",
    );
  }

  try {
    const response = await fetchCopilotInternalUser(accessToken);
    return toUserQuotaResultFromCopilotInternal(response);
  } catch (error) {
    return toQuotaError(error instanceof Error ? error.message : String(error));
  }
}

export function formatCopilotQuota(result: CopilotResult): string | null {
  if (!result || !result.success) {
    return null;
  }

  if (result.mode === "organization_usage") {
    const details = [`${result.used} used`, formatBillingPeriod(result.period)];
    if (result.username) {
      details.push(`user=${result.username}`);
    }
    return `Copilot Org (${result.organization}) ${details.join(" | ")}`;
  }

  if (result.mode === "enterprise_usage") {
    const details = [`${result.used} used`, formatBillingPeriod(result.period)];
    if (result.organization) {
      details.push(`org=${result.organization}`);
    }
    if (result.username) {
      details.push(`user=${result.username}`);
    }
    return `Copilot Enterprise (${result.enterprise}) ${details.join(" | ")}`;
  }

  const percentUsed = 100 - result.percentRemaining;
  return `Copilot ${result.used}/${result.total} (${percentUsed}%)`;
}
