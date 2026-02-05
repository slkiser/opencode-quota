/**
 * Grouped toast formatter.
 *
 * Renders quota entries grouped by provider/account with compact bars.
 * Designed to feel like a status dashboard while still respecting OpenCode toast width.
 */

import type { QuotaToastEntry, QuotaToastError, SessionTokensData } from "./entries.js";
import {
  bar,
  clampInt,
  formatResetCountdown,
  formatTokenCount,
  padLeft,
  padRight,
  shortenModelName,
} from "./format-utils.js";

export type ToastGroupEntry = QuotaToastEntry & {
  /** Group id (e.g. "OpenAI (Pro)", "Antigravity (abc..gmail)") */
  group?: string;
  /** Row label within group (e.g. "Hourly", "Weekly", "Claude") */
  label?: string;
  /** Optional right-side suffix (e.g. "94/250") */
  right?: string;
};

function splitGroupName(name: string): { group: string; label: string } {
  // Heuristic: "Label (group)" -> group is label, label is empty.
  // Prefer explicit group/label metadata when available.
  return { group: name, label: "" };
}

export function formatQuotaRowsGrouped(params: {
  layout?: {
    maxWidth: number;
    narrowAt: number;
    tinyAt: number;
  };
  entries?: ToastGroupEntry[];
  errors?: QuotaToastError[];
  sessionTokens?: SessionTokensData;
}): string {
  const layout = params.layout ?? { maxWidth: 50, narrowAt: 42, tinyAt: 32 };
  const maxWidth = layout.maxWidth;
  const isTiny = maxWidth <= layout.tinyAt;
  const isNarrow = !isTiny && maxWidth <= layout.narrowAt;

  const separator = "  ";
  const percentCol = 4;
  const barWidth = Math.max(10, maxWidth - separator.length - percentCol);
  const timeCol = isTiny ? 6 : isNarrow ? 7 : 7;

  const lines: string[] = [];

  // Group entries in stable order.
  const groupOrder: string[] = [];
  const groups = new Map<string, ToastGroupEntry[]>();
  for (const e of params.entries ?? []) {
    const group = (e.group ?? "").trim();
    const label = (e.label ?? "").trim();
    if (!group) {
      const fallback = splitGroupName(e.name);
      const g = fallback.group;
      const list = groups.get(g);
      if (list) list.push({ ...e, group: g, label: label || fallback.label });
      else {
        groupOrder.push(g);
        groups.set(g, [{ ...e, group: g, label: label || fallback.label }]);
      }
      continue;
    }
    const list = groups.get(group);
    if (list) list.push(e);
    else {
      groupOrder.push(group);
      groups.set(group, [e]);
    }
  }

  for (let gi = 0; gi < groupOrder.length; gi++) {
    const g = groupOrder[gi]!;
    const list = groups.get(g) ?? [];
    if (gi > 0) lines.push("");

    // Group header like "→ [OpenAI] (Pro)"
    lines.push(`→ ${g}`.slice(0, maxWidth));

    for (const entry of list) {
      const label = entry.label?.trim() || entry.name;
      // Show reset countdown whenever quota is not fully available.
      // (i.e., any usage at all, or depleted)
      const timeStr = entry.percentRemaining < 100 ? formatResetCountdown(entry.resetTimeIso) : "";
      const right = entry.right ? entry.right.trim() : "";

      if (isTiny) {
        // Tiny: "label  time  XX%" (ignore bar)
        const tinyNameCol = maxWidth - separator.length - timeCol - separator.length - percentCol;
        const line = [
          padRight(label, tinyNameCol),
          padLeft(timeStr, timeCol),
          padLeft(`${clampInt(entry.percentRemaining, 0, 100)}%`, percentCol),
        ].join(separator);
        lines.push(line.slice(0, maxWidth));
        continue;
      }

      // Line 1: label + optional right + time at end
      const timeWidth = Math.max(timeStr.length, timeCol);
      const leftMax = Math.max(1, barWidth - separator.length - timeWidth);
      const leftText = right ? `${label} ${right}` : label;
      lines.push(
        (padRight(leftText, leftMax) + separator + padLeft(timeStr, timeWidth)).slice(0, barWidth),
      );

      // Line 2: bar + percent
      const barCell = bar(entry.percentRemaining, barWidth);
      const percentCell = padLeft(`${clampInt(entry.percentRemaining, 0, 100)}%`, percentCol);
      lines.push([barCell, percentCell].join(separator));
    }
  }

  for (const err of params.errors ?? []) {
    if (lines.length > 0) lines.push("");
    lines.push(`${err.label}: ${err.message}`);
  }

  // Add session token summary (if data available and non-empty)
  if (params.sessionTokens && params.sessionTokens.models.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Session Tokens");

    for (const model of params.sessionTokens.models) {
      // Shorten model name for compact display
      const shortName = shortenModelName(model.modelID, 20);
      const inStr = formatTokenCount(model.input);
      const outStr = formatTokenCount(model.output);
      lines.push(
        `  ${padRight(shortName, 20)}  ${padLeft(inStr, 6)} in  ${padLeft(outStr, 6)} out`,
      );
    }
  }

  return lines.join("\n");
}
