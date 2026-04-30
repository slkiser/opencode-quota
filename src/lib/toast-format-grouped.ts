/**
 * Grouped toast formatter.
 *
 * Renders quota entries grouped by provider/account with compact bars.
 * Designed to feel like a status dashboard while still respecting OpenCode toast width.
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
import { formatGroupedHeader } from "./grouped-header-format.js";
import { normalizeGroupedQuotaEntries } from "./grouped-entry-normalization.js";
import { renderSessionTokensLines } from "./session-tokens-format.js";

function normalizeLabelText(value?: string): string {
  return value?.trim().replace(/:+$/u, "").trim() ?? "";
}

function extractWindowLabel(text: string): string | null {
  const lower = normalizeLabelText(text).toLowerCase();
  if (!lower) return null;

  if (/\b(?:rpm|per minute|minute|minutes)\b/u.test(lower)) return "RPM";
  if (/\b(?:rolling|5h|5 h|5-hour|5 hour|five-hour|five hour)\b/u.test(lower)) return "5h";
  if (/\b(?:hourly|1h|1 h|1-hour|1 hour|hour)\b/u.test(lower)) return "Hourly";
  if (/\b(?:7d|7 d|7-day|7 day|weekly|week)\b/u.test(lower)) return "Weekly";
  if (/\b(?:daily|1d|1 d|1-day|1 day|day)\b/u.test(lower)) return "Daily";
  if (/\b(?:monthly|month)\b/u.test(lower)) return "Monthly";
  if (/\b(?:yearly|annual|annually|year)\b/u.test(lower)) return "Yearly";
  if (/\bmcp\b/u.test(lower)) return "MCP";
  if (/\bcode review\b/u.test(lower)) return "Code Review";

  return null;
}

function resolveGroupedRowLabel(entry: QuotaToastEntry): string {
  const fromLabel = extractWindowLabel(entry.label ?? "");
  if (fromLabel) return `${fromLabel} window`;

  const fromName = extractWindowLabel(entry.name);
  if (fromName) return `${fromName} window`;

  return "Quota window";
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
      .filter((entry) => !isValueEntry(entry))
      .map((entry) =>
        formatDisplayedPercentLabel(entry.percentRemaining, params.percentDisplayMode).length,
      ),
  );
  const barWidth = Math.max(10, maxWidth - separator.length - percentCol);
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
      const right = entry.right ? entry.right.trim() : "";

      if (isValueEntry(entry)) {
        const label = entry.label?.trim() || entry.name;
        const timeStr = formatResetCountdown(entry.resetTimeIso, { compactRounded: true });
        const value = entry.value.trim();

        if (isTiny) {
          // Tiny: "label  time  value"
          const valueCol = Math.min(value.length, Math.max(6, percentCol + 2));
          const tinyNameCol = Math.max(
            1,
            maxWidth - separator.length - timeCol - separator.length - valueCol,
          );
          const leftText = right ? `${label} ${right}` : label;
          const line = [
            padRight(leftText, tinyNameCol),
            padLeft(timeStr, timeCol),
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
        const leftText = right ? `${label} ${right}` : label;
        lines.push(
          (padRight(leftText, leftMax) +
            separator +
            padLeft(value, valueWidth) +
            separator +
            padLeft(timeStr, timeWidth)).slice(0, maxWidth),
        );
        continue;
      }

      const label = resolveGroupedRowLabel(entry);

      // Percent entries
      // Show reset countdown whenever quota is not fully available.
      // (i.e., any usage at all, or depleted)
      const timeStr =
        entry.percentRemaining < 100
          ? formatResetCountdown(entry.resetTimeIso, { compactRounded: true })
          : "";
      const displayedPercent = resolveDisplayedPercent(
        entry.percentRemaining,
        params.percentDisplayMode,
      );
      const percentLabel = formatDisplayedPercentLabel(
        entry.percentRemaining,
        params.percentDisplayMode,
      );

      if (isTiny) {
        // Tiny: "label  time  XX%" (ignore bar)
        const tinyNameCol = Math.max(
          1,
          maxWidth - separator.length - timeCol - separator.length - percentCol,
        );
        const line = [
          padRight(label, tinyNameCol),
          padLeft(timeStr, timeCol),
          padLeft(percentLabel, percentCol),
        ].join(separator);
        lines.push(line.slice(0, maxWidth));
        continue;
      }

      // Line 1: label + optional right + time at end
      const timeWidth = Math.max(timeStr.length, timeCol);
      const leftMax = Math.max(1, barWidth - separator.length - timeWidth);
      lines.push(
        (padRight(label, leftMax) + separator + padLeft(timeStr, timeWidth)).slice(0, barWidth),
      );

      // Line 2: bar + percent
      const barCell = bar(displayedPercent, barWidth);
      const percentCell = padLeft(percentLabel, percentCol);
      lines.push([barCell, percentCell].join(separator));
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
