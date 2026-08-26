/**
 * Grouped toast formatter.
 *
 * Renders quota entries grouped by provider/account with compact bars.
 * Designed to feel like a status dashboard while still respecting OpenCode toast width.
 */

import { interpretAccountingRow } from "./accounting-format.js";
import type { QuotaToastEntry, QuotaToastError, SessionTokensData } from "./entries.js";
import { isPercentEntry } from "./entries.js";
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
import { normalizeGroupedQuotaEntries } from "./grouped-entry-normalization.js";
import { formatGroupedHeader } from "./grouped-header-format.js";
import { classifyQuotaWindowText, type QuotaWindowKind } from "./quota-entry-display.js";
import { renderSessionTokensLines } from "./session-tokens-format.js";
import type { QuotaToastConfig } from "./types.js";

function normalizeLabelText(value?: string): string {
  return value?.trim().replace(/:+$/u, "").trim() ?? "";
}

const GROUPED_WINDOW_LABELS: Readonly<Record<QuotaWindowKind, string>> = {
  rpm: "RPM",
  five_hour: "Five-hour",
  hour: "Hourly",
  week: "Weekly",
  day: "Daily",
  month: "Monthly",
  year: "Yearly",
  mcp: "MCP",
  code_review: "Code Review",
};

function extractWindowLabel(text: string): string | null {
  const kind = classifyQuotaWindowText(text);
  return kind ? GROUPED_WINDOW_LABELS[kind] : null;
}

function resolveGroupedRowLabel(entry: QuotaToastEntry, semanticLabel: string): string {
  if (entry.semantic) return semanticLabel;

  const rawLabel = normalizeLabelText(entry.label);
  const fromLabel = extractWindowLabel(rawLabel);
  if (fromLabel) return fromLabel;
  if (rawLabel) return rawLabel;

  const metricLabel = normalizeLabelText(entry.metricLabel);
  const fromMetricLabel = extractWindowLabel(metricLabel);
  if (fromMetricLabel) return fromMetricLabel;
  if (metricLabel) return metricLabel;

  const fromName = extractWindowLabel(entry.name);
  if (fromName) return fromName;

  return normalizeLabelText(entry.group) || "Quota window";
}

export function formatQuotaRowsGrouped(params: {
  layout?: {
    maxWidth: number;
    narrowAt: number;
    tinyAt: number;
  };
  entries?: QuotaToastEntry[];
  errors?: QuotaToastError[];
  percentDisplayMode?: QuotaToastConfig["percentDisplayMode"];
  accountingDetail?: QuotaToastConfig["accountingDetail"];
  resetTimeDecimals?: number;
  sessionTokens?: SessionTokensData;
}): string {
  const layout = params.layout ?? { maxWidth: 50, narrowAt: 42, tinyAt: 32 };
  const maxWidth = layout.maxWidth;
  const isTiny = maxWidth <= layout.tinyAt;
  const isNarrow = !isTiny && maxWidth <= layout.narrowAt;

  const separator = "  ";
  const percentCol = Math.max(
    DISPLAYED_PERCENT_LABEL_WIDTH,
    ...(params.entries ?? [])
      .filter(isPercentEntry)
      .map(
        (entry) =>
          formatDisplayedPercentLabel(entry.percentRemaining, params.percentDisplayMode).length,
      ),
  );
  const percentValueCol = percentCol;
  const barWidth = Math.max(10, maxWidth - separator.length - percentValueCol);
  const timeCol = isTiny ? 6 : isNarrow ? 7 : 7;

  const lines: string[] = [];

  // Group entries in stable order.
  const groupOrder: string[] = [];
  const groups = new Map<string, QuotaToastEntry[]>();
  for (const entry of normalizeGroupedQuotaEntries(params.entries ?? [], "toast")) {
    const list = groups.get(entry.group);
    if (list) list.push(entry);
    else {
      groupOrder.push(entry.group);
      groups.set(entry.group, [entry]);
    }
  }

  for (let gi = 0; gi < groupOrder.length; gi++) {
    const g = groupOrder[gi]!;
    const list = groups.get(g) ?? [];
    if (gi > 0) lines.push("");

    lines.push(formatGroupedHeader(g).slice(0, maxWidth));

    for (const entry of list) {
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
      const right = entry.right ? entry.right.trim() : "";

      if (interpretation.display.kind === "value") {
        const isAtomicValue = interpretation.display.entryKind !== "value";
        const label = entry.semantic ? interpretation.label : entry.label?.trim() || entry.name;
        const timeStr = entry.resetTimeIso
          ? formatResetCountdown(
              entry.resetTimeIso,
              isResetTimeDecimals(params.resetTimeDecimals)
                ? { compactRounded: true, decimals: params.resetTimeDecimals }
                : undefined,
            )
          : "";
        const value =
          interpretation.display.entryKind === "value"
            ? interpretation.display.text.trim()
            : interpretation.display.text;
        const leftText = right ? `${label} ${right}` : label;
        const labelAndValue = [leftText, value].filter(Boolean).join(separator);
        if (
          timeStr &&
          labelAndValue.length <= maxWidth &&
          labelAndValue.length + separator.length + timeStr.length > maxWidth
        ) {
          lines.push(labelAndValue);
          lines.push(padLeft(timeStr, maxWidth));
          continue;
        }

        if (isAtomicValue) {
          const suffix = [value, timeStr].filter(Boolean).join(separator);
          if (suffix.length > maxWidth) {
            if (value.length <= maxWidth) lines.push(padLeft(value, maxWidth));
            continue;
          }
          const availableLabelWidth = maxWidth - (suffix ? separator.length + suffix.length : 0);
          if (availableLabelWidth <= 0) {
            lines.push(padLeft(suffix, maxWidth));
            continue;
          }
          const leftText = label.slice(0, availableLabelWidth).trimEnd();
          lines.push(
            `${padRight(leftText, availableLabelWidth)}${suffix ? `${separator}${suffix}` : ""}`,
          );
          continue;
        }

        if (isTiny) {
          // Tiny: "label  time  value"
          const timeWidth = Math.max(timeCol, timeStr.length);
          const valueCol = Math.min(value.length, Math.max(6, percentCol + 2));
          const tinyNameCol = Math.max(
            1,
            maxWidth - separator.length - timeWidth - separator.length - valueCol,
          );
          const leftText = right ? `${label} ${right}` : label;
          const line = [
            padRight(leftText, tinyNameCol),
            padLeft(timeStr, timeWidth),
            padLeft(value, valueCol),
          ].join(separator);
          lines.push(line.slice(0, maxWidth));
          continue;
        }

        // Non-tiny: single line (no bar)
        const timeWidth = Math.max(timeStr.length, timeCol);
        const valueWidth = Math.max(value.length, 6);
        const leftMax = Math.max(
          1,
          barWidth - separator.length - valueWidth - separator.length - timeWidth,
        );
        lines.push(
          (
            padRight(leftText, leftMax) +
            separator +
            padLeft(value, valueWidth) +
            separator +
            padLeft(timeStr, timeWidth)
          ).slice(0, maxWidth),
        );
        continue;
      }
      const label = resolveGroupedRowLabel(entry, interpretation.label);

      // A "value row" has no explicit label and carries a `right` summary to be
      // shown instead of a name. When present, the `right` is justified to the
      // edges of line 1 (left + right) and no reset countdown is shown.
      const isValueRow =
        !entry.label?.trim() && !entry.metricLabel?.trim() && !!entry.right?.trim();
      const displayedPercent = resolveDisplayedPercent(
        interpretation.display.percentRemaining,
        params.percentDisplayMode,
      );
      const percentLabel = formatDisplayedPercentLabel(
        interpretation.display.percentRemaining,
        params.percentDisplayMode,
      );

      // Percent entries
      // Show reset countdown whenever quota is not fully available.
      // (i.e., any usage at all, or depleted)
      const timeStr =
        interpretation.display.percentRemaining < 100
          ? formatResetCountdown(
              entry.resetTimeIso,
              isResetTimeDecimals(params.resetTimeDecimals)
                ? { compactRounded: true, decimals: params.resetTimeDecimals }
                : undefined,
            )
          : "";

      if (isTiny) {
        // Tiny: single line with name/time/percent (or just the right summary)
        const timeWidth = Math.max(timeCol, timeStr.length);
        const visibleBarSuffix = percentLabel.slice(0, percentValueCol);
        if (isValueRow) {
          const tinyNameCol = Math.max(
            1,
            maxWidth - separator.length - timeWidth - separator.length - percentValueCol,
          );
          const line = [
            padRight(entry.right!.trim(), tinyNameCol),
            padLeft(timeStr, timeWidth),
            padLeft(visibleBarSuffix, percentValueCol),
          ].join(separator);
          lines.push(line.slice(0, maxWidth));
          continue;
        }
        const tinyNameCol = Math.max(
          1,
          maxWidth - separator.length - timeWidth - separator.length - percentValueCol,
        );
        const line = [
          padRight(label, tinyNameCol),
          padLeft(timeStr, timeWidth),
          padLeft(visibleBarSuffix, percentValueCol),
        ].join(separator);
        lines.push(line.slice(0, maxWidth));
        continue;
      }

      if (isValueRow) {
        // Line 1: right summary. Two segments -> justified to the edges;
        // a single segment -> right-aligned. No name, no reset.
        const text = entry.right!.trim();
        const parts = text.split(/\s{2,}/u).filter(Boolean);
        if (parts.length >= 2) {
          const left = parts[0] ?? "";
          const rightText = parts.slice(1).join("  ");
          const sep = "  ";
          const leftWidth = Math.max(1, maxWidth - sep.length - rightText.length);
          lines.push((padRight(left, leftWidth) + sep + rightText).slice(0, maxWidth));
        } else {
          lines.push(padLeft(text, maxWidth));
        }
      } else {
        // Line 1: label + time at end
        const timeWidth = Math.max(timeStr.length, timeCol);
        const leftMax = Math.max(1, maxWidth - separator.length - timeWidth);
        lines.push(
          (padRight(label, leftMax) + separator + padLeft(timeStr, timeWidth)).slice(0, maxWidth),
        );
      }

      // Line 2: bar + percent
      const barCell = bar(displayedPercent, barWidth);
      const suffixCell = padLeft(percentLabel.slice(0, percentValueCol), percentValueCol);
      lines.push([barCell, suffixCell].join(separator));

      if (interpretation.basis) {
        const candidates =
          interpretation.basis.kind === "detailed"
            ? interpretation.basis.facts.map((fact) => fact.text)
            : interpretation.basis.text
              ? [interpretation.basis.text]
              : [];
        let detailLine = "";
        for (const candidate of candidates) {
          const next = detailLine ? `${detailLine} | ${candidate}` : candidate;
          if (next.length > maxWidth) break;
          detailLine = next;
        }
        if (detailLine) lines.push(detailLine);
      }
    }
  }

  for (const err of params.errors ?? []) {
    if (lines.length > 0) lines.push("");
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
