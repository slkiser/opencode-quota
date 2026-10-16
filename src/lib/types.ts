/**
 * The legacy provider data types: logins read from OpenCode and each provider's fetch result.
 */

export type GeminiCliAuthSourceKey =
  | "google-gemini-cli"
  | "gemini-cli"
  | "opencode-gemini-auth"
  | "gemini"
  | "google";
export type GoogleAgyAuthSourceKey = "google-agy" | "opencode-agy-auth" | "google-agy-auth";

// =============================================================================
// Auth Data Types (from ~/.local/share/opencode/opencode.db)
// =============================================================================

/** GitHub Copilot authentication data */
export interface CopilotAuthData {
  type: string;
  refresh?: string;
  access?: string;
  expires?: number;
  /** OpenCode-managed GitHub Enterprise Cloud hostname for this OAuth credential. */
  enterpriseUrl?: string;
  /** Set when OpenCode could not return this login; see `CredentialRow.resolveError`. */
  resolveError?: string;
}

export type AlibabaCodingPlanTier = "lite" | "pro";

/** An OAuth login as OpenCode stores it; providers read the fields they know. */
interface OAuthAuthData {
  type: string;
  access?: string;
  refresh?: string;
  expires?: number;
  /** Set when OpenCode could not return this login; see `CredentialRow.resolveError`. */
  resolveError?: string;
  [key: string]: unknown;
}

interface GeminiCliOAuthAuthData extends OAuthAuthData {
  projectId?: string;
  /** Legacy spelling used by some companion/runtime variants */
  projectID?: string;
  managedProjectId?: string;
  quotaProjectId?: string;
  email?: string;
  accountEmail?: string;
  login?: string;
}

/**
 * Copilot subscription tier.
 * See: https://docs.github.com/en/copilot/get-started/plans
 */
export type CopilotTier = "free" | "student" | "pro" | "pro+" | "max" | "business" | "enterprise";

export type CopilotBillingModel = "ai_credits" | "legacy_premium_requests";

/**
 * Copilot quota token configuration.
 *
 * Stored locally in:
 * - OpenCode runtime config candidate directories as
 *   `.../opencode/copilot-quota-token.json`
 *   (for example `$XDG_CONFIG_HOME/opencode` or `~/.config/opencode`)
 *
 * Credential type and permission depend on whether GitHub bills the
 * personal account, organization, or enterprise.
 */
export interface CopilotQuotaConfig {
  /** GitHub token with the billing-report permission required by the selected scope. */
  token: string;
  /** Current AI Credits by default; legacy PRUs are limited to eligible Pro/Pro+ annual plans. */
  billingModel?: CopilotBillingModel;
  /** Optional user login override for user-scoped reports or org user filtering */
  username?: string;
  /**
   * Optional organization slug.
   *
   * In business mode, this selects
   * `/organizations/{org}/settings/billing/ai_credit/usage`.
   *
   * In enterprise mode with an explicit `enterprise` slug, this becomes the
   * optional `organization` query filter on the enterprise usage report.
   */
  organization?: string;
  /**
   * Optional enterprise slug for enterprise-scoped AI Credit reports.
   *
   * When present, the plugin queries
   * `/enterprises/{enterprise}/settings/billing/ai_credit/usage`.
   */
  enterprise?: string;
  /** Optional GitHub Enterprise Cloud hostname or host-only HTTPS URL for this token. */
  enterpriseUrl?: string;
  /** Copilot subscription tier and billing scope. */
  tier: CopilotTier;
}

/** Full opencode.db structure (partial - only what we need) */
export interface AuthData {
  anthropic?: OAuthAuthData;
  "github-copilot"?: CopilotAuthData;
  copilot?: CopilotAuthData;
  "copilot-chat"?: CopilotAuthData;
  "github-copilot-chat"?: CopilotAuthData;
  // Provider id used by opencode-gemini-auth.
  google?: GeminiCliOAuthAuthData;
  // Canonical and compatibility keys for Gemini CLI auth snapshots.
  "google-gemini-cli"?: GeminiCliOAuthAuthData;
  "gemini-cli"?: GeminiCliOAuthAuthData;
  "opencode-gemini-auth"?: GeminiCliOAuthAuthData;
  gemini?: GeminiCliOAuthAuthData;
  "google-agy"?: GeminiCliOAuthAuthData;
  "opencode-agy-auth"?: GeminiCliOAuthAuthData;
  "google-agy-auth"?: GeminiCliOAuthAuthData;
  openai?: OAuthAuthData & { accountId?: string };
  // Some OpenCode installs store ChatGPT auth under "codex".
  codex?: OAuthAuthData & { accountId?: string };
  // Some OpenCode installs store ChatGPT auth under "chatgpt".
  chatgpt?: OAuthAuthData & { accountId?: string };
  cursor?: OAuthAuthData & { key?: string };
  xai?: OAuthAuthData;
}

// =============================================================================
// Quota Result Types
// =============================================================================

type CopilotResultAuthority = "provider_reported" | "locally_derived";

export interface CopilotBudgetResult {
  amountUsd: number;
  spentUsd?: number;
  scope: string;
  percentRemaining?: number;
  authority: CopilotResultAuthority;
}

/** Result from fetching per-user Copilot accounting. */
export interface CopilotQuotaResult {
  success: true;
  mode: "user_quota";
  unit: "ai_credits" | "premium_interactions" | "premium_requests";
  used: number;
  authority: CopilotResultAuthority;
  period?: {
    year: number;
    month: number;
  };
  total?: number;
  percentRemaining?: number;
  includedUsed?: number;
  billedUsed?: number;
  billedAmountUsd?: number;
  budget?: CopilotBudgetResult;
  plan?: string;
  unlimited?: boolean;
  warnings?: string[];
  resetTimeIso?: string;
}

/** Plan-only result when Copilot returns token-billing placeholder quota data. */
export interface CopilotPlanResult {
  success: true;
  mode: "user_plan";
  authority: CopilotResultAuthority;
  plan?: string;
  resetTimeIso?: string;
}

/** Result from fetching organization-scoped Copilot AI Credit usage. */
export interface CopilotOrganizationUsageResult {
  success: true;
  mode: "organization_usage";
  organization: string;
  username?: string;
  period: {
    year: number;
    month: number;
  };
  unit: "ai_credits";
  used: number;
  authority: CopilotResultAuthority;
  includedUsed: number;
  billedUsed: number;
  billedAmountUsd?: number;
  budget?: CopilotBudgetResult;
  warnings?: string[];
  resetTimeIso?: string;
}

/** Result from fetching enterprise-scoped Copilot AI Credit usage. */
export interface CopilotEnterpriseUsageResult {
  success: true;
  mode: "enterprise_usage";
  enterprise: string;
  organization?: string;
  username?: string;
  period: {
    year: number;
    month: number;
  };
  unit: "ai_credits";
  used: number;
  authority: CopilotResultAuthority;
  includedUsed: number;
  billedUsed: number;
  billedAmountUsd?: number;
  budget?: CopilotBudgetResult;
  warnings?: string[];
  resetTimeIso?: string;
}

export interface GeminiCliQuotaBucket {
  modelId: string;
  displayName: string;
  percentRemaining: number;
  resetTimeIso?: string;
  remainingAmount?: string;
  tokenType?: string;
  accountEmail?: string;
  sourceKey?: GeminiCliAuthSourceKey;
}

export interface GoogleAgyQuotaSummaryBucket {
  bucketId?: string;
  displayName?: string;
  description?: string;
  window?: string;
  remaining?: string;
  remainingFraction?: number;
  remainingAmount?: string;
  disabled?: boolean;
  resetTime?: string;
}

interface GoogleAgyQuotaSummaryGroup {
  displayName?: string;
  description?: string;
  buckets?: GoogleAgyQuotaSummaryBucket[];
}

export interface GoogleAgyQuotaSummaryResponse {
  groups?: GoogleAgyQuotaSummaryGroup[];
  buckets?: GoogleAgyQuotaSummaryBucket[];
  description?: string;
}

export interface GoogleAgyQuotaBucket {
  family: string;
  window: "weekly" | "five_hour";
  windowLabel: "Weekly" | "5h";
  bucketId?: string;
  bucketLabel?: string;
  remainingFraction: number;
  percentRemaining: number;
  resetTimeIso?: string;
  remainingAmount?: string;
  accountEmail?: string;
  sourceKey: GoogleAgyAuthSourceKey;
}

/** Error result */
export interface QuotaError {
  success: false;
  error: string;
}

/** Combined quota result */
export type CopilotResult =
  | CopilotQuotaResult
  | CopilotPlanResult
  | CopilotOrganizationUsageResult
  | CopilotEnterpriseUsageResult
  | QuotaError
  | null;

export type OpenCodeGoWindowKey = "rolling" | "weekly" | "monthly";

/** Single normalized usage window from the OpenCode Go API. */
export interface OpenCodeGoWindow {
  /** Raw API status after exact validation. */
  status: "ok" | "rate-limited";
  /** Usage percentage [0..100]. */
  usagePercent: number;
  /** Remaining percentage [0..100]. */
  percentRemaining: number;
  /** Canonical ISO reset timestamp. */
  resetTimeIso: string;
}

/** Strictly validated result from the OpenCode Go usage API. */
export type OpenCodeGoResult =
  | {
      success: true;
      rolling: OpenCodeGoWindow;
      weekly: OpenCodeGoWindow;
      monthly: OpenCodeGoWindow;
    }
  | (QuotaError & { notSubscribed?: true });
