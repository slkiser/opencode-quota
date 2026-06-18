/**
 * Export types for external tool consumption.
 *
 * These types define the schema for the periodic JSON export file
 * written when `config.export.enabled` is true, and for the
 * `show --json` CLI output.
 */

/**
 * A single normalized quota row in the export document.
 *
 * Mirrors `QuotaToastEntry` after projection, with fields flattened
 * for machine-readable consumption.
 */
export interface QuotaExportEntry {
  /** Human-readable row label (same as QuotaToastEntry.name after projection). */
  name: string;
  /**
   * Normalized window label when the entry has one: "Monthly", "Weekly", "5h", "RPM", etc.
   * Absent when there is only one window for the provider.
   */
  window?: string;
  /** Quota remaining as percentage [0..100]. Absent for value-kind entries. */
  percentRemaining?: number;
  /** Unix seconds of the next quota reset. Absent when not reported by the provider. */
  resetAt?: number;
  /**
   * True when the provider reported an unlimited plan.
   * In the first iteration this is always false — the normalized QuotaToastEntry
   * does not carry an unlimited flag. Leave the field in the schema for forward-
   * compatibility; providers can opt-in when they propagate it.
   */
  unlimited: boolean;
}

/**
 * Per-provider export status.
 *
 * One of three states: ok with entries, error with a message, or unavailable
 * (provider not detected or no cache entry exists).
 */
export type QuotaExportProvider =
  | { status: "ok"; fetchedAt: number; entries: QuotaExportEntry[] }
  | { status: "error"; fetchedAt: number; error: string }
  | { status: "unavailable" }; // isAvailable() = false or no cache entry

/**
 * Top-level export document assembled from all configured providers.
 *
 * Written atomically to disk when `config.export.enabled` is true,
 * and emitted by `show --json`.
 */
export interface QuotaExport {
  /** Schema version. Bump only on breaking changes. */
  version: 1;
  /** Unix seconds when this document was assembled. */
  exportedAt: number;
  /** True when data was read from disk cache without a live fetch. */
  fromCache: boolean;
  /** Seconds since the oldest provider cache entry was written. */
  cacheAgeSeconds: number;
  /** Keyed by canonical provider id (e.g. "copilot", "opencode-go"). */
  providers: Record<string, QuotaExportProvider>;
}
