import type { QuotaToastEntry } from "./entries.js";

export type GroupedRenderTarget = "toast" | "quota";

export type NormalizedGroupedQuotaEntry = QuotaToastEntry & {
  group: string;
  rankOverride?: number;
  groupSortOverride?: number;
};

export type QuotaEntryGroup = {
  group: string;
  entries: NormalizedGroupedQuotaEntry[];
};

type RankedGroupedQuotaEntry = {
  entry: NormalizedGroupedQuotaEntry;
  originalIndex: number;
  rank: number | null;
};

function trimOptional(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeDurationText(value?: string): string | undefined {
  const trimmed = trimOptional(value);
  return trimmed?.replace(/:+$/u, "").trim().toLowerCase();
}

function looksLikeGoogleModel(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "claude" || lower === "g3pro" || lower === "g3flash" || lower === "g3image" || lower === "gpt-oss";
}

function getGoogleFallbackMeta(name: string): { group: string; label: string } | undefined {
  const match = name.match(/^(.+?)\s*\((.+)\)\s*$/);
  if (!match) return undefined;

  const model = match[1]!.trim();
  const account = match[2]!.trim();
  if (!looksLikeGoogleModel(model) || !account) return undefined;

  return {
    group: `Google Antigravity (${account})`,
    label: `${model}:`,
  };
}

function getDurationRankFromText(value?: string): number | null {
  const text = normalizeDurationText(value);
  if (!text) return null;

  if (/\b(?:rpm|per minute|minute|minutes)\b/u.test(text)) return 1;
  if (/\b(?:rolling|5h|5 h|5-hour|5 hour|five-hour|five hour)\b/u.test(text)) return 300;
  if (/\b(?:hourly|1h|1 h|1-hour|1 hour|hour)\b/u.test(text)) return 60;
  if (/\b(?:7d|7 d|7-day|7 day|weekly|week)\b/u.test(text)) return 10080;
  if (/\b(?:daily|1d|1 d|1-day|1 day|day)\b/u.test(text)) return 1440;
  if (/\b(?:monthly|month)\b/u.test(text)) return 43200;
  if (/\b(?:yearly|annual|annually|year)\b/u.test(text)) return 525600;

  return null;
}

function getDurationRank(entry: NormalizedGroupedQuotaEntry): number | null {
  if (entry.rankOverride !== undefined) return entry.rankOverride;
  return entry.label ? getDurationRankFromText(entry.label) : getDurationRankFromText(entry.name);
}

function normalizeGroupedQuotaEntry(
  entry: QuotaToastEntry,
  target: GroupedRenderTarget,
): NormalizedGroupedQuotaEntry {
  const group = trimOptional(entry.group);
  const label = trimOptional(entry.label);
  const right = trimOptional(entry.right);
  const normalized = {
    ...entry,
    ...(label ? { label } : {}),
    ...(right ? { right } : {}),
  };

  if (group) {
    return { ...normalized, group };
  }

  const googleFallback = getGoogleFallbackMeta(entry.name);
  if (googleFallback) {
    return {
      ...normalized,
      group: googleFallback.group,
      ...(label || target === "quota" ? { label: label ?? googleFallback.label } : {}),
    };
  }

  return {
    ...normalized,
    group: entry.name.trim(),
    ...(target === "quota" ? { label: label ?? "Status:" } : {}),
  };
}

export function groupQuotaEntries(
  entries: QuotaToastEntry[],
  target: GroupedRenderTarget,
): QuotaEntryGroup[] {
  const groupOrder: string[] = [];
  const groupedEntries = new Map<string, RankedGroupedQuotaEntry[]>();
  const groupSortOverrides = new Map<string, number | undefined>();

  for (const [originalIndex, entry] of entries.entries()) {
    const normalizedEntry = normalizeGroupedQuotaEntry(entry, target);
    const rankedEntry: RankedGroupedQuotaEntry = {
      entry: normalizedEntry,
      originalIndex,
      rank: getDurationRank(normalizedEntry),
    };
    const groupName = normalizedEntry.group;
    const existing = groupedEntries.get(groupName);
    if (existing) {
      existing.push(rankedEntry);
      continue;
    }

    groupOrder.push(groupName);
    groupedEntries.set(groupName, [rankedEntry]);
    groupSortOverrides.set(groupName, normalizedEntry.groupSortOverride);
  }

  const sortedGroupOrder = groupOrder.slice().sort((a, b) => {
    const aOverride = groupSortOverrides.get(a);
    const bOverride = groupSortOverrides.get(b);
    if (aOverride !== undefined && bOverride !== undefined && aOverride !== bOverride) {
      return aOverride - bOverride;
    }
    if (aOverride !== undefined && bOverride === undefined) return -1;
    if (aOverride === undefined && bOverride !== undefined) return 1;
    return groupOrder.indexOf(a) - groupOrder.indexOf(b);
  });

  return sortedGroupOrder.map((group) => {
    const rankedEntries = groupedEntries.get(group) ?? [];
    const entries = rankedEntries
      .slice()
      .sort((left, right) => {
        if (left.rank !== null && right.rank !== null && left.rank !== right.rank) {
          return left.rank - right.rank;
        }
        if (left.rank !== null && right.rank === null) return -1;
        if (left.rank === null && right.rank !== null) return 1;
        return left.originalIndex - right.originalIndex;
      })
      .map(({ entry }) => entry);

    return { group, entries };
  });
}

export function normalizeGroupedQuotaEntries(
  entries: QuotaToastEntry[],
  target: GroupedRenderTarget,
): NormalizedGroupedQuotaEntry[] {
  return groupQuotaEntries(entries, target).flatMap((group) => group.entries);
}
