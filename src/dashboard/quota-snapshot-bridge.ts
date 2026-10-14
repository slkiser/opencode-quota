/**
 * Bridges quota data already computed for the toast/status report into the
 * dashboard's quota_snapshots table, so historical charts get real data
 * without triggering any extra provider API calls (the render pipeline's
 * per-provider cache is reused as-is).
 */

import type { QuotaProviderResult, QuotaToastEntry } from "../lib/entries.js";
import { isPercentEntry } from "../lib/entries.js";
import type { DashboardApi, QuotaLimit } from "./api.js";

export interface ProviderResultForSnapshot {
  providerId: string;
  result: QuotaProviderResult;
}

/**
 * Minimum percent-used drop (between the last captured snapshot and the
 * newly-fetched one) required to treat a passed reset time as an actual
 * reset rather than ordinary usage/clock noise.
 */
const RESET_DETECTION_MIN_DROP_PERCENT = 10;

function severityFor(percentUsed: number): QuotaLimit["severity"] {
  if (percentUsed >= 90) return "critical";
  if (percentUsed >= 70) return "warning";
  return "normal";
}

function toQuotaLimits(entries: QuotaToastEntry[]): QuotaLimit[] {
  return entries.filter(isPercentEntry).map((entry) => {
    const percentUsed = 100 - entry.percentRemaining;
    return {
      kind: entry.label || entry.name,
      group: entry.group || entry.name,
      percent: percentUsed,
      severity: severityFor(percentUsed),
      resets_at: entry.resetTimeIso || "",
    };
  });
}

/**
 * Capture a quota_snapshots row per provider that has at least one
 * percent-based entry. Value-only entries (e.g. "OpenCode Go: $12.45") don't
 * carry percent/reset data and are skipped rather than represented with
 * made-up numbers.
 *
 * A provider with no percent entries but a fetch error (e.g. Claude CLI
 * session expired) still gets a snapshot, carrying that error message instead
 * of quota numbers - otherwise it silently disappears from the dashboard
 * instead of showing an actionable "needs re-auth" state.
 */
export function captureQuotaSnapshots(
  dashboardApi: Pick<DashboardApi, "captureSnapshot">,
  providerResults: ProviderResultForSnapshot[],
): string[] {
  const diagnostics: string[] = [];
  for (const { providerId, result } of providerResults) {
    const limits = toQuotaLimits(result.entries);

    if (limits.length === 0) {
      if (result.errors.length === 0) continue;

      try {
        dashboardApi.captureSnapshot(providerId, {
          ...(result.observation ? { observation: result.observation } : {}),
          percentRemaining: null,
          limits: [],
          error: result.errors[0].message,
        });
      } catch (err) {
        diagnostics.push(`History write failed for ${providerId}`);
        console.error(`[dashboard] Failed to capture error snapshot for ${providerId}:`, err);
      }
      continue;
    }

    const percentRemaining = Math.min(...limits.map((l) => 100 - l.percent));

    try {
      dashboardApi.captureSnapshot(providerId, {
        ...(result.observation ? { observation: result.observation } : {}),
        percentRemaining,
        limits,
        ...(result.errors[0] ? { error: result.errors[0].message } : {}),
      });
    } catch (err) {
      diagnostics.push(`History write failed for ${providerId}`);
      console.error(`[dashboard] Failed to capture snapshot for ${providerId}:`, err);
    }
  }
  return diagnostics;
}

/**
 * Detects quota window resets by comparing each provider's newly-fetched
 * limits against the last captured snapshot: if a limit's reset time has
 * passed and its percent-used dropped meaningfully, the window reset.
 * Percent-based bookkeeping only (limit = 100), since quota entries don't
 * expose an absolute cap. Must be called before captureQuotaSnapshots()
 * overwrites the "current" snapshot the comparison relies on.
 */
export function detectAndRecordWeeklyResets(
  dashboardApi: Pick<DashboardApi, "getCurrentQuota" | "recordWeeklyReset">,
  providerResults: ProviderResultForSnapshot[],
): void {
  for (const { providerId, result } of providerResults) {
    const newLimits = toQuotaLimits(result.entries);
    if (newLimits.length === 0) continue;

    let previous: { limits?: QuotaLimit[] } | null;
    try {
      previous = dashboardApi.getCurrentQuota(providerId);
    } catch (err) {
      console.error(`[dashboard] Failed to read previous quota for ${providerId}:`, err);
      continue;
    }
    if (!previous?.limits) continue;

    for (const newLimit of newLimits) {
      const prevLimit = previous.limits.find((l) => l.kind === newLimit.kind);
      if (!prevLimit?.resets_at) continue;

      const resetTimePassed = new Date(prevLimit.resets_at).getTime() <= Date.now();
      const droppedMeaningfully =
        prevLimit.percent - newLimit.percent >= RESET_DETECTION_MIN_DROP_PERCENT;
      if (!resetTimePassed || !droppedMeaningfully) continue;

      try {
        dashboardApi.recordWeeklyReset(providerId, newLimit.kind, {
          used: prevLimit.percent,
          remaining: 100 - newLimit.percent,
          limit: 100,
        });
      } catch (err) {
        console.error(
          `[dashboard] Failed to record reset for ${providerId}/${newLimit.kind}:`,
          err,
        );
      }
    }
  }
}

/** Shared post-fetch hook. Provider-only history cannot prove account/window
 * continuity, so reset heuristics are not run until ACC-02 supplies that proof.
 * Stored reset history remains readable. No provider requests occur here. */
export function recordQuotaObservations(
  dashboardApi: Pick<DashboardApi, "captureSnapshot">,
  providerResults: ProviderResultForSnapshot[],
): string[] {
  return captureQuotaSnapshots(dashboardApi, providerResults);
}
