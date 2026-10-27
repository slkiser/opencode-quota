/**
 * What the usage window's Limits view shows, from the quota snapshot: one card per provider
 * account with its rows, its error and the "serves the current model" mark; the session's
 * tokens; and when the providers were last checked. Pure.
 *
 * Providers and rows come from `visibleGroups` with the sidebar's order and your row names, as
 * the TUI's Limits tab picks them, but with `words.detail` and `words.onlyCurrentModel` as set.
 * Each row's words come from `rowFacts` with full names, the reset words, the even-use mark when
 * `layout.evenUse` is on, and every pace word; its bar level from `barLevel`.
 */
import type { QuotaSnapshot, Words } from "../core/types.js";
import { barLevel, DEFAULT_WORDS, formatTokens, type Level } from "../view/format.js";
import { errorWords, type Place, type RowFacts, rowFacts } from "../view/row-facts.js";
import { type RowSettings, type SurfaceRows, visibleGroups } from "../view/select.js";

/** The settings the usage window reads, from the snapshot's settings, else their defaults. */
export type GuiDisplay = {
  words: Words;
  colors: { levelBy: "left" | "pace"; warningBelow: number; lowBelow: number };
  evenUse: boolean;
  rows: RowSettings;
};

export type LimitRow = RowFacts & {
  /** The bar's level; undefined for a row without a percent. */
  level?: Level;
  /** When it resets, for a row with a percent and a reset time. */
  resetsAtMs?: number;
};

export type LimitCard = {
  id: string;
  providerId: string;
  name: string;
  account?: string;
  /** Why the provider's last check failed. */
  error?: string;
  /** The provider serves the session's current model; false when the snapshot doesn't say. */
  current: boolean;
  rows: LimitRow[];
};

export type SessionStrip = {
  /** True when the counts include the session's subagents (`words.sessionTokens` "tree"). */
  tree: boolean;
  input: string;
  cached: string;
  output: string;
};

const DEFAULT_COLORS: GuiDisplay["colors"] = { levelBy: "left", warningBelow: 50, lowBelow: 20 };

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecordOf<T>(
  value: unknown,
  item: (entry: unknown) => entry is T,
): value is Record<string, T> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(item)
  );
}

const isString = (value: unknown): value is string => typeof value === "string";

function percentSetting(value: unknown, fallback: number): number {
  return typeof value === "number" && value >= 0 && value <= 100 ? value : fallback;
}

/** The sidebar's rows from the settings values: what it hides, its orders and your names. */
function sidebarRows(values: Record<string, unknown>): SurfaceRows {
  const hidden = values["sidebar.hidden"];
  const providerOrder = values["sidebar.providerOrder"];
  const rowOrder = values["sidebar.rowOrder"];
  const names = values["sidebar.names"];
  return {
    hidden: isStringList(hidden) ? hidden : [],
    providerOrder: isStringList(providerOrder) ? providerOrder : [],
    rowOrder: isRecordOf(rowOrder, isStringList) ? rowOrder : {},
    names: isRecordOf(names, isString) ? names : {},
  };
}

/** The settings the window reads: the snapshot's words and settings values, else the defaults. */
export function displayOf(snapshot: QuotaSnapshot | undefined): GuiDisplay {
  const values = snapshot?.settings?.values ?? {};
  const levelBy = values["colors.levelBy"];
  const lowBelow = percentSetting(values["colors.lowBelow"], DEFAULT_COLORS.lowBelow);
  const sidebar = sidebarRows(values);
  const empty: SurfaceRows = { hidden: [], providerOrder: [], rowOrder: {} };
  return {
    words: snapshot?.words ?? DEFAULT_WORDS,
    colors: {
      levelBy: levelBy === "pace" ? "pace" : "left",
      // "Getting low" is never below "almost out", as the server keeps it.
      warningBelow: Math.max(
        lowBelow,
        percentSetting(values["colors.warningBelow"], DEFAULT_COLORS.warningBelow),
      ),
      lowBelow,
    },
    evenUse: values["layout.evenUse"] !== false,
    rows: { sidebar, collapsed: empty, statusLine: empty, toast: empty },
  };
}

/**
 * The cards of the Limits view, in the sidebar's order; with `providerId`, that provider's only.
 * Nothing the sidebar hides is left out here: the window shows every provider and row.
 */
export function limitCards(
  snapshot: QuotaSnapshot,
  display: GuiDisplay,
  nowMs: number,
  providerId?: string,
): LimitCard[] {
  const { words } = display;
  const rows: RowSettings = { ...display.rows, sidebar: { ...display.rows.sidebar, hidden: [] } };
  const place: Place = {
    words,
    nowMs,
    names: "label",
    percent: "words",
    evenUse: display.evenUse,
    pace: "all",
  };
  const current = new Set(snapshot.currentModelProviderIds ?? []);
  return visibleGroups(snapshot, rows, "sidebar", words)
    .filter((group) => providerId === undefined || group.providerId === providerId)
    .map((group) => {
      const error = errorWords(group, nowMs);
      return {
        id: group.id,
        providerId: group.providerId,
        name: group.name,
        ...(group.account === undefined ? {} : { account: group.account }),
        ...(error === undefined ? {} : { error }),
        current: current.has(group.providerId),
        rows: group.rows.map((item) => {
          const facts = rowFacts(item, group, place);
          if (facts.percent === undefined) return facts;
          const resetsAtMs = Date.parse(item.row.resetsAt ?? "");
          return {
            ...facts,
            level: barLevel(display.colors, facts.percent, facts.paceLevel),
            ...(Number.isFinite(resetsAtMs) ? { resetsAtMs } : {}),
          };
        }),
      };
    });
}

/** The providers the Limits view can filter by, in the snapshot's order: [id, name]. */
export function limitProviders(snapshot: QuotaSnapshot): Array<[string, string]> {
  return snapshot.providers.map((provider) => [provider.providerId, provider.label]);
}

/** The session's tokens, when the snapshot has them (it does for a watched session). */
export function sessionStrip(snapshot: QuotaSnapshot, words: Words): SessionStrip | undefined {
  const tokens = snapshot.sessionTokens;
  if (!tokens) return undefined;
  return {
    tree: words.sessionTokens === "tree",
    input: formatTokens(tokens.input),
    cached: formatTokens(tokens.cachedInput),
    output: formatTokens(tokens.output),
  };
}

/** When the providers were last checked: the latest check of any of them. */
export function lastCheckedMs(snapshot: QuotaSnapshot): number | undefined {
  const checked = snapshot.providers
    .map((provider) => provider.checkedAtMs)
    .filter((ms): ms is number => ms !== undefined);
  return checked.length > 0 ? Math.max(...checked) : undefined;
}
