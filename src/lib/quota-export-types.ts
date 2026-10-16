import type { RowAuthority, RowMethod, RowType } from "../core/types.js";

/**
 * Export types for external tool consumption.
 *
 * These types define the schema for the periodic JSON export file
 * written when the `system.exportFile` setting is on, and for the
 * `show --json` CLI output.
 */

interface QuotaExportEntryBase {
  /**
   * The row id, `${providerId}.${key}`, e.g. "copilot.allowance" or
   * "quota-providers.custom.<definition id>.<key>". It never changes for a row; the rows of
   * two accounts of one provider share it, and `account` tells them apart.
   */
  id: string;
  /** Provider label, account and row label, e.g. "Copilot (pro) Premium requests". */
  name: string;
  /** The row's account as the TUI shows it, e.g. "pro"; logins sharing one are "pro", "pro 2". */
  account?: string;
  /** What the number means (ADR 0001). */
  resultType: RowType;
  /** How the value was acquired (ADR 0001). */
  acquisitionMethod: RowMethod;
  /** Whether the source definition is maintained or user-configured. */
  ownership: "maintained" | "user_configured";
  /** Whether the value was provider-reported or locally derived. */
  authority: RowAuthority;
  /**
   * Normalized window label when the entry has one: "Monthly", "Weekly", "5h", "RPM", etc.
   * Absent when there is only one window for the provider.
   */
  window?: string;
  /** Unix seconds of the next source-backed reset. */
  resetAt?: number;
}

/** One row in the version 3 export document. */
export type QuotaExportEntry =
  | (QuotaExportEntryBase & {
      renderType: "percent";
      percentRemaining: number;
    })
  | (QuotaExportEntryBase & {
      renderType: "value";
      value: string;
    });

export type QuotaExportError = {
  label: string;
  message: string;
};

/**
 * A configured custom definition's identity and coarse status, in configured order. A
 * switched-off definition is never checked, so it has `enabled: false` instead of a status.
 */
export type QuotaExportSource =
  | { id: string; providerId: string; status: "ok" | "error" | "unavailable"; entryCount: number }
  | { id: string; providerId: string; entryCount: 0; enabled: false };

/**
 * Per-provider export status.
 *
 * One of three states: ok with entries, error with a message, or unavailable
 * (provider not detected or no cache entry exists).
 */
export type QuotaExportProvider = (
  | { status: "ok"; fetchedAt: number; entries: QuotaExportEntry[] }
  | {
      status: "partial";
      fetchedAt: number;
      entries: QuotaExportEntry[];
      errors: QuotaExportError[];
    }
  | { status: "error"; fetchedAt: number; error: string }
  | { status: "unavailable" }
) & {
  /** Present for aggregate providers; preserves configured source order. */
  sources?: QuotaExportSource[];
};

/** The version 3 export document, assembled from all configured providers. */
export interface QuotaExport {
  /** Schema version. */
  version: 3;
  /** Unix seconds when this document was assembled. */
  exportedAt: number;
  /** True when data was read from disk cache without a live fetch. */
  fromCache: boolean;
  /** Seconds since the oldest provider cache entry was written. */
  cacheAgeSeconds: number;
  /** Keyed by canonical provider id. */
  providers: Record<string, QuotaExportProvider>;
}
