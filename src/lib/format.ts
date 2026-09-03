/**
 * Formatting helpers for quota toast output
 */

import { type AccountingRowInterpretation, interpretAccountingRow } from "./accounting-format.js";
import type { QuotaToastEntry, QuotaToastError, SessionTokensData } from "./entries.js";
import { isPercentEntry } from "./entries.js";
import {
  bar,
  displayedPercentLabelWidth,
  formatDisplayedPercentLabel,
  formatResetCountdown,
  isResetTimeDecimals,
  padLeft,
  padRight,
  resolveDisplayedPercent,
} from "./format-utils.js";
import { buildSingleWindowPercentEntryDisplayName } from "./quota-entry-display.js";
import type { QuotaFormatStyle } from "./quota-format-style.js";
import { getQuotaFormatStyleDefinition } from "./quota-format-style.js";
import {
  renderSessionTokensLines,
  renderSidebarSessionTokenSummaryLines,
} from "./session-tokens-format.js";
import { formatQuotaRowsGrouped } from "./toast-format-grouped.js";
import type { QuotaToastConfig } from "./types.js";

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
  percentLabelStyle?: QuotaToastConfig["percentLabelStyle"];
  accountingDetail?: QuotaToastConfig["accountingDetail"];
  resetTimeDecimals?: number;
  resetTimeSpaced?: boolean;
  sessionTokens?: SessionTokensData;
}): string {
  const styleDefinition = getQuotaFormatStyleDefinition(params.style);

  if (styleDefinition.renderer === "grouped") {
    return formatQuotaRowsGrouped({
      layout: params.layout,
      entries: params.entries,
      errors: params.errors,
      percentDisplayMode: params.percentDisplayMode,
      percentLabelStyle: params.percentLabelStyle,
      accountingDetail: params.accountingDetail,
      resetTimeDecimals: params.resetTimeDecimals,
      resetTimeSpaced: params.resetTimeSpaced,
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
    displayedPercentLabelWidth(params.percentLabelStyle),
    ...(params.entries ?? [])
      .filter(isPercentEntry)
      .map(
        (entry) =>
          formatDisplayedPercentLabel(
            entry.percentRemaining,
            params.percentDisplayMode,
            params.percentLabelStyle,
          ).length,
      ),
  );

  const percentValueCol = percentCol;
  const timeCol = isTiny ? 6 : isNarrow ? 7 : 7;

  // Bar width: use most of maxWidth, leaving room for separator + suffix on line 2.
  // Line 1 (name + time) can use full maxWidth so labels are not cut before the
  // sidebar width is exhausted.
  // Line 2 (bar + suffix) spans barWidth + separator + percentValueCol.
  const barWidth = Math.max(10, maxWidth - separator.length - percentValueCol);

  const lines: string[] = [];

  const addPercentEntry = (
    name: string,
    resetIso: string | undefined,
    remaining: number,
    rightSummary?: string,
  ) => {
    const displayedPercent = resolveDisplayedPercent(remaining, params.percentDisplayMode);
    const percentLabel = formatDisplayedPercentLabel(
      remaining,
      params.percentDisplayMode,
      params.percentLabelStyle,
    );
    const visibleBarSuffix = percentLabel.slice(0, percentValueCol);
    const summary = rightSummary?.trim() || "";
    const leftText = summary ? `${name} ${summary}` : name;

    // Show reset countdown whenever quota is not fully available.
    // (i.e., any usage at all, or depleted)
    const timeStr =
      remaining < 100
        ? formatResetCountdown(
            resetIso,
            isResetTimeDecimals(params.resetTimeDecimals)
              ? {
                  missing: "-",
                  compactRounded: true,
                  decimals: params.resetTimeDecimals,
                }
              : { missing: "-", spaced: params.resetTimeSpaced },
          )
        : "";

    if (isTiny) {
      // In tiny mode: single line with name + time + percent
      const timeWidth = Math.max(timeCol, timeStr.length);
      const tinyNameCol = Math.max(
        1,
        maxWidth - separator.length - timeWidth - separator.length - percentValueCol,
      );
      const line = [
        padRight(leftText, tinyNameCol),
        padLeft(timeStr, timeWidth),
        padLeft(visibleBarSuffix, percentValueCol),
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

    // Line 2: bar + displayed percentage
    const barCell = bar(displayedPercent, barWidth);
    const suffixCell = padLeft(visibleBarSuffix, percentValueCol);
    const barLine = [barCell, suffixCell].join(separator);
    lines.push(barLine);
  };

  const addValueEntry = (
    name: string,
    resetIso: string | undefined,
    value: string,
    atomicValue = false,
  ) => {
    const timeStr =
      atomicValue && !resetIso
        ? ""
        : formatResetCountdown(
            resetIso,
            isResetTimeDecimals(params.resetTimeDecimals)
              ? {
                  missing: "-",
                  compactRounded: true,
                  decimals: params.resetTimeDecimals,
                }
              : { missing: "-", spaced: params.resetTimeSpaced },
          );

    if (atomicValue) {
      const suffix = [value, timeStr].filter(Boolean).join(separator);
      const nameAndValue = [name, value].filter(Boolean).join(separator);
      if (
        timeStr &&
        nameAndValue.length <= maxWidth &&
        nameAndValue.length + separator.length + timeStr.length > maxWidth
      ) {
        lines.push(nameAndValue);
        lines.push(padLeft(timeStr, maxWidth));
        return;
      }
      if (suffix.length > maxWidth) {
        const visibleValue =
          value.length <= maxWidth
            ? padLeft(value, maxWidth)
            : maxWidth <= 1
              ? "…".slice(0, maxWidth)
              : `…${value.slice(-(maxWidth - 1))}`;
        lines.push(visibleValue);
        return;
      }
      const availableNameWidth = maxWidth - (suffix ? separator.length + suffix.length : 0);
      if (availableNameWidth <= 0) {
        lines.push(padLeft(suffix, maxWidth));
        return;
      }
      const visibleName = name.slice(0, availableNameWidth).trimEnd();
      lines.push(
        `${padRight(visibleName, availableNameWidth)}${suffix ? `${separator}${suffix}` : ""}`,
      );
      return;
    }

    const nameAndValue = [name, value].filter(Boolean).join(separator);
    if (
      timeStr &&
      nameAndValue.length <= maxWidth &&
      nameAndValue.length + separator.length + timeStr.length > maxWidth
    ) {
      lines.push(nameAndValue);
      lines.push(padLeft(timeStr, maxWidth));
      return;
    }

    if (isTiny) {
      // Tiny: single line without percent; keep time col alignment.
      const timeWidth = Math.max(timeCol, timeStr.length);
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

  const addBasisLine = (basis: AccountingRowInterpretation["basis"]) => {
    if (!basis) return;
    const candidates =
      basis.kind === "detailed"
        ? basis.facts.map((fact) => fact.text)
        : basis.text
          ? [basis.text]
          : [];
    let line = "";
    for (const candidate of candidates) {
      const next = line ? `${line} | ${candidate}` : candidate;
      if (next.length > maxWidth) break;
      line = next;
    }
    if (line) lines.push(line);
  };

  for (const entry of params.entries ?? []) {
    const interpretation = interpretAccountingRow(entry, {
      booleanWording: "semantic",
      ...(!isTiny
        ? {
            basis:
              (params.accountingDetail ?? "summary") === "detailed"
                ? ({ kind: "detailed" } as const)
                : ({
                    kind: "summary",
                    mode: params.percentDisplayMode ?? "remaining",
                  } as const),
          }
        : {}),
    });
    const name = entry.semantic
      ? [entry.name.trim(), interpretation.label]
          .filter((part, index, parts) => Boolean(part) && parts.indexOf(part) === index)
          .join(" ")
      : isPercentEntry(entry)
        ? buildSingleWindowPercentEntryDisplayName(entry)
        : entry.name;
    if (interpretation.display.kind === "value") {
      addValueEntry(
        name,
        entry.resetTimeIso,
        interpretation.display.text,
        interpretation.display.entryKind !== "value",
      );
    } else {
      addPercentEntry(
        name,
        entry.resetTimeIso,
        interpretation.display.percentRemaining,
        entry.right,
      );
      addBasisLine(interpretation.basis);
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
