import type { QuotaRenderData } from "./quota-render-data.js";
import type { QuotaToastConfig } from "./types.js";
import type { QuotaToastEntry, QuotaToastError } from "./entries.js";

import { isValueEntry } from "./entries.js";
import { formatDisplayedPercentLabel } from "./format-utils.js";
import { sanitizeQuotaRenderData, sanitizeSingleLineDisplayText } from "./display-sanitize.js";
import { extractSingleWindowWindowLabel } from "./quota-entry-display.js";
import { formatGroupedHeader } from "./grouped-header-format.js";

const COMPACT_SEGMENT_SEPARATOR = " | ";
const COMPACT_WINDOW_SEPARATOR = ", ";
const ELLIPSIS = "…";

function normalizeMaxWidth(maxWidth: number): number {
  if (!Number.isFinite(maxWidth)) return 96;
  return Math.max(0, Math.trunc(maxWidth));
}

function compactText(text: string): string {
  return sanitizeSingleLineDisplayText(text);
}

function truncateSingleLine(text: string, maxWidth: number): string {
  const width = normalizeMaxWidth(maxWidth);
  if (width === 0) return "";

  const singleLine = compactText(text);
  if (singleLine.length <= width) return singleLine;
  if (width === 1) return ELLIPSIS;
  return `${singleLine.slice(0, width - ELLIPSIS.length).trimEnd()}${ELLIPSIS}`;
}

function formatCompactPercentLabel(
  percentRemaining: number,
  mode: QuotaToastConfig["percentDisplayMode"],
): string {
  return formatDisplayedPercentLabel(percentRemaining, mode).split(" ")[0] ?? "0%";
}

function formatCompactDisplayName(name: string): string {
  return compactText(name.replace(/^\[([^\]]+)\](.*)$/u, "$1$2"));
}

function formatCompactProviderLabel(name: string): string {
  const compactName = formatCompactDisplayName(name);
  const withoutParentheticalPunctuation = compactName.replace(
    /\(([^)]*)\)/gu,
    (_match, inner: string) => {
      const normalized = inner.trim();
      if (!normalized) return "";
      if (/^personal$/iu.test(normalized)) return "";
      if (/^pro$/iu.test(normalized)) return " Pro";
      return ` (${normalized})`;
    },
  );

  return compactText(withoutParentheticalPunctuation)
    .replace(/\s{2,}/gu, " ")
    .trim();
}

function formatWindowLabel(label: string): string {
  const compactLabel = compactText(label.replace(/:+$/u, "").trim());
  return compactLabel.toLowerCase() === "weekly" ? "7d" : compactLabel;
}

function getBracketedProviderName(name: string): string | null {
  const match = /^\[([^\]]+)\]/u.exec(name.trim());
  return match?.[1]?.trim() || null;
}

function getProviderName(entry: QuotaToastEntry): string {
  const bracketedProvider = getBracketedProviderName(entry.name);
  if (bracketedProvider) return formatCompactProviderLabel(bracketedProvider);

  if (entry.group?.trim()) {
    const groupedPlan = entry.group.trim().match(/^\[([^\]]+)\]\s+(.+)$/u);
    if (groupedPlan) {
        const plan = groupedPlan[2]!.trim();
        const hasParens = plan.startsWith("(") && plan.endsWith(")");
        return hasParens
          ? `[${groupedPlan[1]!.trim()}] ${plan}`
          : `[${groupedPlan[1]!.trim()}] (${plan})`;
      }
    return formatCompactProviderLabel(formatGroupedHeader(entry.group));
  }

  return formatCompactProviderLabel(entry.name);
}

function getWindowLabel(entry: QuotaToastEntry): { text: string; isWindow: boolean } | null {
  const windowLabel =
    extractSingleWindowWindowLabel(entry.label ?? "") ?? extractSingleWindowWindowLabel(entry.name);
  if (windowLabel) return { text: formatWindowLabel(windowLabel), isWindow: true };

  const explicitLabel = entry.label?.trim().replace(/:+$/u, "").trim();
  return explicitLabel ? { text: compactText(explicitLabel), isWindow: false } : null;
}

function formatCompactValueEntrySegment(
  entry: Extract<QuotaToastEntry, { kind: "value" }>,
): string | null {
  const name = getProviderName(entry);
  const value = compactText(entry.value);
  const segment = [name, value].filter(Boolean).join(" - ");
  return segment || null;
}

type CompactPercentGroup = {
  provider: string;
  windows: Array<{ label: string | null; percent: string; isWindow: boolean }>;
};

type PendingCompactSegment = { kind: "percent"; key: string } | { kind: "value"; segment: string };

function formatCompactPercentGroupSegment(group: CompactPercentGroup): string | null {
  const windows = group.windows;
  if (windows.length === 0) return null;

  const summary =
    windows.length === 1
      ? windows[0]!.label && !windows[0]!.isWindow
        ? `${windows[0]!.label} ${windows[0]!.percent}`
        : windows[0]!.percent
      : windows
          .map((window) => (window.label ? `${window.label} ${window.percent}` : window.percent))
          .join(COMPACT_WINDOW_SEPARATOR);

  const hasOnlyCustomLabels = windows.every((window) => window.label && !window.isWindow);
  const separator = hasOnlyCustomLabels && !group.provider.startsWith("[") ? ": " : " ";
  return compactText(`${group.provider}${separator}${summary}`);
}

function formatCompactEntrySegments(params: {
  entries: QuotaRenderData["entries"];
  percentDisplayMode: QuotaToastConfig["percentDisplayMode"];
}): string[] {
  const groups = new Map<string, CompactPercentGroup>();
  const pendingSegments: PendingCompactSegment[] = [];

  for (const entry of params.entries) {
    if (isValueEntry(entry)) {
      const segment = formatCompactValueEntrySegment(entry);
      if (segment) pendingSegments.push({ kind: "value", segment });
      continue;
    }

    const provider = getProviderName(entry);
    const percent = formatCompactPercentLabel(entry.percentRemaining, params.percentDisplayMode);
    const label = getWindowLabel(entry);
    const key = provider.toLowerCase();
    let group = groups.get(key);

    if (!group) {
      group = { provider, windows: [] };
      groups.set(key, group);
      pendingSegments.push({ kind: "percent", key });
    }

    group.windows.push({
      label: label?.text ?? null,
      percent,
      isWindow: label?.isWindow ?? false,
    });
  }

  return pendingSegments
    .map((pending) =>
      pending.kind === "value"
        ? pending.segment
        : formatCompactPercentGroupSegment(groups.get(pending.key)!),
    )
    .filter((segment): segment is string => Boolean(segment));
}

function formatCompactTokenCount(count: number): string {
  if (!Number.isFinite(count)) return "0";
  if (Math.abs(count) >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1).replace(/\.0$/u, "")}M`;
  }
  if (Math.abs(count) >= 1_000) {
    return `${(count / 1_000).toFixed(1).replace(/\.0$/u, "")}K`;
  }
  return String(Math.trunc(count));
}

function formatCompactSessionTokensSegment(data: QuotaRenderData): string | null {
  const sessionTokens = data.sessionTokens;
  if (!sessionTokens) return null;

  const hasTokenData =
    sessionTokens.models.length > 0 ||
    sessionTokens.totalInput > 0 ||
    (sessionTokens.totalCachedInput ?? 0) > 0 ||
    sessionTokens.totalOutput > 0;
  if (!hasTokenData) return null;

  const totalCached = sessionTokens.totalCachedInput ?? 0;
  const inputSegment =
    totalCached > 0
      ? `${formatCompactTokenCount(sessionTokens.totalInput)} (${formatCompactTokenCount(totalCached)})`
      : formatCompactTokenCount(sessionTokens.totalInput);

  return compactText(
    `tok ${inputSegment} in / ${formatCompactTokenCount(sessionTokens.totalOutput)} out`,
  );
}

function formatIssueCount(count: number): string {
  return `+${count} issue${count === 1 ? "" : "s"}`;
}

function formatFirstErrorSegment(errors: QuotaToastError[]): string | null {
  const first = errors[0];
  if (!first) return null;

  const firstError = compactText(`${first.label}: ${first.message}`);
  if (errors.length === 1) return firstError;
  return compactText(`${firstError} +${errors.length - 1}`);
}

export function buildCompactQuotaStatusLine(params: {
  data: QuotaRenderData;
  percentDisplayMode?: QuotaToastConfig["percentDisplayMode"];
  maxWidth: number;
}): string {
  const maxWidth = normalizeMaxWidth(params.maxWidth);
  if (maxWidth === 0) return "";

  const data = sanitizeQuotaRenderData(params.data);
  const percentDisplayMode = params.percentDisplayMode ?? "remaining";
  const segments = formatCompactEntrySegments({ entries: data.entries, percentDisplayMode });

  const sessionTokensSegment = formatCompactSessionTokensSegment(data);
  if (sessionTokensSegment) {
    segments.push(sessionTokensSegment);
  }

  if (data.errors.length > 0) {
    if (segments.length === 0) {
      const errorSegment = formatFirstErrorSegment(data.errors);
      if (errorSegment) segments.push(errorSegment);
    } else {
      const issueSegment = formatIssueCount(data.errors.length);
      const candidate = [...segments, issueSegment].join(COMPACT_SEGMENT_SEPARATOR);
      if (compactText(candidate).length <= maxWidth) {
        segments.push(issueSegment);
      }
    }
  }

  return truncateSingleLine(segments.join(COMPACT_SEGMENT_SEPARATOR), maxWidth);
}
