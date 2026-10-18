/**
 * The lines of every quota surface, built from the visible groups (`select.ts`). The TUI
 * draws each segment in its color role; the Web and terminal `/quota` text print the plain
 * text.
 */
import type { SessionModelInput, SessionTokens, Words } from "../core/types.js";
import type { Settings } from "../settings/schema.js";
import { columnsOf } from "./columns.js";
import {
  type BarShape,
  barParts,
  type CacheHit,
  cacheHit,
  evenUseCell,
  fit,
  type Level,
  LOW_CACHE_MARK,
  percentWord,
  sessionTokensText,
} from "./format.js";
import { errorWords, type Place, type RowFacts, rowFacts } from "./row-facts.js";
import { type Group, pickRow, type WindowChoice, windowFor } from "./select.js";

/** Every colored thing quota draws; the TUI maps each to a theme color. */
export type ColorRole =
  | "title"
  | "provider"
  | "account"
  | "label"
  | "good"
  | "warning"
  | "low"
  | "empty"
  | "percent"
  | "reset"
  | "value"
  | "error"
  | "statusName"
  | "separator"
  | "arrows";

/**
 * A piece of a line. `role` "bar" is the filled part of a bar, drawn in its level color.
 * `percent` is the row's percent left, for roles that follow the bar color, and `paceLevel` its
 * level by pace, for when the bar colors follow pace.
 */
export type Segment = {
  text: string;
  role: ColorRole | "bar";
  percent?: number;
  paceLevel?: Level;
  bold?: boolean;
};

/** `segments` with the row's level by pace on each one that follows the bar color. */
export function withPaceLevel(segments: Segment[], paceLevel: Level | undefined): Segment[] {
  if (!paceLevel) return segments;
  return segments.map((segment) =>
    segment.percent === undefined ? segment : { ...segment, paceLevel },
  );
}

/** A line of a surface. `id` is the provider or row it shows ("" for a spacer). */
export type Line = { id: string; segments: Segment[] };

export type Layout = Settings["layout"];

export function lineText(line: Line): string {
  return line.segments.map((segment) => segment.text).join("");
}

/**
 * The start of a row without a bar: its name, cut to `most` columns, then spaces up to the bar
 * column, or 2 after a name that reaches it.
 */
function valueRowStart(indent: number, name: string, most: number, barColumn: number): string {
  const text = `${" ".repeat(indent)}${columnsOf(name) > most ? fit(name, most) : name}`;
  const gap = barColumn - columnsOf(text);
  return `${text}${" ".repeat(gap >= 1 ? gap : 2)}`;
}

/** Where even use would be, the ┃ mark in a bar. */
const EVEN_USE_MARK = "┃";
/** A bar's cells at the least for the even-use mark; a shorter bar has none. */
const EVEN_USE_MIN_CELLS = 3;

/**
 * A bar in two parts: the part left in its level color, then the used part. With `evenLeft`, the
 * percent even use would leave now (`core/pace.ts`), the ┃ mark takes the place of the cell where
 * even use would be, in the row labels' color; a bar under 3 cells gets no mark.
 */
export function barSegments(
  shape: BarShape,
  percent: number,
  width: number,
  evenLeft?: number,
): Segment[] {
  const [filled, empty] = barParts(shape, percent, width);
  const bar: Segment[] = [
    { text: filled, role: "bar", percent },
    { text: empty, role: "empty", percent },
  ];
  if (evenLeft === undefined || shape === "none" || width < EVEN_USE_MIN_CELLS) return bar;
  const mark = evenUseCell(evenLeft, width);
  const marked: Segment[] = [];
  let start = 0;
  for (const segment of bar) {
    const cells = [...segment.text];
    const at = mark - start;
    start += cells.length;
    if (at < 0 || at >= cells.length) {
      marked.push(segment);
      continue;
    }
    marked.push(
      { ...segment, text: cells.slice(0, at).join("") },
      { text: EVEN_USE_MARK, role: "label" },
      { ...segment, text: cells.slice(at + 1).join("") },
    );
  }
  return marked.filter((segment) => segment.text !== "");
}

/** The words after a group's title: its error, or "not checked yet" before the first check. */
function groupState(group: Group, nowMs: number): Segment | undefined {
  const error = errorWords(group, nowMs);
  if (error) return { text: error, role: "error" };
  if (group.unchecked) return { text: "not checked yet", role: "value" };
  return undefined;
}

/**
 * How the sidebar, the collapsed sidebar, the status line and the toasts show rows: named by
 * `words.rowNames`, with the even-use mark when the layout draws it, and "runs out in …" when
 * the place shows it.
 */
function alwaysOnPlace(
  input: Pick<StatusInput, "words" | "nowMs" | "layout" | "runsOut">,
  percent: Place["percent"],
): Place {
  return {
    words: input.words,
    nowMs: input.nowMs,
    names: "words",
    percent,
    evenUse: input.layout.evenUse,
    pace: input.runsOut ? "runsOut" : undefined,
  };
}

/** The facts of every row of each group. */
function groupFacts(groups: Group[], place: Place): Array<{ group: Group; rows: RowFacts[] }> {
  return groups.map((group) => ({
    group,
    rows: group.rows.map((item) => rowFacts(item, group, place)),
  }));
}

/** The one row a group shows on the collapsed sidebar and the status line (`pickRow`). */
function pickedFacts(
  input: StatusInput,
  group: Group,
  percent: Place["percent"],
): RowFacts | undefined {
  const picked = pickRow(group, windowFor(input.window, group));
  return picked && rowFacts(picked, group, alwaysOnPlace(input, percent));
}

/** Marks rows kept from an earlier check when there is no room for the error's words. */
const ERROR_MARK = "⚠";

/** Cuts the segments so their text fits in `width` terminal columns. */
function cut(segments: Segment[], width: number): Segment[] {
  const clipped: Segment[] = [];
  let room = width;
  for (const segment of segments) {
    if (room <= 0) break;
    const text = columnsOf(segment.text) > room ? fit(segment.text, room) : segment.text;
    clipped.push({ ...segment, text });
    room -= columnsOf(text);
  }
  return clipped;
}

/**
 * Cuts the segments so their text fits in `width` terminal columns. An error never goes
 * away: when not even the start of its words fits, the line ends in " ⚠" instead.
 */
function clip(segments: Segment[], width: number): Segment[] {
  const clipped = cut(segments, width);
  const error = segments.find((segment) => segment.role === "error");
  if (!error) return clipped;
  const kept = clipped.find((segment) => segment.role === "error");
  const mark = ` ${ERROR_MARK}`;
  if ((kept && /[\p{L}\p{N}]|⚠/u.test(kept.text)) || width < columnsOf(mark)) return clipped;
  const rest = segments.filter((segment) => segment !== error);
  return [...cut(rest, width - columnsOf(mark)), { ...error, text: mark }];
}

type SidebarInput = {
  groups: Group[];
  layout: Layout;
  words: Words;
  nowMs: number;
  /** Columns the sidebar gives quota. */
  width: number;
  sessionTokens?: SessionTokens;
  /** A "runs out in 2h" line under each row that runs out before its reset. */
  runsOut?: boolean;
};

/** §4.1: the expanded panel's title, with the percent's word its rows leave out: "▼ Quota left". */
export function sidebarTitle(words: Words): string {
  const word = percentWord(words);
  return word ? `▼ Quota ${word}` : "▼ Quota";
}

/**
 * A group's title line: the provider's name in bold and its account, then (`withState`) its
 * error or "not checked yet" after two spaces. Cut to `width` columns.
 */
function groupLine(group: Group, nowMs: number, width: number, withState: boolean): Line {
  const state = withState ? groupState(group, nowMs) : undefined;
  return {
    id: group.providerId,
    segments: clip(
      [
        { text: group.name, role: "provider", bold: true },
        ...(group.account ? [{ text: ` (${group.account})`, role: "account" as const }] : []),
        ...(state ? [{ ...state, text: `  ${state.text}` }] : []),
      ],
      width,
    ),
  };
}

/** "Session  12.3K in · 2.10K out", cut to `width` columns. */
function sessionLine(tokens: SessionTokens, width: number): Line {
  return {
    id: "session",
    segments: clip(
      [
        { text: "Session", role: "label", bold: true },
        { text: `  ${sessionTokensText(tokens)}`, role: "value" },
      ],
      width,
    ),
  };
}

/**
 * "⚠ low cache: 35% (claude-sonnet-5)" for the model with the lowest cache hit among those
 * whose cache hit is low (`cacheHit`), its name cut to fit `width`; undefined when none is.
 */
function lowCacheLine(models: SessionModelInput[], width: number): Line | undefined {
  let worst: { modelID: string; hit: CacheHit } | undefined;
  for (const model of models) {
    const hit = cacheHit(model);
    if (!hit?.low) continue;
    if (!worst || hit.share < worst.hit.share) worst = { modelID: model.modelID, hit };
  }
  if (!worst) return undefined;
  const start = `${LOW_CACHE_MARK} low cache: ${worst.hit.text}`;
  const nameRoom = width - columnsOf(start) - " ()".length;
  const name = worst.modelID;
  const text =
    nameRoom >= 2
      ? `${start} (${fit(name, Math.min(columnsOf(name), nameRoom)).trimEnd()})`
      : start;
  return { id: "session", segments: clip([{ text, role: "warning" }], width) };
}

/** The most cells a "fill" bar takes on the sidebar. */
const SIDEBAR_BAR_MOST = 20;

/**
 * §4.1: the expanded Quota panel, below its title line (`sidebarTitle`). The name column fits
 * the longest name next to a bar; a row without a bar (a balance) starts its value there, or 2
 * columns after a longer name.
 */
export function sidebarLines(input: SidebarInput): Line[] {
  const { layout, nowMs, width } = input;
  const groups = groupFacts(input.groups, alwaysOnPlace(input, "number"));
  const percentRows = groups.flatMap(({ rows }) => rows.filter((row) => row.percent !== undefined));
  const resetWidth = 1 + Math.max(0, ...percentRows.map((row) => row.reset.length));
  const nameWidth = Math.min(
    layout.labelWidth,
    Math.max(0, ...percentRows.map((row) => columnsOf(row.name))),
  );
  const barColumn = layout.indent + nameWidth + 1;
  const fixed = barColumn + 5 + resetWidth;
  const wanted = layout.barWidth === "fill" ? SIDEBAR_BAR_MOST : layout.barWidth;
  const barWidth = layout.bar === "none" ? 0 : Math.max(0, Math.min(wanted, width - fixed));

  const rowLine = (row: RowFacts): Line => {
    const { percent } = row;
    if (percent === undefined) {
      const start = valueRowStart(layout.indent, row.name, layout.labelWidth, barColumn);
      return {
        id: row.id,
        segments: clip(
          [
            { text: start, role: "label" },
            { text: row.value, role: "value" },
          ],
          width,
        ),
      };
    }
    const labelText = `${" ".repeat(layout.indent)}${fit(row.name, nameWidth)} `;
    return {
      id: row.id,
      segments: withPaceLevel(
        [
          { text: labelText, role: "label", percent },
          ...barSegments(layout.bar, percent, barWidth, row.evenLeft),
          { text: row.value.padStart(5), role: "percent", percent },
          { text: row.reset.padStart(resetWidth), role: "reset", percent },
        ],
        row.paceLevel,
      ),
    };
  };

  const lines: Line[] = [];
  groups.forEach(({ group, rows }, index) => {
    if (index > 0) {
      for (let gap = 0; gap < layout.providerGap; gap++) lines.push({ id: "", segments: [] });
    }
    lines.push(groupLine(group, nowMs, width, true));
    for (const row of rows) {
      lines.push(rowLine(row));
      if (!row.pace) continue;
      const text = `${" ".repeat(barColumn)}${row.pace.words}`;
      lines.push({ id: row.id, segments: clip([{ text, role: "warning" }], width) });
    }
  });
  if (input.sessionTokens) {
    for (let gap = 0; gap < layout.providerGap; gap++) lines.push({ id: "", segments: [] });
    lines.push(sessionLine(input.sessionTokens, width));
    const lowCache = lowCacheLine(input.sessionTokens.models ?? [], width);
    if (lowCache) lines.push(lowCache);
  }
  return lines;
}

/** §4.2: the collapsed panel's title. A provider with several accounts counts once. */
export function collapsedTitle(groups: Group[]): string {
  const count = new Set(groups.map((group) => group.providerId)).size;
  const errors = new Set(groups.filter((group) => group.error).map((group) => group.providerId))
    .size;
  const providers = `${count} ${count === 1 ? "provider" : "providers"}`;
  return `▶ Quota (${providers}${errors ? `, ${errors} ${errors === 1 ? "error" : "errors"}` : ""})`;
}

/** A collapsed line's provider (10) and row name (5) columns. */
const COLLAPSED_NAMES = 15;
/** The most cells a collapsed bar takes. */
const COLLAPSED_BAR_MOST = 10;

type CollapsedInput = {
  groups: Group[];
  layout: Layout;
  words: Words;
  nowMs: number;
  width: number;
  /** Preferred window by provider id, or for all providers (`windowFor`). */
  window: Record<string, WindowChoice>;
  /** A "runs out in 2h" line under each provider whose shown row runs out before its reset. */
  runsOut?: boolean;
};

/**
 * §4.2: one line per provider with its preferred window. When the last check failed, the
 * error's words take the place of the reset time next to the rows kept from before. The bar
 * takes the room the names, the percent and the longest reset time leave, at most 10 cells.
 */
export function collapsedLines(input: CollapsedInput): Line[] {
  const { layout, nowMs } = input;
  const picks = input.groups.map((group) => ({
    group,
    picked: pickedFacts(input, group, "usedWord"),
  }));
  // The percent after a space: " 100%", or "  100% used" with its word.
  const percentWidth = input.words.percent === "used" ? 10 : 5;
  // The reset as wide as the longest, at least "11h 59m".
  const resetWidth = Math.max(7, ...picks.map(({ picked }) => columnsOf(picked?.reset ?? "")));
  const room = input.width - COLLAPSED_NAMES - percentWidth - 1 - resetWidth;
  const wanted = layout.barWidth === "fill" ? COLLAPSED_BAR_MOST : layout.barWidth;
  const barWidth =
    layout.bar === "none" ? 0 : Math.max(0, Math.min(wanted, COLLAPSED_BAR_MOST, room));
  const providerLine = (group: Group, picked: RowFacts | undefined): Line => {
    const percent = picked?.percent;
    const name: Segment = { text: `${fit(group.title, 9)} `, role: "provider", percent };
    const state = groupState(group, nowMs);
    if (!picked || percent === undefined) {
      const value: Segment = state ?? { text: picked?.value ?? "", role: "value" };
      return { id: group.providerId, segments: clip([name, value], input.width) };
    }
    const error = errorWords(group, nowMs);
    return {
      id: group.providerId,
      segments: clip(
        withPaceLevel(
          [
            name,
            { text: `${fit(picked.name, 4)} `, role: "label", percent },
            ...barSegments(layout.bar, percent, barWidth, picked.evenLeft),
            { text: picked.value.padStart(percentWidth), role: "percent", percent },
            error
              ? { text: `  ${error}`, role: "error" }
              : { text: ` ${picked.reset.padStart(resetWidth)}`, role: "reset", percent },
          ],
          picked.paceLevel,
        ),
        input.width,
      ),
    };
  };
  return picks.flatMap(({ group, picked }) => {
    const line = providerLine(group, picked);
    if (!picked?.pace) return [line];
    const text = `${" ".repeat(10)}${picked.pace.words}`;
    return [
      line,
      { id: group.providerId, segments: clip([{ text, role: "warning" }], input.width) },
    ];
  });
}

/** How much one status line segment shows, from the most to the least. */
export type StatusLevel = "full" | "bar" | "reset" | "numbers";
const STATUS_LEVELS: readonly StatusLevel[] = ["full", "bar", "reset", "numbers"];
/** The status line's little bar. */
const STATUS_BAR_WIDTH = 5;

export type StatusInput = {
  groups: Group[];
  layout: Layout;
  words: Words;
  nowMs: number;
  window: Record<string, WindowChoice>;
  /** "(runs out in 2h)" after each provider whose shown row runs out before its reset. */
  runsOut?: boolean;
};

/** A provider's name on the status line: with its account only when it shows several. */
function statusName(input: StatusInput, group: Group): string {
  const accounts = input.groups.filter((other) => other.providerId === group.providerId).length;
  return accounts > 1 ? group.title : group.name;
}

/**
 * One provider's status line segment at a level of detail (without the separator). When the
 * last check failed, the error's words take the place of the reset time next to the rows kept
 * from before, or "⚠" where the level shows no reset time.
 */
function statusSegment(input: StatusInput, group: Group, level: StatusLevel): Line {
  const { layout, nowMs } = input;
  const picked = pickedFacts(input, group, "usedWord");
  const percent = picked?.percent;
  const name: Segment = { text: statusName(input, group), role: "statusName", percent };
  if (!picked || percent === undefined) {
    const value = groupState(group, nowMs) ?? { text: picked?.value ?? "", role: "value" };
    return { id: group.providerId, segments: [name, { ...value, text: ` ${value.text}` }] };
  }
  const withBar = layout.bar !== "none" && (level === "full" || level === "bar");
  const withReset = level === "full" || level === "reset";
  const error = errorWords(group, nowMs);
  const reset = withReset ? picked.reset : "";
  const after: Segment | undefined = error
    ? { text: ` ${withReset ? error : ERROR_MARK}`, role: "error" }
    : reset
      ? { text: ` ${reset}`, role: "reset", percent }
      : undefined;
  return {
    id: group.providerId,
    segments: withPaceLevel(
      [
        name,
        ...(withBar
          ? [
              { text: " ", role: "separator" as const },
              ...barSegments(layout.bar, percent, STATUS_BAR_WIDTH, picked.evenLeft),
            ]
          : []),
        { text: ` ${picked.value}`, role: "percent", percent },
        ...(after ? [after] : []),
        ...(picked.pace ? [{ text: ` (${picked.pace.words})`, role: "warning" as const }] : []),
      ],
      picked.paceLevel,
    ),
  };
}

export type StatusLayout = {
  level: StatusLevel;
  /** The first group shown (the line scrolls when not all groups fit). */
  start: number;
  shown: Line[];
  /** Groups after the shown ones: the "+N ›" marker. */
  hiddenAfter: number;
};

/** Cuts the name (the first segment) so the rest still fits in `width`; else cuts the end. */
function shortenName(segments: Segment[], width: number): Segment[] {
  const [name, ...rest] = segments;
  const nameWidth = width - columnsOf(rest.map((segment) => segment.text).join(""));
  if (!name || nameWidth < 2) return clip(segments, width);
  return [{ ...name, text: fit(name.text, nameWidth) }, ...rest];
}

/**
 * §4.3 "all" mode: the most detail that fits every group in `room` columns ("% only" when
 * nothing else fits), then the groups that fit from `start`, keeping room for the "‹ " and
 * " +N ›" markers. When not even the first of them fits, its name is cut short, so the
 * markers stay. `level` fixes the detail instead of "auto".
 */
export function statusLayout(
  input: StatusInput,
  room: number,
  start: number,
  level: StatusLevel | "auto",
): StatusLayout {
  const { groups } = input;
  const separator = input.layout.separator;
  const widthAt = (candidate: StatusLevel) =>
    groups.reduce(
      (sum, group) => sum + columnsOf(lineText(statusSegment(input, group, candidate))),
      0,
    ) +
    Math.max(0, groups.length - 1) * columnsOf(separator);
  const chosen =
    level !== "auto"
      ? level
      : (STATUS_LEVELS.find((candidate) => widthAt(candidate) <= room) ?? "numbers");
  const first = Math.max(0, Math.min(start, groups.length - 1));
  const shown: Line[] = [];
  let used = first > 0 ? 2 : 0;
  const markerWidth = (index: number) =>
    index < groups.length - 1 ? columnsOf(` +${groups.length - index} ›`) : 0;
  for (let index = first; index < groups.length; index++) {
    const segment = statusSegment(input, groups[index] as Group, chosen);
    const width = columnsOf(lineText(segment)) + (shown.length > 0 ? columnsOf(separator) : 0);
    if (used + width + markerWidth(index) > room) break;
    shown.push(segment);
    used += width;
  }
  const firstGroup = groups[first];
  const left = room - used - markerWidth(first);
  if (shown.length === 0 && firstGroup && left > 0) {
    const segment = statusSegment(input, firstGroup, chosen);
    shown.push({ ...segment, segments: shortenName(segment.segments, left) });
  }
  return { level: chosen, start: first, shown, hiddenAfter: groups.length - first - shown.length };
}

/**
 * §4.3 "one provider, big bar" (v5's prompt bar): the first group with a 10-cell bar. The
 * error's words take the place of the reset time; without a percent row the line shows the
 * group's error or value instead of a bar. Cut to `width` columns when given, keeping " ⚠"
 * when the error's words don't fit.
 */
export function bigStatusLine(input: StatusInput, width?: number): Line | undefined {
  const group = input.groups[0];
  if (!group) return undefined;
  const picked = pickedFacts(input, group, "words");
  const percent = picked?.percent;
  if (!picked || percent === undefined) {
    const line = statusSegment(input, group, "full");
    return width === undefined ? line : { ...line, segments: clip(line.segments, width) };
  }
  const error = errorWords(group, input.nowMs);
  const after: Segment | undefined = error
    ? { text: ` · ${error}`, role: "error" }
    : picked.reset
      ? { text: ` · ${picked.reset}`, role: "reset", percent }
      : undefined;
  const segments = withPaceLevel(
    [
      { text: `${statusName(input, group)} ${picked.name} `, role: "statusName", percent },
      ...barSegments(input.layout.bar, percent, 10, picked.evenLeft),
      { text: ` ${picked.value}`, role: "percent", percent },
      ...(after ? [after] : []),
      ...(picked.pace ? [{ text: ` · ${picked.pace.words}`, role: "warning" as const }] : []),
    ],
    picked.paceLevel,
  );
  return { id: group.providerId, segments: width === undefined ? segments : clip(segments, width) };
}

/** The name column of plain lines: the provider and the row's label. */
const PLAIN_NAME_WIDTH = 19;

/**
 * §4.4: plain text, one line per visible row, then a line per provider error. The Web and
 * terminal `/quota` text print these.
 */
export function plainLines(params: {
  groups: Group[];
  words: Words;
  nowMs: number;
  sessionTokens?: SessionTokens;
  /** "runs out in 2h" after each row that runs out before its reset. */
  runsOut?: boolean;
}): string[] {
  const { words, nowMs } = params;
  const pace = params.runsOut ? "runsOut" : undefined;
  const place: Place = { words, nowMs, names: "label", percent: "words", pace };
  const lines = groupFacts(params.groups, place).flatMap(({ group, rows }) => {
    const texts = rows.map((row) => {
      const name = fit(`${group.title} ${row.name}`, PLAIN_NAME_WIDTH);
      if (row.percent === undefined) return `${name} ${row.value}`.trimEnd();
      const line = `${name} ${row.value.padEnd(13)} ${row.reset}`.trimEnd();
      return row.pace ? `${line}  ${row.pace.words}` : line;
    });
    const state = groupState(group, nowMs);
    return state ? [...texts, `${fit(group.title, PLAIN_NAME_WIDTH)} ${state.text}`] : texts;
  });
  return params.sessionTokens
    ? [...lines, `Session  ${sessionTokensText(params.sessionTokens)}`]
    : lines;
}

/**
 * How a toast lays out its rows: one line per row under its provider's name ("grouped"), or
 * each row on two lines with a bar as wide as the toast ("detailed").
 */
export type ToastLayout = Settings["toast"]["layout"];

export type ToastInput = {
  groups: Group[];
  words: Words;
  nowMs: number;
  /** The bar shape and the even-use mark; a toast's bars take the room it has. */
  layout: Layout;
  toastLayout: ToastLayout;
  /** Columns of text inside the toast (`toastRoom`); no line is wider. */
  room: number;
  /** A "runs out in 2h" line under each row that runs out before its reset. */
  runsOut?: boolean;
  sessionTokens?: SessionTokens;
};

/** A toast bar's cells at the least; with less room the row has no bar. */
const TOAST_BAR_MIN = 3;
/** A grouped toast's row indent, its name column and its bar at the most. */
const GROUPED_INDENT = 2;
const GROUPED_NAME_MAX = 9;
const GROUPED_BAR_MAX = 20;

/** The segments without the spaces at the end of their line. */
export function trimEnd(segments: Segment[]): Segment[] {
  const trimmed = [...segments];
  while (trimmed.length > 0) {
    const last = trimmed[trimmed.length - 1] as Segment;
    const text = last.text.trimEnd();
    if (text) {
      trimmed[trimmed.length - 1] = { ...last, text };
      break;
    }
    trimmed.pop();
  }
  return trimmed;
}

/** "runs out in 2h" at `column`, or further left so it ends inside `room`. */
function runsOutLine(id: string, runsOut: string, column: number, room: number): Line {
  const indent = Math.max(0, Math.min(column, room - columnsOf(runsOut)));
  return {
    id,
    segments: clip([{ text: `${" ".repeat(indent)}${runsOut}`, role: "warning" }], room),
  };
}

/**
 * The grouped toast: a line per provider account with its error, then its rows indented 2:
 * the name, a bar in the room the other columns leave (at most 20 cells), the percent and the
 * reset time. "runs out in" goes under the row at the bar's column. The name column fits the
 * longest name next to a bar; a row without a bar starts its value there, or 2 columns after a
 * longer name.
 */
function groupedToastLines(input: ToastInput): Line[] {
  const { nowMs, room, layout } = input;
  const word = percentWord(input.words);
  // "100% left": the number right-aligned, then its word.
  const percentWidth = 4 + (word ? word.length + 1 : 0);
  const named = groupFacts(input.groups, alwaysOnPlace(input, "number"));
  const items = named.flatMap(({ rows }) => rows);
  const resetWidth = Math.max(0, ...items.map((row) => columnsOf(row.reset)));
  const nameWidth = Math.min(
    GROUPED_NAME_MAX,
    Math.max(
      0,
      ...items.filter((row) => row.percent !== undefined).map((row) => columnsOf(row.name)),
    ),
  );
  const barColumn = GROUPED_INDENT + nameWidth + 1;
  const fixed = barColumn + 1 + percentWidth + (resetWidth > 0 ? 2 + resetWidth : 0);
  const barWidth = layout.bar === "none" ? 0 : Math.min(GROUPED_BAR_MAX, room - fixed);
  const withBar = barWidth >= TOAST_BAR_MIN;

  const rowLines = (row: RowFacts): Line[] => {
    const { percent } = row;
    if (percent === undefined) {
      const start = valueRowStart(GROUPED_INDENT, row.name, GROUPED_NAME_MAX, barColumn);
      const value: Segment = { text: row.value, role: "value" };
      return [{ id: row.id, segments: clip([{ text: start, role: "label" }, value], room) }];
    }
    const name = `${" ".repeat(GROUPED_INDENT)}${fit(row.name, nameWidth)} `;
    const number = row.value.padStart(4);
    const segments = withPaceLevel(
      [
        { text: name, role: "label", percent },
        ...(withBar ? barSegments(layout.bar, percent, barWidth, row.evenLeft) : []),
        {
          text: `${withBar ? " " : ""}${word ? `${number} ${word}` : number}`,
          role: "percent",
          percent,
        },
        ...(row.reset ? [{ text: `  ${row.reset}`, role: "reset" as const, percent }] : []),
      ],
      row.paceLevel,
    );
    const line: Line = { id: row.id, segments: clip(segments, room) };
    return row.pace ? [line, runsOutLine(row.id, row.pace.words, barColumn, room)] : [line];
  };

  const lines = named.flatMap(({ group, rows }) => [
    groupLine(group, nowMs, room, true),
    ...rows.flatMap(rowLines),
  ]);
  return input.sessionTokens ? [...lines, sessionLine(input.sessionTokens, room)] : lines;
}

/**
 * `left` at the start of a line `room` columns wide and `right` at its end; `left` is cut with
 * "…" when both don't fit.
 */
function spread(left: Segment, right: Segment, room: number): Segment[] {
  const leftRoom = room - columnsOf(right.text) - 1;
  if (leftRoom < 1) return clip([left, { ...right, text: ` ${right.text}` }], room);
  const leftText = columnsOf(left.text) > leftRoom ? fit(left.text, leftRoom) : left.text;
  const gap = " ".repeat(room - columnsOf(leftText) - columnsOf(right.text));
  return [
    { ...left, text: leftText },
    { ...right, text: `${gap}${right.text}` },
  ];
}

/**
 * The detailed toast (v5's look): an empty line between providers, the provider's name, its
 * error under it, then per row its name with the reset time at the right, and a bar as wide
 * as the toast with the percent at the right. "runs out in" goes under the bar.
 */
function detailedToastLines(input: ToastInput): Line[] {
  const { nowMs, room, layout } = input;
  const named = groupFacts(input.groups, alwaysOnPlace(input, "words"));
  const percents = named.flatMap(({ rows }) =>
    rows.flatMap((row) => (row.percent === undefined ? [] : [row.value])),
  );
  const percentWidth = Math.max(0, ...percents.map(columnsOf));
  const barWidth = layout.bar === "none" ? 0 : room - 2 - percentWidth;

  const rowLines = (row: RowFacts): Line[] => {
    const { percent } = row;
    const name: Segment = { text: row.name, role: "label", percent };
    if (percent === undefined) {
      const value: Segment = { text: row.value, role: "value" };
      return [{ id: row.id, segments: spread(name, value, room) }];
    }
    const percentWords = row.value.padStart(percentWidth);
    const bar: Segment[] =
      barWidth >= TOAST_BAR_MIN
        ? [
            ...barSegments(layout.bar, percent, barWidth, row.evenLeft),
            { text: `  ${percentWords}`, role: "percent", percent },
          ]
        : [{ text: percentWords.padStart(room), role: "percent", percent }];
    const nameLine = row.reset
      ? spread(name, { text: row.reset, role: "reset", percent }, room)
      : clip([name], room);
    return [
      { id: row.id, segments: withPaceLevel(nameLine, row.paceLevel) },
      { id: row.id, segments: withPaceLevel(clip(bar, room), row.paceLevel) },
      ...(row.pace ? [runsOutLine(row.id, row.pace.words, 0, room)] : []),
    ];
  };

  const blank: Line = { id: "", segments: [] };
  const lines = named.flatMap(({ group, rows }, index) => {
    const state = groupState(group, nowMs);
    return [
      ...(index > 0 ? [blank] : []),
      groupLine(group, nowMs, room, false),
      ...(state ? [{ id: group.providerId, segments: clip([state], room) }] : []),
      ...rows.flatMap(rowLines),
    ];
  });
  if (!input.sessionTokens) return lines;
  const session = spread(
    { text: "Session", role: "label", bold: true },
    { text: sessionTokensText(input.sessionTokens), role: "value" },
    room,
  );
  return [...lines, ...(lines.length > 0 ? [blank] : []), { id: "session", segments: session }];
}

/** §4.4: a quota toast's lines in its layout, none wider than `room` columns. */
export function toastLines(input: ToastInput): Line[] {
  const lines =
    input.toastLayout === "detailed" ? detailedToastLines(input) : groupedToastLines(input);
  return lines.map((line) => ({ ...line, segments: trimEnd(line.segments) }));
}
