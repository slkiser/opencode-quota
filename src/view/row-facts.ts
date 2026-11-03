/**
 * What a place shows of one quota row: its name, its percent or value, its reset time, its pace
 * words and where even use would be; and the words for a provider's last error. Places only lay
 * these facts out (widths, bars, colors). Where places differ on purpose, the difference is an
 * option of `Place`, never a rule of their own. Pure.
 */
import { describeError } from "../core/errors.js";
import { type Pace, paceOf } from "../core/pace.js";
import type { Words } from "../core/types.js";
import { WINDOWS } from "../core/windows.js";
import {
  type DurationStyle,
  formatDuration,
  largestUnit,
  type Level,
  paceLevel,
  percentText,
  rowValueText,
} from "./format.js";
import type { Group, VisibleRow } from "./select.js";

/** How one place shows rows. */
export type Place = {
  words: Words;
  nowMs: number;
  /**
   * "words" (sidebar, collapsed sidebar, status line, toasts, /quota text): your name; else, with
   * `words.rowNames` "short", its window's short name ("5h", "7d") when no other row of its group
   * has the same one; else its label. "label" (Limits, the Settings tree, Web and terminal
   * text): your name, else its label.
   */
  names: "words" | "label";
  /**
   * "number": "58%", the place says the word elsewhere. "words": "58% left", "42% used", or
   * "58%" in the bare style. "usedWord": "58%", but "42% used", which bare would read as left.
   */
  percent: "number" | "words" | "usedWord";
  /** Reset and pace times in this style, whatever the words (Limits: always "exact"). */
  times?: Words["reset"];
  /** The place draws the even-use mark, so its facts have `evenLeft`. */
  evenUse?: boolean;
  /**
   * The pace words it shows, none without: "runsOut" only "runs out in 2h" (before the reset),
   * "fast" also "faster than it refills", "all" also "plenty to spare" and "on track".
   */
  pace?: "runsOut" | "fast" | "all";
};

export type RowFacts = {
  /** The row's id, for the lines that show it. */
  id: string;
  name: string;
  /** Its percent left as the row has it, for bars and level colors; undefined without one. */
  percent?: number;
  /** Its level by pace, for the bar colors when they follow pace; undefined without a pace. */
  paceLevel?: Level;
  /** Its percent in the place's style, or the value of a row without one ("$1,240.50 left"). */
  value: string;
  /**
   * The time until it resets in the place's style ("2h 14m", "3.2d"); "" without a percent. The
   * "percent" style starts it with the window's time share, written right after the percent
   * ("/91% 4d", see `afterPercent`).
   */
  reset: string;
  /** The same in the short style ("2h", "4d 12h"), for a place short of room. */
  shortReset: string;
  /** Where even use would be (the percent it would leave now), when the place draws the mark. */
  evenLeft?: number;
  /** The pace words the place shows; `fast` when the row is used faster than it refills. */
  pace?: { words: string; fast: boolean };
};

function nameOf(item: VisibleRow, group: Pick<Group, "rows">, place: Place): string {
  const { window } = item.row;
  if (place.names === "label" || !window) return item.label;
  const short = WINDOWS[window].short;
  if (place.words.rowNames === "full" || item.named) return item.label;
  const shared = group.rows.some(
    (other) => other !== item && other.row.window && WINDOWS[other.row.window].short === short,
  );
  return shared ? item.label : short;
}

/** The time share starts a reset text in the "percent" style: "/91% 4d". */
const SHARE_MARK = "/";

/** Whether `reset` starts with the time share, so it goes right after the percent. */
export function joinsPercent(reset: string): boolean {
  return reset.startsWith(SHARE_MARK);
}

/**
 * `reset` after a percent with `gap` between them; with no gap before the time share, which
 * reads as one with the percent ("58%/91% 4d"). "" without a reset.
 */
export function afterPercent(reset: string, gap: string): string {
  if (!reset) return "";
  return joinsPercent(reset) ? reset : `${gap}${reset}`;
}

/** `reset` where no percent comes right before it: the time share without its "/" ("91% 4d"). */
export function resetAlone(reset: string): string {
  return joinsPercent(reset) ? reset.slice(SHARE_MARK.length) : reset;
}

/** The time style of a reset style for pace words: "percent" writes them in the short style. */
function durationStyle(times: Words["reset"]): DurationStyle {
  return times === "percent" ? "short" : times;
}

/** The share of the window's time left, or used when `words.percent` is "used": "/91%". */
function timeShare(pace: Pace, words: Words): string {
  const share = words.percent === "used" ? 100 - pace.evenLeft : pace.evenLeft;
  return `${SHARE_MARK}${Math.round(share)}%`;
}

/** "plenty to spare", "on track", "faster than it refills", or "runs out in 2h 10m". */
function paceWords(pace: Pace, times: DurationStyle, words: Words): string {
  if (pace.kind === "spare") return "plenty to spare";
  if (pace.kind === "on_track") return "on track";
  if (pace.runsOutInMs === undefined) return "faster than it refills";
  return `runs out in ${formatDuration(pace.runsOutInMs, times, words.resetDecimals)}`;
}

function showsPace(pace: Pace, shown: Place["pace"]): boolean {
  if (shown === "all") return true;
  if (shown === "fast") return pace.kind === "fast";
  return shown === "runsOut" && pace.runsOutInMs !== undefined;
}

/** `item`, one of `group`'s rows, as `place` shows it. */
export function rowFacts(item: VisibleRow, group: Pick<Group, "rows">, place: Place): RowFacts {
  const { row } = item;
  const { words, nowMs } = place;
  const name = nameOf(item, group, place);
  const percent = row.percentRemaining;
  if (percent === undefined) {
    return { id: row.id, name, value: rowValueText(row), reset: "", shortReset: "" };
  }
  const withWord =
    place.percent === "words" || (place.percent === "usedWord" && words.percent === "used");
  const times = place.times ?? words.reset;
  const resetMs = Date.parse(row.resetsAt ?? "");
  const resetIn = (style: DurationStyle) =>
    Number.isFinite(resetMs) ? formatDuration(resetMs - nowMs, style, words.resetDecimals) : "";
  const pace = paceOf(row, nowMs);
  // Without a pace (the window's start unknown) the "percent" style shows the time alone.
  const percentStyleTime = Number.isFinite(resetMs) ? largestUnit(resetMs - nowMs) : "";
  const reset =
    times !== "percent"
      ? resetIn(times)
      : pace
        ? `${timeShare(pace, words)} ${percentStyleTime}`
        : percentStyleTime;
  const level = pace && paceLevel(pace, percent);
  return {
    id: row.id,
    name,
    percent,
    ...(level ? { paceLevel: level } : {}),
    value: percentText(words, percent, withWord),
    reset,
    shortReset: resetIn("short"),
    ...(place.evenUse && pace ? { evenLeft: pace.evenLeft } : {}),
    ...(pace && showsPace(pace, place.pace)
      ? {
          pace: { words: paceWords(pace, durationStyle(times), words), fast: pace.kind === "fast" },
        }
      : {}),
  };
}

/** The words for a group's last error ("Sign in again"); undefined when its last check worked. */
export function errorWords(
  group: Pick<Group, "error" | "name">,
  nowMs: number,
): string | undefined {
  return group.error ? describeError(group.error, group.name, nowMs) : undefined;
}
