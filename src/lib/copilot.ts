/**
 * GitHub Copilot accounting fetcher.
 *
 * Current usage is read from GitHub's public AI Credit billing reports.
 * Legacy premium-request reports are available only when explicitly selected
 * for an eligible Copilot Pro or Pro+ annual plan.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";

import type {
  AuthData,
  CopilotAuthData,
  CopilotBillingModel,
  CopilotBudgetResult,
  CopilotEnterpriseUsageResult,
  CopilotOrganizationUsageResult,
  CopilotQuotaConfig,
  CopilotQuotaResult,
  CopilotResult,
  CopilotTier,
  QuotaError,
} from "./types.js";
import { sanitizeDisplaySnippet, sanitizeDisplayText } from "./display-sanitize.js";
import { fetchWithTimeout } from "./http.js";
import { readAuthFile } from "./opencode-auth.js";
import { getOpencodeRuntimeDirCandidates } from "./opencode-runtime-paths.js";

const GITHUB_API_BASE_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";
const COPILOT_QUOTA_CONFIG_FILENAME = "copilot-quota-token.json";
const USER_AGENT = "opencode-quota/copilot-billing";

type CopilotAuthKeyName = "github-copilot" | "copilot" | "copilot-chat" | "github-copilot-chat";
type CopilotPatTokenKind = "github_pat" | "ghp" | "ghu" | "ghs" | "other";
type EffectiveCopilotAuthSource = "pat" | "oauth" | "none";
type CopilotQuotaApi =
  | "github_ai_credit_api"
  | "github_legacy_premium_request_api"
  | "github_billing_api"
  | "copilot_internal_user"
  | "none";
type CopilotBillingMode = "user_quota" | "organization_usage" | "enterprise_usage" | "none";
type CopilotRemainingTotalsState =
  | "available"
  | "value_only_without_denominator"
  | "not_available_from_org_usage"
  | "not_available_from_enterprise_usage"
  | "unavailable";

interface BillingPeriodQuery {
  year: number;
  month: number;
}

interface UserBillingTarget {
  scope: "user";
  username?: string;
  billingPeriod: BillingPeriodQuery;
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
  | (UserBillingTarget & { username: string })
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
  queryPeriod?: BillingPeriodQuery;
  usernameFilter?: string;
  billingTargetError?: string;
  tokenCompatibilityError?: string;
  billingModel?: CopilotBillingModel;
  budgetApi: "organization_budgets" | "enterprise_budgets" | "not_available";
  oauthAccountingState: "not_supported_by_public_billing_api" | "not_configured";
}

interface BillingUsageItem {
  product?: string;
  sku?: string;
  model?: string;
  unitType?: string;
  unit_type?: string;
  grossQuantity?: number;
  gross_quantity?: number;
  grossAmount?: number;
  gross_amount?: number;
  discountQuantity?: number;
  discount_quantity?: number;
  discountAmount?: number;
  discount_amount?: number;
  netQuantity?: number;
  net_quantity?: number;
  netAmount?: number;
  net_amount?: number;
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

interface BillingBudget {
  id?: string;
  budget_type?: string;
  budget_product_sku?: string;
  budget_product_skus?: string[];
  budget_scope?: string;
  budget_entity_name?: string;
  budget_amount?: number;
  user?: string;
}

interface BillingBudgetsResponse {
  budgets?: BillingBudget[];
  has_next_page?: boolean;
}

interface GitHubViewerResponse {
  login?: string;
}

interface AiCreditTotals {
  used: number;
  includedUsed: number;
  billedUsed: number;
  billedAmountUsd?: number;
}

const PERSONAL_AI_CREDIT_TOTALS: Partial<Record<CopilotTier, number>> = {
  pro: 1500,
  "pro+": 7000,
  max: 20000,
};

const LEGACY_PREMIUM_REQUEST_TOTALS: Partial<Record<CopilotTier, number>> = {
  pro: 300,
  "pro+": 1500,
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
    year: now.getUTCFullYear(),
    month: now.getUTCMonth() + 1,
  };
}

function getApproxNextResetIso(nowMs: number = Date.now()): string {
  const now = new Date(nowMs);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

function formatBillingPeriod(period: BillingPeriodQuery): string {
  return `${period.year}-${String(period.month).padStart(2, "0")}`;
}

function computePercentRemainingFromUsed(used: number, total: number): number | undefined {
  if (!Number.isFinite(used) || used < 0 || !Number.isFinite(total) || total <= 0) {
    return undefined;
  }
  return Math.max(0, Math.min(100, Math.floor(((total - used) * 100) / total)));
}

function resolvePatBillingTarget(config: CopilotQuotaConfig): {
  target: CopilotBillingTarget | null;
  error?: string;
} {
  const billingPeriod = getCurrentBillingPeriod();

  if (config.billingModel === "legacy_premium_requests") {
    if (config.tier !== "pro" && config.tier !== "pro+") {
      return {
        target: null,
        error:
          "Legacy premium-request billing is only available to Copilot Pro or Pro+ subscribers on an existing annual plan that remained on legacy billing after June 1, 2026.",
      };
    }
    if (config.organization || config.enterprise) {
      return {
        target: null,
        error:
          "Legacy premium-request billing is personal-only. Remove organization and enterprise from copilot-quota-token.json.",
      };
    }
  }

  if (config.tier === "business") {
    if (!config.organization || config.enterprise) {
      return {
        target: null,
        error:
          'Copilot Business AI Credit usage requires "organization" and does not accept "enterprise" in copilot-quota-token.json.',
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
        'Copilot Enterprise AI Credit usage requires "enterprise" or "organization" in copilot-quota-token.json.',
    };
  }

  if (config.organization || config.enterprise) {
    return {
      target: null,
      error: `Copilot ${config.tier} AI Credit usage is personal. Remove organization and enterprise from copilot-quota-token.json.`,
    };
  }

  return {
    target: {
      scope: "user",
      username: config.username,
      billingPeriod,
    },
  };
}

function validatePatTargetCompatibility(
  target: CopilotBillingTarget,
  tokenKind?: CopilotPatTokenKind,
): string | null {
  if (!tokenKind) return null;

  if (target.scope === "user" && tokenKind === "ghs") {
    return (
      "GitHub's personal AI Credit report supports GitHub App user access tokens, " +
      "but not GitHub App installation access tokens. Use a GitHub App user token, fine-grained PAT with Plan (read), or supported classic credential."
    );
  }

  if (
    target.scope === "enterprise" &&
    (tokenKind === "github_pat" || tokenKind === "ghu" || tokenKind === "ghs")
  ) {
    return (
      "GitHub's enterprise billing reports do not support fine-grained PATs or GitHub App access tokens. " +
      "Use a classic PAT held by an enterprise admin or billing manager."
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
  const tier = typeof obj.tier === "string" ? obj.tier.trim().toLowerCase() : "";
  const billingModel =
    obj.billingModel === undefined
      ? "ai_credits"
      : typeof obj.billingModel === "string"
        ? obj.billingModel.trim()
        : "";

  if (!token) {
    return { config: null, error: "Missing required string field: token" };
  }

  const validTiers: CopilotTier[] = [
    "free",
    "student",
    "pro",
    "pro+",
    "max",
    "business",
    "enterprise",
  ];
  if (!validTiers.includes(tier as CopilotTier)) {
    return {
      config: null,
      error: "Invalid tier; expected one of: free, student, pro, pro+, max, business, enterprise",
    };
  }

  if (billingModel !== "ai_credits" && billingModel !== "legacy_premium_requests") {
    return {
      config: null,
      error: "Invalid billingModel; expected ai_credits or legacy_premium_requests",
    };
  }

  const readOptionalString = (key: "username" | "organization" | "enterprise") => {
    const value = obj[key];
    if (value == null) return undefined;
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`${key} must be a non-empty string when provided`);
    }
    return value.trim();
  };

  try {
    const config: CopilotQuotaConfig = {
      token,
      tier: tier as CopilotTier,
      billingModel,
      username: readOptionalString("username"),
      organization: readOptionalString("organization"),
      enterprise: readOptionalString("enterprise"),
    };
    const resolved = resolvePatBillingTarget(config);
    if (!resolved.target) {
      return { config: null, error: resolved.error };
    }
    return { config };
  } catch (error) {
    return { config: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export function readQuotaConfigWithMeta(): CopilotPatReadResult {
  const checkedPaths = getCopilotPatConfigCandidatePaths();

  for (const path of checkedPaths) {
    if (!existsSync(path)) continue;

    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
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
  if (!authData) return { auth: null, keyName: null };

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

function getRemainingTotalsState(
  target: CopilotBillingTarget | null,
  config?: CopilotQuotaConfig,
): CopilotRemainingTotalsState {
  if (!target || !config) return "unavailable";
  if (target.scope === "organization") return "not_available_from_org_usage";
  if (target.scope === "enterprise") return "not_available_from_enterprise_usage";

  const total =
    config.billingModel === "legacy_premium_requests"
      ? LEGACY_PREMIUM_REQUEST_TOTALS[config.tier]
      : PERSONAL_AI_CREDIT_TOTALS[config.tier];
  return total ? "available" : "value_only_without_denominator";
}

export function getCopilotQuotaAuthDiagnostics(
  authData: AuthData | null,
): CopilotQuotaAuthDiagnostics {
  const pat = readQuotaConfigWithMeta();
  const { auth, keyName } = selectCopilotAuth(authData);
  const resolved =
    pat.state === "valid" && pat.config
      ? resolvePatBillingTarget(pat.config)
      : { target: null as CopilotBillingTarget | null };
  const compatibilityError =
    resolved.target && pat.state === "valid"
      ? validatePatTargetCompatibility(resolved.target, pat.tokenKind)
      : null;
  const patBlocksOAuth = pat.state !== "absent";
  const effectiveSource: EffectiveCopilotAuthSource = patBlocksOAuth
    ? "pat"
    : auth
      ? "oauth"
      : "none";
  const billingModel = pat.config?.billingModel ?? "ai_credits";
  const quotaApi: CopilotQuotaApi =
    pat.state !== "valid"
      ? "none"
      : billingModel === "legacy_premium_requests"
        ? "github_legacy_premium_request_api"
        : "github_ai_credit_api";

  return {
    pat,
    oauth: {
      configured: Boolean(auth),
      keyName,
      hasRefreshToken: Boolean(auth?.refresh),
      hasAccessToken: Boolean(auth?.access?.trim()),
    },
    effectiveSource,
    override: patBlocksOAuth && auth ? "pat_overrides_oauth" : "none",
    quotaApi,
    billingMode:
      resolved.target?.scope === "organization"
        ? "organization_usage"
        : resolved.target?.scope === "enterprise"
          ? "enterprise_usage"
          : resolved.target?.scope === "user"
            ? "user_quota"
            : "none",
    billingScope: resolved.target?.scope ?? "none",
    billingApiAccessLikely:
      pat.state === "valid" && Boolean(resolved.target) && !resolved.error && !compatibilityError,
    remainingTotalsState: getRemainingTotalsState(resolved.target, pat.config),
    queryPeriod: resolved.target?.billingPeriod,
    usernameFilter: pat.config?.username,
    billingTargetError: resolved.error,
    tokenCompatibilityError: compatibilityError ?? undefined,
    billingModel,
    budgetApi:
      billingModel !== "ai_credits"
        ? "not_available"
        : resolved.target?.scope === "organization"
          ? "organization_budgets"
          : resolved.target?.scope === "enterprise"
            ? "enterprise_budgets"
            : "not_available",
    oauthAccountingState: auth ? "not_supported_by_public_billing_api" : "not_configured",
  };
}

function buildGitHubRestHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": USER_AGENT,
  };
}

async function readGitHubRestErrorMessage(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const message = typeof parsed.message === "string" ? parsed.message : null;
    const documentationUrl =
      typeof parsed.documentation_url === "string" ? parsed.documentation_url : null;
    if (message && documentationUrl) {
      return sanitizeDisplayText(`${message} (${documentationUrl})`);
    }
    if (message) return sanitizeDisplayText(message);
  } catch {
    // Fall through to a bounded plain-text snippet.
  }
  return sanitizeDisplaySnippet(text, 160);
}

async function fetchGitHubRestJson<T>(
  url: string,
  token: string,
  requestTimeoutMs?: number,
): Promise<T> {
  const response = await fetchWithTimeout(
    url,
    { headers: buildGitHubRestHeaders(token) },
    requestTimeoutMs,
  );

  if (!response.ok) {
    const message = await readGitHubRestErrorMessage(response);
    const rateLimit =
      response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0"
        ? " (GitHub API rate limit exhausted)"
        : "";
    throw new Error(`GitHub API error ${response.status}: ${message}${rateLimit}`);
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new Error("GitHub API returned malformed JSON");
  }
}

async function resolveGitHubUsername(token: string, requestTimeoutMs?: number): Promise<string> {
  const response = await fetchGitHubRestJson<GitHubViewerResponse>(
    `${GITHUB_API_BASE_URL}/user`,
    token,
    requestTimeoutMs,
  );
  const login = response.login?.trim();
  if (!login) {
    throw new Error("GitHub /user response did not include a login");
  }
  return login;
}

function buildBillingQuery(target: CopilotRequestTarget): URLSearchParams {
  const query = new URLSearchParams({
    year: String(target.billingPeriod.year),
    month: String(target.billingPeriod.month),
  });
  if (target.scope !== "user" && target.username) query.set("user", target.username);
  if (target.scope === "enterprise" && target.organization) {
    query.set("organization", target.organization);
  }
  return query;
}

function getBillingUsageUrl(
  target: CopilotRequestTarget,
  billingModel: CopilotBillingModel,
): string {
  const report = billingModel === "legacy_premium_requests" ? "premium_request" : "ai_credit";
  const query = buildBillingQuery(target);

  if (target.scope === "enterprise") {
    return `${GITHUB_API_BASE_URL}/enterprises/${encodeURIComponent(target.enterprise)}/settings/billing/${report}/usage?${query}`;
  }
  if (target.scope === "organization") {
    return `${GITHUB_API_BASE_URL}/organizations/${encodeURIComponent(target.organization)}/settings/billing/${report}/usage?${query}`;
  }
  return `${GITHUB_API_BASE_URL}/users/${encodeURIComponent(target.username)}/settings/billing/${report}/usage?${query}`;
}

async function fetchBillingUsage(params: {
  token: string;
  target: CopilotBillingTarget;
  billingModel: CopilotBillingModel;
  requestTimeoutMs?: number;
}): Promise<{ response: BillingUsageResponse; target: CopilotRequestTarget }> {
  const target: CopilotRequestTarget =
    params.target.scope === "user"
      ? {
          ...params.target,
          username:
            params.target.username ??
            (await resolveGitHubUsername(params.token, params.requestTimeoutMs)),
        }
      : params.target;

  return {
    response: await fetchGitHubRestJson<BillingUsageResponse>(
      getBillingUsageUrl(target, params.billingModel),
      params.token,
      params.requestTimeoutMs,
    ),
    target,
  };
}

function getResponsePeriod(
  response: BillingUsageResponse,
  fallback: BillingPeriodQuery,
): BillingPeriodQuery {
  const period = response.timePeriod ?? response.time_period;
  return {
    year: typeof period?.year === "number" ? period.year : fallback.year,
    month: typeof period?.month === "number" ? period.month : fallback.month,
  };
}

function getUsageItems(response: BillingUsageResponse): BillingUsageItem[] {
  if (Array.isArray(response.usageItems)) return response.usageItems;
  if (Array.isArray(response.usage_items)) return response.usage_items;
  throw new Error("GitHub billing response did not include a usageItems array");
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isAiCreditItem(item: BillingUsageItem): boolean {
  const text = [item.product, item.sku, item.unitType, item.unit_type]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return text.includes("ai credit") || text.includes("ai-credit");
}

function isPremiumRequestItem(item: BillingUsageItem): boolean {
  const text = [item.product, item.sku, item.unitType, item.unit_type]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return text.includes("premium request");
}

function parseAiCreditTotals(response: BillingUsageResponse): AiCreditTotals {
  const items = getUsageItems(response);
  const matches = items.filter(isAiCreditItem);
  if (matches.length === 0 && items.length > 0) {
    throw new Error("GitHub billing response did not contain an AI Credit usage item");
  }

  let used = 0;
  let includedUsed = 0;
  let billedUsed = 0;
  let billedAmountUsd = 0;
  let hasBilledAmount = false;

  for (const item of matches) {
    const gross = readFiniteNumber(item.grossQuantity ?? item.gross_quantity);
    const discount = readFiniteNumber(item.discountQuantity ?? item.discount_quantity);
    const net = readFiniteNumber(item.netQuantity ?? item.net_quantity);
    if (gross === undefined && discount === undefined && net === undefined) {
      throw new Error("GitHub AI Credit usage item did not include quantity fields");
    }
    const normalizedIncluded = Math.max(0, discount ?? 0);
    const normalizedBilled = Math.max(0, net ?? Math.max(0, (gross ?? 0) - normalizedIncluded));
    used += Math.max(0, gross ?? normalizedIncluded + normalizedBilled);
    includedUsed += normalizedIncluded;
    billedUsed += normalizedBilled;

    const netAmount = readFiniteNumber(item.netAmount ?? item.net_amount);
    if (netAmount !== undefined) {
      billedAmountUsd += Math.max(0, netAmount);
      hasBilledAmount = true;
    }
  }

  return {
    used,
    includedUsed,
    billedUsed,
    billedAmountUsd: hasBilledAmount ? billedAmountUsd : undefined,
  };
}

function parseLegacyPremiumRequestUsage(response: BillingUsageResponse): number {
  const items = getUsageItems(response);
  const matches = items.filter(isPremiumRequestItem);
  if (matches.length === 0 && items.length > 0) {
    throw new Error("GitHub billing response did not contain a premium-request usage item");
  }

  return matches.reduce((sum, item) => {
    const gross = readFiniteNumber(item.grossQuantity ?? item.gross_quantity);
    const net = readFiniteNumber(item.netQuantity ?? item.net_quantity);
    if (gross === undefined && net === undefined) {
      throw new Error("GitHub premium-request usage item did not include quantity fields");
    }
    return sum + Math.max(0, gross ?? net ?? 0);
  }, 0);
}

function isAiCreditBudget(budget: BillingBudget): boolean {
  const skus = [
    budget.budget_product_sku,
    ...(Array.isArray(budget.budget_product_skus) ? budget.budget_product_skus : []),
  ]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase());
  return budget.budget_type === "BundlePricing" && skus.includes("ai_credits");
}

function budgetMatchesTarget(budget: BillingBudget, target: CopilotBillingTarget): boolean {
  const scope = budget.budget_scope;
  const entity = budget.budget_entity_name?.toLowerCase();
  const user = (budget.user ?? budget.budget_entity_name)?.toLowerCase();

  if (target.scope === "organization") {
    if (target.username && scope === "user") {
      return !user || user === target.username.toLowerCase();
    }
    if (target.username && scope === "multi_user_customer") return true;
    return scope === "organization";
  }

  if (target.scope === "enterprise") {
    if (target.username && scope === "user") {
      return !user || user === target.username.toLowerCase();
    }
    if (
      target.username &&
      (scope === "multi_user_customer" || scope === "multi_user_cost_center")
    ) {
      return true;
    }
    if (target.organization && scope === "organization") {
      return !entity || entity === target.organization.toLowerCase();
    }
    return scope === "enterprise";
  }

  return false;
}

function budgetSpecificity(budget: BillingBudget): number {
  switch (budget.budget_scope) {
    case "user":
      return 5;
    case "multi_user_cost_center":
      return 4;
    case "multi_user_customer":
      return 3;
    case "organization":
      return 2;
    case "enterprise":
      return 1;
    default:
      return 0;
  }
}

function getBudgetsUrl(
  target: OrganizationBillingTarget | EnterpriseBillingTarget,
  page: number,
): string {
  const base =
    target.scope === "organization"
      ? `${GITHUB_API_BASE_URL}/organizations/${encodeURIComponent(target.organization)}/settings/billing/budgets`
      : `${GITHUB_API_BASE_URL}/enterprises/${encodeURIComponent(target.enterprise)}/settings/billing/budgets`;
  const query = new URLSearchParams({ page: String(page), per_page: "100" });
  if (target.username) query.set("user", target.username);
  return `${base}?${query}`;
}

async function fetchApplicableBudget(params: {
  token: string;
  target: OrganizationBillingTarget | EnterpriseBillingTarget;
  spentUsd?: number;
  requestTimeoutMs?: number;
}): Promise<CopilotBudgetResult | undefined> {
  const budgets: BillingBudget[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const response = await fetchGitHubRestJson<BillingBudgetsResponse>(
      getBudgetsUrl(params.target, page),
      params.token,
      params.requestTimeoutMs,
    );
    if (!Array.isArray(response.budgets)) {
      throw new Error("GitHub budgets response did not include a budgets array");
    }
    budgets.push(...response.budgets);
    if (!response.has_next_page) break;
    if (page === 100) {
      throw new Error("GitHub budgets response exceeded 100 pages");
    }
  }

  const selected = budgets
    .filter(
      (budget) =>
        isAiCreditBudget(budget) &&
        budgetMatchesTarget(budget, params.target) &&
        typeof budget.budget_amount === "number" &&
        Number.isFinite(budget.budget_amount) &&
        budget.budget_amount >= 0,
    )
    .sort((a, b) => budgetSpecificity(b) - budgetSpecificity(a))[0];

  if (!selected || selected.budget_amount === undefined) return undefined;

  const percentRemaining =
    params.spentUsd === undefined
      ? undefined
      : computePercentRemainingFromUsed(params.spentUsd, selected.budget_amount);

  return {
    amountUsd: selected.budget_amount,
    spentUsd: params.spentUsd,
    scope: selected.budget_scope ?? "unknown",
    percentRemaining,
  };
}

function makeBudgetWarning(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `AI Credit usage loaded, but the budget report failed: ${message}`;
}

async function toAiCreditResult(params: {
  response: BillingUsageResponse;
  target: CopilotRequestTarget;
  config: CopilotQuotaConfig;
  token: string;
  requestTimeoutMs?: number;
}): Promise<CopilotQuotaResult | CopilotOrganizationUsageResult | CopilotEnterpriseUsageResult> {
  const totals = parseAiCreditTotals(params.response);
  const resetTimeIso = getApproxNextResetIso();
  const period = getResponsePeriod(params.response, params.target.billingPeriod);
  let budget: CopilotBudgetResult | undefined;
  const warnings: string[] = [];

  if (params.target.scope !== "user") {
    try {
      budget = await fetchApplicableBudget({
        token: params.token,
        target: params.target,
        spentUsd: totals.billedAmountUsd,
        requestTimeoutMs: params.requestTimeoutMs,
      });
    } catch (error) {
      warnings.push(makeBudgetWarning(error));
    }
  }

  if (params.target.scope === "organization") {
    return {
      success: true,
      mode: "organization_usage",
      organization: params.target.organization,
      username: params.target.username,
      period,
      unit: "ai_credits",
      ...totals,
      budget,
      warnings: warnings.length ? warnings : undefined,
      resetTimeIso,
    };
  }

  if (params.target.scope === "enterprise") {
    return {
      success: true,
      mode: "enterprise_usage",
      enterprise: params.target.enterprise,
      organization: params.target.organization,
      username: params.target.username,
      period,
      unit: "ai_credits",
      ...totals,
      budget,
      warnings: warnings.length ? warnings : undefined,
      resetTimeIso,
    };
  }

  const total = PERSONAL_AI_CREDIT_TOTALS[params.config.tier];
  return {
    success: true,
    mode: "user_quota",
    unit: "ai_credits",
    ...totals,
    total,
    percentRemaining: total ? computePercentRemainingFromUsed(totals.used, total) : undefined,
    plan: params.config.tier,
    resetTimeIso,
  };
}

function toLegacyResult(
  response: BillingUsageResponse,
  config: CopilotQuotaConfig,
): CopilotQuotaResult {
  const used = parseLegacyPremiumRequestUsage(response);
  const total = LEGACY_PREMIUM_REQUEST_TOTALS[config.tier];
  return {
    success: true,
    mode: "user_quota",
    unit: "premium_requests",
    used,
    total,
    percentRemaining: total ? computePercentRemainingFromUsed(used, total) : undefined,
    plan: config.tier,
    resetTimeIso: getApproxNextResetIso(),
  };
}

function toQuotaError(message: string): QuotaError {
  return { success: false, error: message };
}

/**
 * Query GitHub Copilot accounting.
 *
 * A valid local billing token config is required. OpenCode OAuth remains
 * visible in diagnostics but is not sent to GitHub's public billing API
 * because its billing permissions are not part of the documented contract.
 */
export async function queryCopilotQuota(
  options: { requestTimeoutMs?: number } = {},
): Promise<CopilotResult> {
  const pat = readQuotaConfigWithMeta();

  if (pat.state === "invalid") {
    return toQuotaError(
      `Invalid copilot-quota-token.json: ${pat.error ?? "unknown error"}${pat.selectedPath ? ` (${pat.selectedPath})` : ""}`,
    );
  }
  if (pat.state === "absent" || !pat.config) {
    return null;
  }

  const resolved = resolvePatBillingTarget(pat.config);
  if (!resolved.target) {
    return toQuotaError(resolved.error ?? "Unable to resolve Copilot billing scope.");
  }

  const compatibilityError = validatePatTargetCompatibility(resolved.target, pat.tokenKind);
  if (compatibilityError) return toQuotaError(compatibilityError);

  try {
    const billingModel = pat.config.billingModel ?? "ai_credits";
    const { response, target } = await fetchBillingUsage({
      token: pat.config.token,
      target: resolved.target,
      billingModel,
      requestTimeoutMs: options.requestTimeoutMs,
    });

    return billingModel === "legacy_premium_requests"
      ? toLegacyResult(response, pat.config)
      : await toAiCreditResult({
          response,
          target,
          config: pat.config,
          token: pat.config.token,
          requestTimeoutMs: options.requestTimeoutMs,
        });
  } catch (error) {
    return toQuotaError(error instanceof Error ? error.message : String(error));
  }
}

export async function hasCopilotQuotaRuntimeAvailable(): Promise<boolean> {
  const diagnostics = getCopilotQuotaAuthDiagnostics(await readAuthFile());
  return diagnostics.billingApiAccessLikely;
}

export function formatCopilotQuota(result: CopilotResult): string | null {
  if (!result || !result.success) return null;

  const unit = result.unit === "ai_credits" ? "AI Credits" : "Premium Requests";
  if (result.mode === "organization_usage") {
    return `Copilot Org (${result.organization}) ${result.used} ${unit} | ${formatBillingPeriod(result.period)}`;
  }
  if (result.mode === "enterprise_usage") {
    return `Copilot Enterprise (${result.enterprise}) ${result.used} ${unit} | ${formatBillingPeriod(result.period)}`;
  }
  if (result.unlimited) return `Copilot ${unit} Unlimited`;
  if (result.total !== undefined) {
    return `Copilot ${unit} ${result.used}/${result.total}`;
  }
  return `Copilot ${unit} ${result.used} used`;
}
