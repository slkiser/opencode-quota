import type {
  AccountingAcquisitionMethod,
  AccountingAuthority,
  AccountingOwnership,
  AccountingResultType,
} from "./entries.js";

/**
 * Export types for external tool consumption.
 *
 * These types define the schema for the periodic JSON export file
 * written when `config.export.enabled` is true, and for the
 * `show --json` CLI output.
 */

interface QuotaExportEntryBase {
  /** Human-readable row label (same as QuotaToastEntry.name after projection). */
  name: string;
  /** Provider-neutral accounting meaning. */
  resultType: AccountingResultType;
  /** How the value was acquired. */
  acquisitionMethod: AccountingAcquisitionMethod;
  /** Whether the source definition is maintained or user-configured. */
  ownership: AccountingOwnership;
  /** Whether the value was provider-reported or locally derived. */
  authority: AccountingAuthority;
  /** Stable configured source identity for rows from an aggregate provider. */
  sourceId?: string;
  /** Unix seconds when the source observed the value. */
  observedAt?: number;
  /**
   * Normalized window label when the entry has one: "Monthly", "Weekly", "5h", "RPM", etc.
   * Absent when there is only one window for the provider.
   */
  window?: string;
  /** Unix seconds of the next source-backed reset. */
  resetAt?: number;
}

/** A single normalized accounting row in the v2 export document. */
export type QuotaExportEntry =
  | (QuotaExportEntryBase & {
      renderType: "percent";
      percentRemaining: number;
    })
  | (QuotaExportEntryBase & {
      renderType: "value";
      value: string;
    });

/** Ordered configured-source identity and coarse cached status. */
export type QuotaExportSource = {
  id: string;
  providerId: string;
  status: "ok" | "error" | "unavailable";
  entryCount: number;
};

/**
 * Per-provider export status.
 *
 * One of three states: ok with entries, error with a message, or unavailable
 * (provider not detected or no cache entry exists).
 */
export type QuotaExportProvider = (
  | { status: "ok"; fetchedAt: number; entries: QuotaExportEntry[] }
  | { status: "error"; fetchedAt: number; error: string }
  | { status: "unavailable" }
) & {
  /** Present for aggregate providers; preserves configured source order. */
  sources?: QuotaExportSource[];
};

/** Top-level v2 export document assembled from all configured providers. */
export interface QuotaExport {
  /** Schema version. */
  version: 2;
  /** Unix seconds when this document was assembled. */
  exportedAt: number;
  /** True when data was read from disk cache without a live fetch. */
  fromCache: boolean;
  /** Seconds since the oldest provider cache entry was written. */
  cacheAgeSeconds: number;
  /** Keyed by canonical provider id. */
  providers: Record<string, QuotaExportProvider>;
}
