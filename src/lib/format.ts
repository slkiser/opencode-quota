/**
 * Formatting helpers for quota toast output
 */

import type { QuotaToastConfig } from "./types.js";
import type { QuotaToastEntry, QuotaToastError, SessionTokensData } from "./entries.js";
import type { QuotaFormatStyle } from "./quota-format-style.js";
import { isValueEntry } from "./entries.js";
import {
  bar,
  DISPLAYED_PERCENT_LABEL_WIDTH,
  formatDisplayedPercentLabel,
  formatResetCountdown,
  isResetTimeDecimals,
  padLeft,
  padRight,
  resolveDisplayedPercent,
} from "./format-utils.js";
import { formatQuotaRowsGrouped } from "./toast-format-grouped.js";
import {
  renderSessionTokensLines,
  renderSidebarSessionTokenSummaryLines,
} from "./session-tokens-format.js";
import { getQuotaFormatStyleDefinition } from "./quota-format-style.js";
import { buildSingleWindowPercentEntryDisplayName } from "./quota-entry-display.js";

function buildClassicNameTimeLine(params: {
  leftText: string;
  timeStr: string;
  maxWidth: number;
  separator: string;
  preferredTimeWidth: number;
}): string {
  if (!params.timeStr) {
    return params.leftText.slice(0, params.maxWidth);
  }

  let timeWidth = Math.max(params.timeStr.length, params.preferredTimeWidth);
  const preferredNameWidth = params.maxWidth - params.separator.length - timeWidth;
  const compactLineWidth = params.leftText.length + params.separator.length + params.timeStr.length;
  if (params.leftText.length > preferredNameWidth && compactLineWidth <= params.maxWidth) {
    timeWidth = params.timeStr.length;
  }

  const nameWidth = Math.max(1, params.maxWidth - params.separator.length - timeWidth);
  return (
    padRight(params.leftText, nameWidth) +
    params.separator +
    padLeft(params.timeStr, timeWidth)
  ).slice(0, params.maxWidth);
}

function buildClassicValueLine(params: {
  name: string;
  value: string;
  timeStr: string;
  maxWidth: number;
  separator: string;
  preferredValueWidth: number;
  preferredTimeWidth: number;
}): string {
  let valueWidth = Math.max(params.value.length, params.preferredValueWidth);
  let timeWidth = Math.max(params.timeStr.length, params.preferredTimeWidth);
  const preferredNameWidth =
    params.maxWidth - params.separator.length - valueWidth - params.separator.length - timeWidth;
  const compactLineWidth =
    params.name.length +
    params.separator.length +
    params.value.length +
    params.separator.length +
    params.timeStr.length;

  if (params.name.length > preferredNameWidth && compactLineWidth <= params.maxWidth) {
    valueWidth = params.value.length;
    timeWidth = params.timeStr.length;
  }

  const nameWidth = Math.max(
    1,
    params.maxWidth - params.separator.length - valueWidth - params.separator.length - timeWidth,
  );
  return (
    padRight(params.name, nameWidth) +
    params.separator +
    padLeft(params.value, valueWidth) +
    params.separator +
    padLeft(params.timeStr, timeWidth)
  ).slice(0, params.maxWidth);
}

export function formatQuotaRows(params: {
  version: string;
  layout?: {
    maxWidth: number;
    narrowAt: number;
    tinyAt: number;
  };
  entries?: QuotaToastEntry[];
  errors?: QuotaToastError[];
  style?: QuotaFormatStyle;
  percentDisplayMode?: QuotaToastConfig["percentDisplayMode"];
  resetTimeDecimals?: number;
  sessionTokens?: SessionTokensData;
}): string {
  const styleDefinition = getQuotaFormatStyleDefinition(params.style);

  if (styleDefinition.renderer === "grouped") {
    return formatQuotaRowsGrouped({
      layout: params.layout,
      entries: params.entries,
      errors: params.errors,
      percentDisplayMode: params.percentDisplayMode,
      resetTimeDecimals: params.resetTimeDecimals,
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
  const percentCol = Math.max(
    DISPLAYED_PERCENT_LABEL_WIDTH,
    ...(params.entries ?? [])
      .filter((entry) => !isValueEntry(entry))
      .map(
        (entry) =>
          formatDisplayedPercentLabel(entry.percentRemaining, params.percentDisplayMode).length,
      ),
  );

  const timeCol = isTiny ? 6 : isNarrow ? 7 : 7;

  // Bar width: use most of maxWidth, leaving room for separator + percent on line 2.
  // Line 1 (name + time) can use full maxWidth so labels are not cut before the
  // sidebar width is exhausted.
  // Line 2 (bar + percent) spans barWidth + separator + percentCol.
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
    const timeStr =
      remaining < 100
        ? formatResetCountdown(resetIso, {
            missing: "-",
            compactRounded: true,
            decimals: params.resetTimeDecimals,
          })
        : "";

    if (isTiny) {
      // In tiny mode: single line with name + time + percent
      const timeWidth = isResetTimeDecimals(params.resetTimeDecimals)
        ? Math.max(timeCol, timeStr.length)
        : timeCol;
      const tinyNameCol = Math.max(
        1,
        maxWidth - separator.length - timeWidth - separator.length - percentCol,
      );
      const line = [
        padRight(leftText, tinyNameCol),
        padLeft(timeStr, timeWidth),
        padLeft(percentLabel, percentCol),
      ].join(separator);
      lines.push(line.slice(0, maxWidth));
      return;
    }

    // Line 1: label + time can use the full available width. Prefer keeping the
    // reset text aligned, but shrink padding before truncating labels that fit.
    lines.push(
      buildClassicNameTimeLine({
        leftText,
        timeStr,
        maxWidth,
        separator,
        preferredTimeWidth: timeCol,
      }),
    );

    // Line 2: bar + percent (percent extends beyond bar width)
    const barCell = bar(displayedPercent, barWidth);
    const percentCell = padLeft(percentLabel, percentCol);
    const barLine = [barCell, percentCell].join(separator);
    lines.push(barLine);
  };

  const addValueEntry = (name: string, resetIso: string | undefined, value: string) => {
    const timeStr = formatResetCountdown(resetIso, {
      missing: "-",
      compactRounded: true,
      decimals: params.resetTimeDecimals,
    });

    if (isTiny) {
      // Tiny: single line without percent; keep time col alignment.
      const timeWidth = isResetTimeDecimals(params.resetTimeDecimals)
        ? Math.max(timeCol, timeStr.length)
        : timeCol;
      const valueCol = Math.min(value.length, Math.max(6, percentCol + 2));
      const tinyNameCol = maxWidth - separator.length - timeWidth - separator.length - valueCol;
      const nameCol = Math.max(1, tinyNameCol);
      const line = [
        padRight(name, nameCol),
        padLeft(timeStr, timeWidth),
        padLeft(value, valueCol),
      ].join(separator);
      lines.push(line.slice(0, maxWidth));
      return;
    }

    lines.push(
      buildClassicValueLine({
        name,
        value,
        timeStr,
        maxWidth,
        separator,
        preferredValueWidth: 6,
        preferredTimeWidth: timeCol,
      }),
    );
  };

  for (const entry of params.entries ?? []) {
    if (isValueEntry(entry)) {
      addValueEntry(entry.name, entry.resetTimeIso, entry.value);
    } else {
      addPercentEntry(
        buildSingleWindowPercentEntryDisplayName(entry),
        entry.resetTimeIso,
        entry.percentRemaining,
        entry.right,
      );
    }
  }

  // Add error rows (rendered as "label: message")
  for (const err of params.errors ?? []) {
    lines.push(`${err.label}: ${err.message}`);
  }

  // Add session token section (if data available and non-empty)
  const tokenLines =
    styleDefinition.sessionTokens === "detailed"
      ? renderSessionTokensLines(params.sessionTokens, { maxWidth })
      : renderSidebarSessionTokenSummaryLines(params.sessionTokens, { maxWidth });
  if (tokenLines.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(...tokenLines);
  }

  return lines.join("\n");
}
