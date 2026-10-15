// Adapted from upstream 08dd8ea / 2733b5b quota-exhaustion-projection.ts.
import { isAccountingDocument, type AccountingRow } from "./accounting.js";
export type QuotaRunway =
  | { kind: "before_reset"; projectedAt: number; resetAt: number }
  | { kind: "lasts_past_reset"; resetAt: number };
/** Linear average since the explicit fixed-window start, not a recent-rate forecast. */
export function projectQuotaRunway(row: AccountingRow, now = Date.now()): QuotaRunway | null {
  if (
    !isAccountingDocument({ version: 1, rows: [row] }) ||
    !Number.isFinite(now) ||
    row.window.kind !== "fixed" ||
    !row.window.fullReset ||
    row.freshness.kind !== "observed" ||
    row.value.kind !== "percent" ||
    row.value.remaining === null ||
    row.source.authority === "unknown" ||
    !["quota", "rate_limit", "budget"].includes(row.resultType)
  )
    return null;
  const start = Date.parse(row.window.startedAtIso),
    end = Date.parse(row.window.endsAtIso),
    observed = Date.parse(row.freshness.observedAtIso);
  if (
    !(start < observed && observed < end && observed <= now && now < end) ||
    now - observed > 15 * 60000
  )
    return null;
  const used = 100 - row.value.remaining;
  // Zero/unknown usage has no measured rate; do not invent an infinite forecast.
  if (!(used > 0) || !Number.isFinite(used)) return null;
  const projectedAt = observed + (Math.max(0, row.value.remaining) * (observed - start)) / used;
  if (!Number.isFinite(projectedAt)) return null;
  return projectedAt >= end
    ? { kind: "lasts_past_reset", resetAt: end }
    : { kind: "before_reset", projectedAt, resetAt: end };
}
export function formatQuotaRunway(projection: QuotaRunway, now = Date.now()): string {
  if (projection.kind === "lasts_past_reset") return "≈ lasts past reset";
  const minutes = Math.max(0, Math.ceil((projection.projectedAt - now) / 60000));
  const days = Math.floor(minutes / 1440),
    hours = Math.floor((minutes % 1440) / 60),
    rest = minutes % 60;
  return (
    "≈ " +
    [days ? `${days}d` : "", hours ? `${hours}h` : "", rest || (!days && !hours) ? `${rest}m` : ""]
      .filter(Boolean)
      .join(" ")
  );
}
