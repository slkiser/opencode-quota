/**
 * Formatting helpers for quota toast output
 */

import type { QuotaToastConfig } from "./types.js";
import type { QuotaToastEntry, QuotaToastError, SessionTokensData } from "./entries.js";
import { isValueEntry } from "./entries.js";
import {
  bar,
  DISPLAYED_PERCENT_LABEL_WIDTH,
  formatDisplayedPercentLabel,
  formatResetCountdown,
  padLeft,
  padRight,
  resolveDisplayedPercent,
} from "./format-utils.js";
import { formatQuotaRowsGrouped } from "./toast-format-grouped.js";
import { renderSessionTokensLines } from "./session-tokens-format.js";

export function formatQuotaRows(params: {
  version: string;
  layout?: {
    maxWidth: number;
    narrowAt: number;
    tinyAt: number;
  };
  entries?: QuotaToastEntry[];
  errors?: QuotaToastError[];
  style?: "classic" | "grouped";
  percentDisplayMode?: QuotaToastConfig["percentDisplayMode"];
  sessionTokens?: SessionTokensData;
}): string {
  if (params.style === "grouped") {
    return formatQuotaRowsGrouped({
      layout: params.layout,
      entries: params.entries,
      errors: params.errors,
      percentDisplayMode: params.percentDisplayMode,
      sessionTokens: params.sessionTokens,
    });
  }

  const layout = params.layout ?? { maxWidth: 50, narrowAt: 42, tinyAt: 32 };
  const maxWidth = layout.maxWidth;

  // Responsive columns.
  // - default: name + time on one line, then bar on next line
  // - narrow: shorter name/time cols
  // - tiny: no bars, just "Name  time  XX%"
  const isTiny = maxWidth <= layout.tinyAt;
  const isNarrow = !isTiny && maxWidth <= layout.narrowAt;

  const separator = "  ";
  const percentCol = DISPLAYED_PERCENT_LABEL_WIDTH; // "100% used"

  const timeCol = isTiny ? 6 : isNarrow ? 7 : 7;

  // Bar width: use most of maxWidth, leaving room for separator + percent on line 2
  // Line 1 (name + time) spans exactly barWidth
  // Line 2 (bar + percent) spans barWidth + separator + percentCol
  const barWidth = Math.max(10, maxWidth - separator.length - percentCol);

  const lines: string[] = [];

  const addPercentEntry = (
    name: string,
    resetIso: string | undefined,
    remaining: number,
    rightSummary?: string,
  ) => {
    const displayedPercent = resolveDisplayedPercent(remaining, params.percentDisplayMode);
    const percentLabel = formatDisplayedPercentLabel(remaining, params.percentDisplayMode);
    const summary = rightSummary?.trim() || "";
    const leftText = summary ? `${name} ${summary}` : name;

    // Show reset countdown whenever quota is not fully available.
    // (i.e., any usage at all, or depleted)
    const timeStr = remaining < 100 ? formatResetCountdown(resetIso, { missing: "-" }) : "";

    if (isTiny) {
      // In tiny mode: single line with name + time + percent
      const tinyNameCol = maxWidth - separator.length - timeCol - separator.length - percentCol;
      const line = [
        padRight(leftText, tinyNameCol),
        padLeft(timeStr, timeCol),
        padLeft(percentLabel, percentCol),
      ].join(separator);
      lines.push(line.slice(0, maxWidth));
      return;
    }

    // Line 1: label + time (total width = barWidth only)
    // Time is right-aligned to end of bar
    const timeWidth = Math.max(timeStr.length, timeCol);
    const nameWidth = Math.max(1, barWidth - separator.length - timeWidth);
    const timeLine = padRight(leftText, nameWidth) + separator + padLeft(timeStr, timeWidth);
    lines.push(timeLine.slice(0, barWidth));

    // Line 2: bar + percent (percent extends beyond bar width)
    const barCell = bar(displayedPercent, barWidth);
    const percentCell = padLeft(percentLabel, percentCol);
    const barLine = [barCell, percentCell].join(separator);
    lines.push(barLine);
  };

  const addValueEntry = (name: string, resetIso: string | undefined, value: string) => {
    const timeStr = formatResetCountdown(resetIso, { missing: "-" });

    if (isTiny) {
      // Tiny: single line without percent; keep time col alignment.
      const valueCol = Math.min(value.length, Math.max(6, percentCol + 2));
      const tinyNameCol =
        maxWidth - separator.length - timeCol - separator.length - valueCol;
      const nameCol = Math.max(1, tinyNameCol);
      const line = [
        padRight(name, nameCol),
        padLeft(timeStr, timeCol),
        padLeft(value, valueCol),
      ].join(separator);
      lines.push(line.slice(0, maxWidth));
      return;
    }

    const right = value;
    const rightWidth = Math.max(right.length, 6);
    const timeWidth = Math.max(timeStr.length, timeCol);
    const leftWidth = Math.max(
      1,
      maxWidth - separator.length - rightWidth - separator.length - timeWidth,
    );
    const line =
      padRight(name, leftWidth) +
      separator +
      padLeft(right, rightWidth) +
      separator +
      padLeft(timeStr, timeWidth);
    lines.push(line.slice(0, maxWidth));
  };

  for (const entry of params.entries ?? []) {
    if (isValueEntry(entry)) {
      addValueEntry(entry.name, entry.resetTimeIso, entry.value);
    } else {
      addPercentEntry(entry.name, entry.resetTimeIso, entry.percentRemaining, entry.right);
    }
  }

  // Add error rows (rendered as "label: message")
  for (const err of params.errors ?? []) {
    lines.push(`${err.label}: ${err.message}`);
  }

  // Add session token summary (if data available and non-empty)
  const tokenLines = renderSessionTokensLines(params.sessionTokens, { maxWidth });
  if (tokenLines.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(...tokenLines);
  }

  return lines.join("\n");
}
