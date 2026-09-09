import { interpretAccountingRow } from "./accounting-format.js";
import { sanitizeQuotaRenderData, sanitizeSingleLineDisplayText } from "./display-sanitize.js";
import type { QuotaToastEntry, QuotaToastError } from "./entries.js";
import { isPercentEntry, isValueEntry } from "./entries.js";
import { formatDisplayedPercentLabel, formatResetCountdown } from "./format-utils.js";
import { formatGroupedHeader } from "./grouped-header-format.js";
import { extractSingleWindowWindowLabel } from "./quota-entry-display.js";
import type { QuotaRenderData } from "./quota-render-data.js";
import type { QuotaToastConfig } from "./types.js";

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
  const reset = formatResetCountdown(entry.resetTimeIso);
  const segment = [name, value, reset].filter(Boolean).join(" - ");
  return segment || null;
}

type CompactPercentGroup = {
  provider: string;
  windows: Array<{ label: string | null; value: string; isWindow: boolean }>;
};

type CompactCandidate = {
  segment: string;
  prominence: 0 | 1;
  detail?: string;
  atomic?: { prefix: string; value: string };
};

type PendingLegacySegment = { kind: "percent"; key: string } | { kind: "value"; segment: string };

function formatCompactPercentGroupSegment(group: CompactPercentGroup): string | null {
  const windows = group.windows;
  if (windows.length === 0) return null;

  const summary =
    windows.length === 1
      ? windows[0]!.label && !windows[0]!.isWindow
        ? `${windows[0]!.label} ${windows[0]!.value}`
        : windows[0]!.value
      : windows
          .map((window) => (window.label ? `${window.label} ${window.value}` : window.value))
          .join(COMPACT_WINDOW_SEPARATOR);

  const separator = windows.every((window) => window.label && !window.isWindow) ? ": " : " ";
  return compactText(`${group.provider}${separator}${summary}`);
}

function buildSemanticCandidate(
  entry: QuotaToastEntry,
  percentDisplayMode: QuotaToastConfig["percentDisplayMode"],
  accountingDetail: QuotaToastConfig["accountingDetail"],
): CompactCandidate | null {
  if (!entry.semantic) return null;
  const shouldRequestBasis =
    accountingDetail === "detailed" &&
    isPercentEntry(entry) &&
    Number.isFinite(entry.percentRemaining);
  const interpretation = interpretAccountingRow(entry, {
    booleanWording: "semantic",
    ...(shouldRequestBasis ? { basis: { kind: "detailed" } as const } : {}),
  });
  const value =
    interpretation.display.kind === "percent"
      ? Number.isFinite(interpretation.display.percentRemaining)
        ? formatCompactPercentLabel(interpretation.display.percentRemaining, percentDisplayMode)
        : null
      : interpretation.display.entryKind === "value"
        ? compactText(interpretation.display.text)
        : interpretation.display.text;
  if (!value) return null;

  const provider = getProviderName(entry);
  const label = compactText(interpretation.label);
  const prefix = compactText([provider, label].filter(Boolean).join(": "));
  const displayValue = compactText(
    [value, formatResetCountdown(entry.resetTimeIso)].filter(Boolean).join(" "),
  );
  const segment = compactText([prefix, displayValue].filter(Boolean).join(" "));
  if (!segment) return null;

  const detailRole = percentDisplayMode === "used" ? "used" : "remaining";
  const detail =
    interpretation.basis?.kind === "detailed"
      ? interpretation.basis.facts.find((fact) => fact.role === detailRole)?.text
      : undefined;
  return {
    segment,
    prominence: entry.semantic.prominence === "supplementary" ? 1 : 0,
    ...(detail ? { detail } : {}),
    ...(interpretation.display.kind === "value" && interpretation.display.entryKind !== "value"
      ? { atomic: { prefix, value: displayValue } }
      : {}),
  };
}

function formatCompactEntryCandidates(params: {
  entries: QuotaRenderData["entries"];
  percentDisplayMode: QuotaToastConfig["percentDisplayMode"];
  accountingDetail: QuotaToastConfig["accountingDetail"];
}): CompactCandidate[] {
  const semantic: CompactCandidate[] = [];
  const groups = new Map<string, CompactPercentGroup>();
  const pendingLegacy: PendingLegacySegment[] = [];

  for (const entry of params.entries) {
    if (entry.semantic) {
      const candidate = buildSemanticCandidate(
        entry,
        params.percentDisplayMode,
        params.accountingDetail,
      );
      if (candidate) semantic.push(candidate);
      continue;
    }

    if (isValueEntry(entry)) {
      const segment = formatCompactValueEntrySegment(entry);
      if (segment) pendingLegacy.push({ kind: "value", segment });
      continue;
    }
    if (!isPercentEntry(entry)) continue;

    const provider = getProviderName(entry);
    const value = compactText(
      [
        formatCompactPercentLabel(entry.percentRemaining, params.percentDisplayMode),
        formatResetCountdown(entry.resetTimeIso),
      ]
        .filter(Boolean)
        .join(" "),
    );
    const label = getWindowLabel(entry);
    const key = provider.toLowerCase();
    let group = groups.get(key);

    if (!group) {
      group = { provider, windows: [] };
      groups.set(key, group);
      pendingLegacy.push({ kind: "percent", key });
    }

    group.windows.push({
      label: label?.text ?? null,
      value,
      isWindow: label?.isWindow ?? false,
    });
  }

  const legacy = pendingLegacy
    .map((pending) =>
      pending.kind === "value"
        ? pending.segment
        : formatCompactPercentGroupSegment(groups.get(pending.key)!),
    )
    .filter((segment): segment is string => Boolean(segment))
    .map((segment): CompactCandidate => ({ segment, prominence: 0 }));

  return [...legacy, ...semantic]
    .map((candidate, index) => ({ candidate, index }))
    .sort(
      (left, right) =>
        left.candidate.prominence - right.candidate.prominence || left.index - right.index,
    )
    .map(({ candidate }) => candidate);
}

function fitAtomicCandidate(
  atomic: NonNullable<CompactCandidate["atomic"]>,
  maxWidth: number,
): string | null {
  if (atomic.value.length > maxWidth) return null;
  const full = compactText(`${atomic.prefix} ${atomic.value}`);
  if (full.length <= maxWidth) return full;

  const prefixWidth = maxWidth - atomic.value.length - 1;
  if (prefixWidth <= 0) return atomic.value;
  const prefix = truncateSingleLine(atomic.prefix, prefixWidth);
  return compactText(`${prefix} ${atomic.value}`);
}

function admitCompactCandidates(
  candidates: CompactCandidate[],
  maxWidth: number,
): CompactCandidate[] {
  const admitted: CompactCandidate[] = [];

  for (const candidate of candidates) {
    const separatorWidth = admitted.length > 0 ? COMPACT_SEGMENT_SEPARATOR.length : 0;
    const usedWidth = admitted.reduce(
      (total, item, index) =>
        total + item.segment.length + (index > 0 ? COMPACT_SEGMENT_SEPARATOR.length : 0),
      0,
    );
    const available = maxWidth - usedWidth - separatorWidth;
    if (available <= 0) continue;

    if (candidate.segment.length <= available) {
      admitted.push({ ...candidate });
      continue;
    }

    if (admitted.length > 0) continue;
    if (candidate.atomic) {
      const fitted = fitAtomicCandidate(candidate.atomic, available);
      if (fitted) admitted.push({ ...candidate, segment: fitted });
      continue;
    }
    const truncated = truncateSingleLine(candidate.segment, available);
    if (truncated) admitted.push({ ...candidate, segment: truncated });
  }

  return admitted;
}

function admitBasisDetails(candidates: CompactCandidate[], maxWidth: number): void {
  for (const candidate of candidates) {
    if (!candidate.detail) continue;
    const original = candidate.segment;
    candidate.segment = `${original} (${candidate.detail})`;
    const line = candidates.map((item) => item.segment).join(COMPACT_SEGMENT_SEPARATOR);
    if (line.length > maxWidth) candidate.segment = original;
  }
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
  accountingDetail?: QuotaToastConfig["accountingDetail"];
  maxWidth: number;
}): string {
  const maxWidth = normalizeMaxWidth(params.maxWidth);
  if (maxWidth === 0) return "";

  const data = sanitizeQuotaRenderData(params.data);
  const percentDisplayMode = params.percentDisplayMode ?? "remaining";
  const accountingDetail = params.accountingDetail ?? "summary";
  const candidates = formatCompactEntryCandidates({
    entries: data.entries,
    percentDisplayMode,
    accountingDetail,
  });
  const sessionTokensSegment = formatCompactSessionTokensSegment(data);
  if (sessionTokensSegment) {
    candidates.push({ segment: sessionTokensSegment, prominence: 0 });
  }

  const admitted = admitCompactCandidates(candidates, maxWidth);

  const issues = data.errors.filter((error) => error.kind !== "intentional-filter");
  if (issues.length > 0) {
    if (admitted.length === 0) {
      const errorSegment = formatFirstErrorSegment(issues);
      if (errorSegment) {
        return truncateSingleLine(errorSegment, maxWidth);
      }
    } else {
      const issueSegment = formatIssueCount(issues.length);
      const candidate = [...admitted.map((item) => item.segment), issueSegment].join(
        COMPACT_SEGMENT_SEPARATOR,
      );
      if (candidate.length <= maxWidth) {
        admitted.push({ segment: issueSegment, prominence: 0 });
      }
    }
  }

  if (accountingDetail === "detailed") admitBasisDetails(admitted, maxWidth);
  return admitted.map((candidate) => candidate.segment).join(COMPACT_SEGMENT_SEPARATOR);
}
