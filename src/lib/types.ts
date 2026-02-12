/**
 * Type definitions for opencode-quota plugin
 */

// =============================================================================
// Configuration Types
// =============================================================================

/** Google model identifiers */
export type GoogleModelId = "G3PRO" | "G3FLASH" | "CLAUDE" | "G3IMAGE";

/** Plugin configuration from opencode.json experimental.quotaToast */
export interface QuotaToastConfig {
  enabled: boolean;

  /** If false, never show popup toasts (commands/tools still work). */
  enableToast: boolean;

  /** Toast formatting style. */
  toastStyle: "classic" | "grouped";
  minIntervalMs: number;

  /**
   * Debug mode for troubleshooting.
   *
   * When enabled, the plugin appends a short debug footer to the toast.
   * If the plugin would normally show no toast (e.g. enabledProviders empty),
   * it will show a debug-only toast explaining why.
   */
  debug: boolean;

  /**
   * Provider ids to query.
   *
   * Keep this list short and user-friendly; each provider advertises a stable id.
   * Example: ["copilot", "google-antigravity"].
   *
   * When set to "auto" (or left unconfigured), the plugin will auto-enable
   * all providers whose `isAvailable()` returns true at runtime.
   */
  enabledProviders: string[] | "auto";

  googleModels: GoogleModelId[];
  showOnIdle: boolean;
  showOnQuestion: boolean;
  showOnCompact: boolean;
  showOnBothFail: boolean;
  /** Toast duration in milliseconds */
  toastDurationMs: number;

  /** If true, only show quota for current model */
  onlyCurrentModel: boolean;

  /** If true, show per-model input/output token counts for current session */
  showSessionTokens: boolean;

  /** Responsive layout breakpoints */
  layout: {
    /** Default max width target for formatting */
    maxWidth: number;
    /** If toast max width is <= this, use compact layout */
    narrowAt: number;
    /** If toast max width is <= this, use ultra-compact layout */
    tinyAt: number;
  };
}

/** Default configuration values */
export const DEFAULT_CONFIG: QuotaToastConfig = {
  enabled: true,

  enableToast: true,
  toastStyle: "classic",
  minIntervalMs: 300000, // 5 minutes

  debug: false,

  // Providers are auto-detected by default; set to explicit list to opt-in manually.
  enabledProviders: "auto" as const,

  // If Google Antigravity is enabled, default to Claude only.
  googleModels: ["CLAUDE"],

  showOnIdle: true,
  showOnQuestion: true,
  showOnCompact: true,
  showOnBothFail: true,
  toastDurationMs: 9000,
  onlyCurrentModel: false,
  showSessionTokens: true,
  layout: {
    maxWidth: 50,
    narrowAt: 42,
    tinyAt: 32,
  },
};

// =============================================================================
// Auth Data Types (from ~/.local/share/opencode/auth.json)
// =============================================================================

/** GitHub Copilot authentication data */
export interface CopilotAuthData {
  type: string;
  refresh?: string;
  access?: string;
  expires?: number;
}

/**
 * Copilot subscription tier.
 * See: https://docs.github.com/en/copilot/about-github-copilot/subscription-plans-for-github-copilot
 */
export type CopilotTier = "free" | "pro" | "pro+" | "business" | "enterprise";

/**
 * Copilot quota token configuration.
 *
 * Stored locally in:
 * - $XDG_CONFIG_HOME/opencode/copilot-quota-token.json, or
 * - ~/.config/opencode/copilot-quota-token.json
 *
 * Users can create a fine-grained PAT with "Plan" read permission
 * to enable quota checking via GitHub's public billing API.
 */
export interface CopilotQuotaConfig {
  /** Fine-grained PAT with "Plan" read permission */
  token: string;
  /** GitHub username (for API calls) */
  username: string;
  /** Copilot subscription tier (determines monthly quota limit) */
  tier: CopilotTier;
}

/** Full auth.json structure (partial - only what we need) */
export interface AuthData {
  "github-copilot"?: CopilotAuthData;
  google?: {
    type: string;
    access?: string;
    refresh?: string;
    expires?: number;
  };
  openai?: {
    type: string;
    access?: string;
    refresh?: string;
    expires?: number;
  };
  // Some OpenCode installs store ChatGPT auth under "codex".
  codex?: {
    type: string;
    access?: string;
    refresh?: string;
    expires?: number;
    accountId?: string;
  };
  firmware?: {
    type: string;
    key?: string;
  };
  chutes?: {
    type: string;
    key?: string;
  };
}

// =============================================================================
// Antigravity Account Types (from ~/.config/opencode/antigravity-accounts.json)
// =============================================================================

/** Single Antigravity account from opencode-antigravity-auth storage */
export interface AntigravityAccount {
  email?: string;
  refreshToken: string;
  projectId?: string;
  /** Legacy spelling used by some plugin versions */
  projectID?: string;
  managedProjectId?: string;
  addedAt: number;
  lastUsed: number;
  rateLimitResetTimes?: Record<string, number>;
}

/** Antigravity accounts file structure */
export interface AntigravityAccountsFile {
  version: number;
  accounts: AntigravityAccount[];
  activeIndex?: number;
  activeIndexByFamily?: {
    claude?: number;
    gemini?: number;
  };
}

// =============================================================================
// Google Antigravity Types
// =============================================================================

/** Google quota API response */
export interface GoogleQuotaResponse {
  models: Record<
    string,
    {
      quotaInfo?: {
        remainingFraction?: number;
        resetTime?: string;
      };
    }
  >;
}

/** Copilot API response includes a quota reset date */
export interface CopilotQuotaResponseWithReset extends CopilotUsageResponse {
  quota_reset_date: string;
}

// =============================================================================
// Copilot API Types
// =============================================================================

interface QuotaDetail {
  entitlement: number;
  overage_count: number;
  overage_permitted: boolean;
  percent_remaining: number;
  quota_id: string;
  quota_remaining: number;
  remaining: number;
  unlimited: boolean;
}

interface QuotaSnapshots {
  chat?: QuotaDetail;
  completions?: QuotaDetail;
  premium_interactions: QuotaDetail;
}

export interface CopilotUsageResponse {
  access_type_sku: string;
  analytics_tracking_id: string;
  assigned_date: string;
  can_signup_for_limited: boolean;
  chat_enabled: boolean;
  copilot_plan: string;
  organization_login_list: unknown[];
  organization_list: unknown[];
  quota_reset_date: string;
  quota_snapshots: QuotaSnapshots;
}

// =============================================================================
// Quota Result Types
// =============================================================================

/** Result from fetching Copilot quota */
export interface CopilotQuotaResult {
  success: true;
  used: number;
  total: number;
  percentRemaining: number;
  resetTimeIso?: string;
}

/** Result from fetching Google quota for a single model */
export interface GoogleModelQuota {
  modelId: GoogleModelId;
  displayName: string;
  percentRemaining: number;
  resetTimeIso?: string;
  accountEmail?: string;
}

/** Error for a single account */
export interface GoogleAccountError {
  email: string;
  error: string;
}

/** Result from fetching Google quota */
export interface GoogleQuotaResult {
  success: true;
  models: GoogleModelQuota[];
  errors?: GoogleAccountError[];
}

/** Error result */
export interface QuotaError {
  success: false;
  error: string;
}

/** Combined quota result */
export type CopilotResult = CopilotQuotaResult | QuotaError | null;
export type GoogleResult = GoogleQuotaResult | QuotaError | null;
export type ChutesResult =
  | {
      success: true;
      percentRemaining: number;
      resetTimeIso?: string;
    }
  | QuotaError
  | null;

/** Cached toast data */
export interface CachedToast {
  message: string;
  timestamp: number;
}

// =============================================================================
// Constants
// =============================================================================

/** Request timeout in milliseconds */
export const REQUEST_TIMEOUT_MS = 3000;

/** Model key mapping for Google API */
export const GOOGLE_MODEL_KEYS: Record<
  GoogleModelId,
  { key: string; altKey?: string; display: string }
> = {
  G3PRO: { key: "gemini-3-pro-high", altKey: "gemini-3-pro-low", display: "G3Pro" },
  G3FLASH: { key: "gemini-3-flash", display: "G3Flash" },
  CLAUDE: { key: "claude-opus-4-5-thinking", altKey: "claude-opus-4-5", display: "Claude" },
  G3IMAGE: { key: "gemini-3-pro-image", display: "G3Image" },
};
