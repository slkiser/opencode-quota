/**
 * The pace of a quota window: how much would be left now if the limit were used evenly until
 * it resets (the Limits tab's │ marker), and whether it runs out before then. Pure.
 */
import type { QuotaRow } from "./types.js";
import { WINDOWS } from "./windows.js";

/** Within this many percentage points of even use counts as on track. */
const ON_TRACK_POINTS = 5;
/** Before this share of the window has passed, the pace so far says too little for a run-out time. */
export const MIN_ELAPSED_SHARE = 0.1;

export type Pace = {
  /** The percent that would be left now with even use: the share of the window still to come. */
  evenLeft: number;
  kind: "spare" | "on_track" | "fast";
  /** Only for "fast": when it runs out at the pace so far (always before the reset). */
  runsOutInMs?: number;
};

/** When the row's window started and ends: its own start, else the reset minus the window's length. */
function windowSpan(row: QuotaRow): { startMs: number; endMs: number } | undefined {
  const endMs = Date.parse(row.resetsAt ?? "");
  if (!Number.isFinite(endMs)) return undefined;
  const ownStartMs = Date.parse(row.windowStartedAt ?? "");
  const lengthMs = row.window ? WINDOWS[row.window].lengthMs : undefined;
  const startMs = Number.isFinite(ownStartMs) ? ownStartMs : endMs - (lengthMs ?? Number.NaN);
  return startMs < endMs ? { startMs, endMs } : undefined;
}

/** The pace of a row with a percent and a known window; undefined for every other row. */
export function paceOf(row: QuotaRow, nowMs: number): Pace | undefined {
  const span = windowSpan(row);
  if (row.percentRemaining === undefined || !span) return undefined;
  if (nowMs < span.startMs || nowMs >= span.endMs) return undefined;
  const lengthMs = span.endMs - span.startMs;
  const elapsedMs = nowMs - span.startMs;
  const evenLeft = ((span.endMs - nowMs) / lengthMs) * 100;
  const left = Math.max(0, Math.min(100, row.percentRemaining));
  if (left > evenLeft + ON_TRACK_POINTS) return { evenLeft, kind: "spare" };
  if (left >= evenLeft - ON_TRACK_POINTS) return { evenLeft, kind: "on_track" };
  // Used faster than it refills: at the same rate, what is left runs out before the reset.
  if (left === 0 || elapsedMs < lengthMs * MIN_ELAPSED_SHARE) return { evenLeft, kind: "fast" };
  const runsOutInMs = (left / (100 - left)) * elapsedMs;
  return { evenLeft, kind: "fast", runsOutInMs };
}
