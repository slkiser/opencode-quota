import type { ResolvedAuthIdentity } from "./resolved-auth-identity.js";
import type { CursorQuotaPlan, OpenCodeGoWindowKey } from "./types.js";
import type { AccountingDocument } from "./accounting.js";

/**
 * Normalized quota output model.
 *
 * Providers should map their internal quota shapes into these types so that
 * formatting and toast display stays universal across providers.
 */

export interface GroupedQuotaEntryMeta {
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
       * Note: kind is optional for backwards compatibility.
       */
      kind?: "percent";

      /** Display label (already human-friendly), e.g. "Copilot" or "Claude (abc..gmail)". */
      name: string;

      /** Remaining quota as a percentage (may be below 0 when over quota). */
      percentRemaining: number;

      /** Optional ISO reset timestamp (shown when percentRemaining is < 100). */
      resetTimeIso?: string;
    })
  | (GroupedQuotaEntryMeta & {
      /** Value-based entry (no percent bar). */
      kind: "value";

      /** Display label (already human-friendly), e.g. "OpenCode Go". */
      name: string;

      /** Human-readable value, e.g. "$42.50". */
      value: string;

      /** Optional ISO reset timestamp (shown when available). */
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

export interface QuotaObservation {
  /** Random observation ID; never an account or credential identifier. */
  id: string;
  observedAt: number;
}

export interface QuotaProviderResult {
  /** Additive internal facts; legacy entries and stable exports retain their existing shape. */
  accounting?: AccountingDocument;
  /** Assigned by the shared fetch pipeline, retained through cache reads. */
  observation?: QuotaObservation;
  /** True when provider had enough configuration to attempt a query. */
  attempted: boolean;
  entries: QuotaToastEntry[];
  errors: QuotaToastError[];
  presentation?: QuotaProviderPresentation;
}

export interface QuotaProviderMatchContext {
  enabledProviders: string[] | "auto";
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
    alibabaCodingPlanTier: "lite" | "pro";
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
    /**
     * Set on an explicit user-triggered refresh. Providers with their own
     * internal caching layer (beyond the generic per-provider result cache in
     * quota-state.ts) should use this to force a fresh probe - e.g. Anthropic
     * re-checking Claude CLI auth status right after `claude auth login`
     * instead of waiting out its own cache or requiring an app relaunch.
     */
    bypassCache?: boolean;
  };
}

export type QuotaProviderCachePolicy =
  | { kind: "account-neutral" }
  | { kind: "uncached" }
  | {
      kind: "resolved-auth";
      /** Prepare identity and fetching from the same selected credential snapshot. */
      prepare: (ctx: QuotaProviderContext) => Promise<{
        identity: ResolvedAuthIdentity;
        fetch: () => Promise<QuotaProviderResult>;
      } | null>;
    };

export interface QuotaProvider {
  /** Stable id used by config.enabledProviders */
  id: string;

  /** Best-effort availability check (no network if possible) */
  isAvailable: (ctx: QuotaProviderContext) => Promise<boolean>;

  /** Fetch and normalize quota for this provider */
  fetch: (ctx: QuotaProviderContext) => Promise<QuotaProviderResult>;

  /** Missing policy fails closed as uncached. */
  cachePolicy?: QuotaProviderCachePolicy;

  /** Optional provider match for onlyCurrentModel filtering */
  matchesCurrentModel?: (model: string, context?: QuotaProviderMatchContext) => boolean;
}
