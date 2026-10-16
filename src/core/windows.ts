/**
 * The one table of quota windows: labels, nominal length, whether the window resets on a
 * schedule, and the classifier that reads a window from a legacy label such as "5h:".
 */
import type { QuotaWindow } from "./types.js";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

type WindowInfo = {
  label: string;
  short: string;
  /** Fixed length, when the window has one (months and years do not). */
  lengthMs?: number;
  /** True when the window refills at a reset time, so a reset notice makes sense. */
  resets: boolean;
};

export const WINDOWS: Readonly<Record<QuotaWindow, WindowInfo>> = {
  rpm: { label: "Per minute", short: "1m", lengthMs: 60_000, resets: false },
  hour: { label: "Hourly", short: "1h", lengthMs: HOUR_MS, resets: true },
  five_hour: { label: "5h", short: "5h", lengthMs: 5 * HOUR_MS, resets: true },
  session: { label: "Session", short: "Sess", resets: false },
  day: { label: "Daily", short: "1d", lengthMs: DAY_MS, resets: true },
  week: { label: "Weekly", short: "7d", lengthMs: 7 * DAY_MS, resets: true },
  month: { label: "Monthly", short: "30d", resets: true },
  year: { label: "Yearly", short: "1y", resets: true },
  mcp: { label: "MCP", short: "MCP", resets: false },
  code_review: { label: "Code review", short: "Rev", resets: false },
};

/**
 * The key of `collapsed.window` and `statusLine.window` that picks the window of every provider
 * without a pick of its own.
 */
export const ALL_PROVIDERS = "*";

export function isQuotaWindow(value: unknown): value is QuotaWindow {
  return typeof value === "string" && Object.hasOwn(WINDOWS, value);
}

/** Checked in order; the first match wins ("5 hour" must win over "hour"). */
const WINDOW_PATTERNS: ReadonlyArray<readonly [QuotaWindow, RegExp]> = [
  ["rpm", /\b(?:rpm|per minute|minute|minutes)\b/u],
  ["five_hour", /\b(?:rolling|5h|5 h|5-hour|5 hour|five-hour|five hour)\b/u],
  ["hour", /\b(?:hourly|1h|1 h|1-hour|1 hour|hour)\b/u],
  ["session", /\bsession\b/u],
  ["week", /\b(?:7d|7 d|7-day|7 day|weekly|week)\b/u],
  ["day", /\b(?:daily|1d|1 d|1-day|1 day|day)\b/u],
  ["month", /\b(?:monthly|month)\b/u],
  ["year", /\b(?:yearly|annual|annually|year)\b/u],
  ["mcp", /\bmcp\b/u],
  ["code_review", /\bcode review\b/u],
];

/** The window a label names, for example "5h:" → five_hour, "Weekly" → week. */
export function classifyWindow(text: string): QuotaWindow | undefined {
  const lower = text.trim().replace(/:+$/u, "").trim().toLowerCase();
  if (!lower) return undefined;
  return WINDOW_PATTERNS.find(([, pattern]) => pattern.test(lower))?.[0];
}
