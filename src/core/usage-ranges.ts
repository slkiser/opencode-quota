/**
 * The usage ranges, in the order every surface lists them, with their user-facing labels.
 * Pure data and parsing: the TUI loads this file without any server code.
 *
 * - "24h" is the rolling last 24 hours; "today", "7d", "30d" and "90d" are local calendar days,
 *   today included.
 * - "all" is the whole history.
 * - "session" is the session plus its subagent sessions.
 * - A bare `/quota_usage` and the Usage tab start on "today".
 * - "between" takes two local dates, both included.
 */
import { parseCalendarDate } from "../lib/calendar-date.js";

export const USAGE_RANGES = [
  { range: "today", label: "Today" },
  { range: "24h", label: "24 hours" },
  { range: "7d", label: "7 days" },
  { range: "30d", label: "30 days" },
  { range: "90d", label: "90 days" },
  { range: "all", label: "All time" },
  { range: "session", label: "This session" },
  { range: "between", label: "Between" },
] as const;

export type UsageRange = (typeof USAGE_RANGES)[number]["range"];

export const DEFAULT_USAGE_RANGE: UsageRange = "today";

/** The 4.x and 5.x token commands (`system.oldCommands`), each `/quota_usage` on its range. */
export const OLD_USAGE_COMMANDS: Readonly<Record<string, UsageRange>> = {
  tokens_today: "today",
  tokens_daily: "24h",
  tokens_weekly: "7d",
  tokens_monthly: "30d",
  tokens_all: "all",
  tokens_session: "session",
  tokens_session_all: "session",
  tokens_between: "between",
};

export function usageRangeLabel(range: UsageRange): string {
  return USAGE_RANGES.find((item) => item.range === range)?.label ?? range;
}

function isUsageRange(text: string): text is UsageRange {
  return USAGE_RANGES.some((item) => item.range === text);
}

type UsageArguments =
  | { ok: true; range: UsageRange; from?: string; to?: string }
  | { ok: false; error: string };

const USAGE_ARGUMENTS_HELP =
  "Usage: /quota_usage [today | 24h | 7d | 30d | 90d | all | session | between YYYY-MM-DD YYYY-MM-DD]";

function argumentsError(problem: string): UsageArguments {
  return { ok: false, error: `${problem}\n${USAGE_ARGUMENTS_HELP}` };
}

/**
 * The range a `/quota_usage` command asks for: nothing is the default range, "between" takes
 * two dates in order.
 */
export function parseUsageArguments(text: string): UsageArguments {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { ok: true, range: DEFAULT_USAGE_RANGE };
  const [range, ...rest] = words;
  if (!isUsageRange(range)) return argumentsError(`Unknown range "${range}".`);
  if (range !== "between") {
    return rest.length === 0
      ? { ok: true, range }
      : argumentsError(`The range ${range} takes no dates.`);
  }
  if (rest.length !== 2) return argumentsError("between needs two dates.");
  const [from, to] = rest;
  for (const date of [from, to]) {
    if (!parseCalendarDate(date)) return argumentsError(`"${date}" is not a date like 2026-01-31.`);
  }
  if (to < from) return argumentsError(`${to} is before ${from}.`);
  return { ok: true, range, from, to };
}
