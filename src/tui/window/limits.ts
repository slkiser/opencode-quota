/**
 * The lines of the quota window's Limits tab: every provider and row of the snapshot, in the
 * sidebar's order, under your names for the rows, else their full names. Pure. Its times are
 * always exact ("2h 30m"), whatever the reset words.
 *
 * All rows share one grid: label │ bar │ percent │ reset │ pace, each column as wide as its
 * widest entry, the percent right-aligned. The bar has your bar shape (the thin ━─ line when bars
 * are off) with the even-use marker ┃ (`core/pace.ts`) and takes the room the other columns
 * leave, so the grid always spans the window. A provider's line has its name and plan; an error
 * gets its own line under it. Like the window's other tabs, a provider's line starts one column
 * in, its rows and its error three.
 *
 * A narrower window first shortens "resets in 2h 30m" to "2h", then the labels, and then puts
 * the reset and the pace on a line under the bar (on two lines when they don't fit together).
 */
import type { QuotaSnapshot, Words } from "../../core/types.js";
import { columnsOf, padEndColumns, padStartColumns, sliceColumns } from "../../view/columns.js";
import { type BarShape, DEFAULT_WORDS, fit } from "../../view/format.js";
import { errorWords, type Place, type RowFacts, rowFacts } from "../../view/row-facts.js";
import { type Group, type RowSettings, visibleGroups } from "../../view/select.js";
import {
  barSegments,
  type Layout,
  type Line,
  type Segment,
  trimEnd,
  withPaceLevel,
} from "../../view/text.js";

/** Before a provider's name. */
const HEADING_INDENT = " ";
/** Before a row's label, an error and the line that says no provider was found. */
const INDENT = "   ";
/** Between the label, the bar and the percent. */
const GAP = "  ";
/** Before the reset and before the pace. */
const WIDE_GAP = "   ";
const LABEL_MAX = 24;
/** The labels are cut to this before the reset and the pace move under the bar. */
const LABEL_NARROW = 12;
const BAR_MAX = 80;
/** The bar each step down to a narrower grid needs; below the last, rows take two lines. */
const BAR_ROOMY = 20;
const BAR_SHORT = 14;
const BAR_MIN = 8;

/** The grid's column widths; `narrow` puts the reset and the pace under the bar. */
type Grid = {
  label: number;
  bar: number;
  percent: number;
  reset: number;
  pace: number;
  longReset: boolean;
  narrow: boolean;
  /** Where the bar starts; the narrow layout's reset and pace line starts there too. */
  barColumn: number;
};

export type LimitsInput = {
  snapshot: QuotaSnapshot;
  /** The display settings: row names, the sidebar's order and the bar shape. */
  display: RowSettings & { layout: Pick<Layout, "bar"> };
  nowMs: number;
  /** Columns inside the window. */
  width: number;
};

const widest = (texts: string[]) => Math.max(0, ...texts.map(columnsOf));
function resetWords(row: RowFacts, long: boolean): string {
  if (!row.reset) return "";
  return long ? `resets in ${row.reset}` : row.shortReset;
}

/** The widest grid that fits `width`, giving way in the order the file comment describes. */
function gridFor(rows: RowFacts[], width: number): Grid {
  const bars = rows.filter((row) => row.percent !== undefined);
  const labelWidest = Math.min(LABEL_MAX, widest(rows.map((row) => row.name)));
  if (bars.length === 0) {
    // Only balances and other values: they line up at their right ends.
    const barColumn = INDENT.length + labelWidest + GAP.length;
    const values = widest(rows.map((row) => row.value));
    const percent = Math.max(1, Math.min(values, width - barColumn));
    return {
      label: labelWidest,
      bar: 0,
      percent,
      reset: 0,
      pace: 0,
      longReset: true,
      narrow: false,
      barColumn,
    };
  }
  const percent = widest(bars.map((row) => row.value));
  const pace = widest(bars.map((row) => row.pace?.words ?? ""));
  const build = (longReset: boolean, label: number, narrow: boolean): Grid => {
    const reset = widest(bars.map((row) => resetWords(row, longReset)));
    const barColumn = INDENT.length + label + GAP.length;
    const tail = narrow
      ? 0
      : (reset > 0 ? WIDE_GAP.length + reset : 0) + (pace > 0 ? WIDE_GAP.length + pace : 0);
    const fixed = barColumn + GAP.length + percent + tail;
    const bar = Math.min(BAR_MAX, Math.max(1, width - fixed));
    return { label, bar, percent, reset, pace, longReset, narrow, barColumn };
  };
  const roomy = build(true, labelWidest, false);
  if (roomy.bar >= BAR_ROOMY) return roomy;
  const short = build(false, labelWidest, false);
  if (short.bar >= BAR_SHORT) return short;
  const cut = build(false, Math.min(labelWidest, LABEL_NARROW), false);
  if (cut.bar >= BAR_MIN) return cut;
  // A very narrow window cuts the labels further, down to 4 columns, to keep the bar.
  const room = width - INDENT.length - 2 * GAP.length - percent - BAR_MIN;
  return build(true, Math.min(labelWidest, LABEL_NARROW, Math.max(4, room)), true);
}

function rowLines(row: RowFacts, grid: Grid, width: number, shape: BarShape): Line[] {
  const { id, percent } = row;
  const label: Segment = {
    text: `${INDENT}${fit(row.name, grid.label)}${GAP}`,
    role: "label",
    percent,
  };
  if (percent === undefined) {
    // A balance or other value ends where the percents end, so the amounts line up.
    const end = grid.bar > 0 ? grid.bar + GAP.length + grid.percent : grid.percent;
    const room = Math.max(1, Math.min(end, width - grid.barColumn));
    const value = padStartColumns(fit(row.value, room).trimEnd(), room);
    return [{ id, segments: [label, { text: value, role: "value" }] }];
  }
  const tag = (segments: Segment[]) => withPaceLevel(segments, row.paceLevel);
  const bar = barSegments(shape, percent, grid.bar, row.evenLeft);
  const percentSegment: Segment = {
    text: `${GAP}${padStartColumns(row.value, grid.percent)}`,
    role: "percent",
    percent,
  };
  const pace: Segment | undefined = row.pace && {
    text: row.pace.words,
    role: row.pace.fast ? "warning" : "value",
  };
  const reset = resetWords(row, grid.longReset);
  if (!grid.narrow) {
    const segments: Segment[] = [label, ...bar, percentSegment];
    if (grid.reset > 0) {
      const text = `${WIDE_GAP}${padEndColumns(reset, grid.reset)}`;
      segments.push({ text, role: "reset", percent });
    }
    if (pace) segments.push({ ...pace, text: `${WIDE_GAP}${pace.text}` });
    return [{ id, segments: tag(trimEnd(segments)) }];
  }
  const under: Segment = { text: " ".repeat(grid.barColumn), role: "label" };
  const lines: Line[] = [{ id, segments: tag([label, ...bar, percentSegment]) }];
  const resetSegment: Segment = { text: reset, role: "reset", percent };
  const together = grid.barColumn + columnsOf(reset) + 3 + columnsOf(pace?.text ?? "");
  if (reset && pace && together <= width) {
    const dot: Segment = { text: " · ", role: "reset", percent };
    lines.push({ id, segments: tag([under, resetSegment, dot, pace]) });
    return lines;
  }
  if (reset) lines.push({ id, segments: tag([under, resetSegment]) });
  if (pace) lines.push({ id, segments: [under, pace] });
  return lines;
}

/** `line` cut to `width` columns: the last guard that keeps every line inside the window. */
function clipped(line: Line, width: number): Line {
  const segments: Segment[] = [];
  let room = width;
  for (const segment of line.segments) {
    const text = sliceColumns(segment.text, Math.max(0, room));
    if (text) segments.push({ ...segment, text });
    room -= columnsOf(text);
  }
  return { id: line.id, segments };
}

/** The provider's line: its name and plan. */
function providerLine(group: Group): Line {
  const indent: Segment = { text: HEADING_INDENT, role: "label" };
  const name: Segment = { text: group.name, role: "provider", bold: true };
  const account: Segment[] = group.account ? [{ text: `  ${group.account}`, role: "account" }] : [];
  return { id: group.id, segments: [indent, name, ...account] };
}

export function limitsLines(input: LimitsInput): Line[] {
  const { snapshot, display, nowMs, width } = input;
  // Every row: the supplementary ones too, and none hidden.
  const words: Words = { ...(snapshot.words ?? DEFAULT_WORDS), detail: "detailed" };
  const sidebar = { ...display.surfaces.sidebar, hidden: [] };
  const settings: RowSettings = { ...display, surfaces: { ...display.surfaces, sidebar } };
  const groups = visibleGroups(snapshot, settings, "sidebar", {
    ...words,
    onlyCurrentModel: false,
  });
  if (groups.length === 0) {
    return [
      {
        id: "",
        segments: [
          { text: `${INDENT}No quota providers found. The Plugin tab says why.`, role: "value" },
        ],
      },
    ];
  }
  // Full names, exact times, the even-use marker and every pace, whatever the settings.
  const place: Place = {
    words,
    nowMs,
    names: "label",
    percent: "words",
    times: "exact",
    evenUse: true,
    pace: "all",
  };
  const facts = new Map(
    groups.map((group) => [group.id, group.rows.map((item) => rowFacts(item, group, place))]),
  );
  const grid = gridFor([...facts.values()].flat(), width);
  // With bars off elsewhere, Limits keeps a thin line: the even-use marker needs a bar.
  const shape = display.layout.bar === "none" ? "line" : display.layout.bar;
  return groups.flatMap((group, index) => {
    const lines: Line[] = index > 0 ? [{ id: "", segments: [] }] : [];
    lines.push(providerLine(group));
    const error = errorWords(group, nowMs);
    if (error) {
      lines.push({
        id: group.id,
        segments: [{ text: fit(`${INDENT}${error}`, width).trimEnd(), role: "error" }],
      });
    }
    for (const row of facts.get(group.id) ?? []) lines.push(...rowLines(row, grid, width, shape));
    return lines.map((line) => clipped(line, width));
  });
}
