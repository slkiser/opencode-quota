import type { CursorQuotaPlan, OpenCodeGoWindowKey } from "./types.js";
import type { QuotaProviderDefinition } from "./quota-providers.js";

/**
 * Normalized quota output model.
 *
 * Providers should map their internal quota shapes into these types so that
 * formatting and toast display stays universal across providers.
 */

export type AccountingResultType =
  | "quota"
  | "rate_limit"
  | "usage"
  | "spend"
  | "budget"
  | "balance"
  | "status";

export type AccountingAcquisitionMethod =
  | "remote_api"
  | "dashboard_scrape"
  | "local_cli"
  | "local_runtime_accounting"
  | "local_estimation";

export type AccountingOwnership = "maintained" | "user_configured";

export type AccountingAuthority = "provider_reported" | "locally_derived";

export interface AccountingMetadata {
  /** What the row represents, independent of its percent/value render shape. */
  resultType: AccountingResultType;
  /** How the accounting value was acquired. */
  acquisitionMethod: AccountingAcquisitionMethod;
  /** Whether opencode-quota or the user owns the source definition. */
  ownership: AccountingOwnership;
  /** Whether the value came from the provider or was derived locally. */
  authority: AccountingAuthority;
  /** Stable configured source identity when one aggregate provider owns multiple sources. */
  sourceId?: string;
  /** Source observation time only; never application fetch or cache time. */
  observedAtIso?: string;
}

export interface GroupedQuotaEntryMeta {
  /** Required provider-neutral accounting semantics for this row. */
  accounting: AccountingMetadata;
  /** Optional provider/account group header for grouped toast and /quota output. */
  group?: string;
  /** Optional row label inside the group, e.g. "5h:" or "Usage:". */
  label?: string;
  /** Optional compact right-hand summary, e.g. "42/300". */
  right?: string;
}

export type QuotaToastEntry =
  | (GroupedQuotaEntryMeta & {
      /**
       * Percent-based entry (default).
       * The optional discriminant preserves the existing percent-entry shape.
       */
      kind?: "percent";

      /** Display label (already human-friendly), e.g. "Copilot" or "Claude (abc..gmail)". */
      name: string;

      /** Remaining quota as a percentage (may be below 0 when over quota). */
      percentRemaining: number;

      /** Optional source-backed ISO reset timestamp (shown when percentRemaining is < 100). */
      resetTimeIso?: string;
    })
  | (GroupedQuotaEntryMeta & {
      /** Value-based entry (no percent bar). */
      kind: "value";

      /** Display label (already human-friendly), e.g. "OpenCode Go". */
      name: string;

      /** Human-readable value, e.g. "$42.50". */
      value: string;

      /** Optional source-backed ISO reset timestamp (shown when available). */
      resetTimeIso?: string;
    });

export function isValueEntry(e: QuotaToastEntry): e is Extract<QuotaToastEntry, { kind: "value" }> {
  return e.kind === "value";
}

export function isPercentEntry(
  e: QuotaToastEntry,
): e is Extract<QuotaToastEntry, { percentRemaining: number }> {
  return !isValueEntry(e);
}

export interface QuotaToastError {
  /** Short label that will be rendered as "label: message". */
  label: string;
  message: string;
}

/** Per-model token summary for current session (toast display). */
export interface SessionTokenModel {
  modelID: string;
  input: number;
  cachedInput?: number;
  totalInput?: number;
  output: number;
}

/** Session tokens data for toast display. */
export interface SessionTokensData {
  models: SessionTokenModel[];
  totalInput: number;
  totalCachedInput?: number;
  totalCombinedInput?: number;
  totalOutput: number;
}

export interface QuotaProviderPresentation {
  singleWindowDisplayName?: string;
  singleWindowShowRight?: boolean;
  /**
   * When set to "preserve", the provider's entries are kept individually
   * (one per window) even in single-window format styles.
   */
  classicStrategy?: "preserve";
}

export interface QuotaProviderDiagnostic {
  sourceId: string;
  providerId: string;
  mode: QuotaProviderDefinition["mode"];
  format?: "accounting-v1" | "openrouter-key-v1";
  /** Null means the source covers every model for providerId. */
  modelIds: string[] | null;
  /** Explicit environment-variable name only; never its value. */
  apiKeyEnv: string | null;
  selected: true;
  attempted: boolean;
  credentialSource:
    | "explicit_env"
    | "global_opencode_json"
    | "global_opencode_jsonc"
    | "auth_json"
    | null;
  outcome:
    | "missing_credential"
    | "success"
    | "http_error"
    | "redirect_error"
    | "timeout"
    | "body_too_large"
    | "invalid_content_type"
    | "invalid_json"
    | "invalid_response"
    | "network_error"
    | "local_state_error";
  httpStatus?: number;
  entryCount: number;
  checkedPaths: string[];
  authPaths: string[];
  statePath?: string;
  stateHealth?: "missing" | "healthy" | "malformed" | "version_mismatch";
  stateVersion?: number | null;
  stateLastUpdatedAt?: number | null;
}

export interface QuotaProviderResult {
  /** True when provider had enough configuration to attempt a query. */
  attempted: boolean;
  entries: QuotaToastEntry[];
  errors: QuotaToastError[];
  /** Internal provider diagnostics; not projected into normal presentation/export surfaces. */
  diagnostics?: QuotaProviderDiagnostic[];
  presentation?: QuotaProviderPresentation;
}

export interface QuotaProviderMatchContext {
  enabledProviders: string[] | "auto";
  quotaProviders?: QuotaProviderDefinition[];
  currentProviderID?: string;
}

export interface QuotaProviderContext {
  client: {
    config: {
      providers: () => Promise<{ data?: { providers: Array<{ id: string }> } }>;
      get: () => Promise<{ data?: { model?: string } }>;
    };
  };
  config: {
    googleModels: string[];
    anthropicBinaryPath?: string;
    cursorPlan: CursorQuotaPlan;
    cursorIncludedApiUsd?: number;
    cursorBillingCycleStartDay?: number;
    opencodeGoWindows?: OpenCodeGoWindowKey[];
    requestTimeoutMs?: number;
    /** True when requestTimeoutMs came from user config rather than DEFAULT_CONFIG. */
    requestTimeoutMsConfigured?: boolean;
    onlyCurrentModel?: boolean;
    currentModel?: string;
    currentProviderID?: string;
    enabledProviders: string[] | "auto";
    quotaProviders?: QuotaProviderDefinition[];
  };
}

export interface QuotaProvider {
  /** Stable id used by config.enabledProviders */
  id: string;

  /** Best-effort availability check (no network if possible) */
  isAvailable: (ctx: QuotaProviderContext) => Promise<boolean>;

  /** Fetch and normalize quota for this provider */
  fetch: (ctx: QuotaProviderContext) => Promise<QuotaProviderResult>;

  /** Optional provider match for onlyCurrentModel filtering */
  matchesCurrentModel?: (model: string, context?: QuotaProviderMatchContext) => boolean;
}
