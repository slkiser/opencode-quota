/**
 * Normalized quota output model.
 *
 * Providers should map their internal quota shapes into these types so that
 * formatting and toast display stays universal across providers.
 */

export type QuotaToastEntry =
  | {
      /**
       * Percent-based entry (default).
       * Note: kind is optional for backwards compatibility.
       */
      kind?: "percent";

      /** Display label (already human-friendly), e.g. "Copilot" or "Claude (abc..gmail)". */
      name: string;

      /** Remaining quota as a percentage [0..100]. */
      percentRemaining: number;

      /** Optional ISO reset timestamp (shown when percentRemaining is < 100). */
      resetTimeIso?: string;
    }
  | {
      /** Value-based entry (no percent bar). */
      kind: "value";

      /** Display label (already human-friendly), e.g. "Firmware". */
      name: string;

      /** Human-readable value, e.g. "$42.50". */
      value: string;

      /** Optional ISO reset timestamp (shown when available). */
      resetTimeIso?: string;
    };

export function isValueEntry(
  e: QuotaToastEntry,
): e is Extract<QuotaToastEntry, { kind: "value" }> {
  return (e as any).kind === "value";
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
  output: number;
}

/** Session tokens data for toast display. */
export interface SessionTokensData {
  models: SessionTokenModel[];
  totalInput: number;
  totalOutput: number;
}

export interface QuotaProviderResult {
  /** True when provider had enough configuration to attempt a query. */
  attempted: boolean;
  entries: QuotaToastEntry[];
  errors: QuotaToastError[];
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
    toastStyle?: "classic" | "grouped";
    onlyCurrentModel?: boolean;
    currentModel?: string;
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
  matchesCurrentModel?: (model: string) => boolean;
}
