/**
 * What the GUI's always-on surfaces show, from the quota snapshot and its settings
 * (`surface-settings.ts`). Pure. Every surface picks its providers and rows as its TUI
 * counterpart does, with the same helpers: `visibleGroups` for what a surface hides, its orders
 * and your row names, `pickRow` and `windowFor` for the one row a provider shows, and `rowFacts`
 * for each row's words.
 *
 * - The Quota panel is the TUI sidebar: `sidebar.*`, open; `collapsed.*`, folded.
 * - The titlebar pill is the collapsed sidebar: `collapsed.*`.
 * - The bottom strip is the status line (`view/text.ts` lays it out, as in the TUI).
 * - The composer pill is the status line's "one provider" detail, for the provider that serves
 *   the session's current model, with its pace.
 *
 * Colors follow the TUI's color settings: a role's named color is a CSS variable of the app's
 * theme (`style.ts`), a "#rrggbb" stays fixed, and "bar" takes the row's level color.
 */
import type { QuotaSnapshot } from "../core/types.js";
import type { Settings } from "../settings/schema.js";
import { barLevel, type Level, sessionTokensText } from "../view/format.js";
import { errorWords, type Place, type RowFacts, rowFacts } from "../view/row-facts.js";
import { type Group, pickRow, visibleGroups, windowFor } from "../view/select.js";
import { type ColorRole, lineText, lowCacheLine, type Segment } from "../view/text.js";
import { ROLE_THEME } from "./surface-settings.js";

export type SurfaceRow = RowFacts & {
  /** The bar's level; undefined for a row without a percent. */
  level?: Level;
};

/** One provider account on a surface. */
export type SurfaceGroup = {
  id: string;
  providerId: string;
  /** The provider's name ("Claude"). */
  name: string;
  /**
   * The name the one-row surfaces show: with its account ("Claude (work)") only when the surface
   * shows several accounts of the provider, as on the status line.
   */
  title: string;
  account?: string;
  /** Why its last check failed. */
  error?: string;
  /** Never checked yet. */
  unchecked: boolean;
  rows: SurfaceRow[];
};

/** A group with the one row a provider shows on the one-row surfaces. */
export type PickedGroup = Omit<SurfaceGroup, "rows"> & { row?: SurfaceRow };

export type PanelView = {
  groups: SurfaceGroup[];
  /** "12.3K in · 2.10K out" when `sidebar.sessionTokens` is on and the snapshot has them. */
  session?: string;
  /** "⚠ low cache: 35% (claude-sonnet-5)" for the session's model with a low cache hit. */
  lowCache?: string;
};

/** The longest low-cache line: the model's name is cut to fit it. */
const LOW_CACHE_WIDTH = 48;

/** How the always-on surfaces show rows, as `view/text.ts` shows them in the TUI. */
function alwaysOnPlace(
  settings: Settings,
  nowMs: number,
  percent: Place["percent"],
  pace: Place["pace"],
): Place {
  return {
    words: settings.words,
    nowMs,
    names: "words",
    percent,
    evenUse: settings.layout.evenUse,
    pace,
  };
}

function surfaceRow(settings: Settings, facts: RowFacts): SurfaceRow {
  if (facts.percent === undefined) return facts;
  return { ...facts, level: barLevel(settings.colors, facts.percent, facts.paceLevel) };
}

function surfaceGroup(groups: Group[], group: Group, nowMs: number): Omit<SurfaceGroup, "rows"> {
  const error = errorWords(group, nowMs);
  const accounts = groups.filter((other) => other.providerId === group.providerId).length;
  return {
    id: group.id,
    providerId: group.providerId,
    name: group.name,
    title: accounts > 1 ? group.title : group.name,
    ...(group.account === undefined ? {} : { account: group.account }),
    ...(error === undefined ? {} : { error }),
    unchecked: group.unchecked,
  };
}

/** The open Quota panel: the sidebar's providers and rows, then the session's tokens. */
export function panelView(snapshot: QuotaSnapshot, settings: Settings, nowMs: number): PanelView {
  const place = alwaysOnPlace(
    settings,
    nowMs,
    "number",
    settings.sidebar.runsOut ? "runsOut" : undefined,
  );
  const shown = visibleGroups(snapshot, settings, "sidebar", settings.words);
  const groups = shown.map((group) => ({
    ...surfaceGroup(shown, group, nowMs),
    rows: group.rows.map((item) => surfaceRow(settings, rowFacts(item, group, place))),
  }));
  const tokens = settings.sidebar.sessionTokens ? snapshot.sessionTokens : undefined;
  if (!tokens) return { groups };
  const lowCache = lowCacheLine(tokens.models ?? [], LOW_CACHE_WIDTH);
  return {
    groups,
    session: sessionTokensText(tokens),
    ...(lowCache ? { lowCache: lineText(lowCache) } : {}),
  };
}

/**
 * The one-row surfaces' providers (`collapsed`: the folded panel and the titlebar pill;
 * `statusLine`: the composer pill), each with the row its window setting picks, its percent as
 * the collapsed sidebar and the status line write it, and "runs out in" when that surface shows
 * it. `place` changes the percent and pace words, as the status line's "one" detail does.
 */
export function pickedGroups(
  snapshot: QuotaSnapshot,
  settings: Settings,
  surface: "collapsed" | "statusLine",
  nowMs: number,
  place: Partial<Pick<Place, "percent" | "pace">> = {},
): PickedGroup[] {
  const pace = "pace" in place ? place.pace : settings[surface].runsOut ? "runsOut" : undefined;
  const rowPlace = alwaysOnPlace(settings, nowMs, place.percent ?? "usedWord", pace);
  const shown = visibleGroups(snapshot, settings, surface, settings.words);
  return shown.map((group) => {
    const picked = pickRow(group, windowFor(settings[surface].window, group));
    return {
      ...surfaceGroup(shown, group, nowMs),
      ...(picked ? { row: surfaceRow(settings, rowFacts(picked, group, rowPlace)) } : {}),
    };
  });
}

/** The folded panel's title counts: providers (one per provider, any accounts) and errors. */
export function providerCounts(groups: readonly PickedGroup[]): {
  providers: number;
  errors: number;
} {
  const providers = new Set(groups.map((group) => group.providerId)).size;
  const errors = new Set(groups.filter((group) => group.error).map((group) => group.providerId))
    .size;
  return { providers, errors };
}

/**
 * The provider of the session's current model as the composer pill shows it: the first such
 * provider the status line shows, with the row its window setting picks, its percent with its
 * word, and every pace word.
 * Undefined when the snapshot doesn't say which providers serve the model, or none of them shows.
 */
export function currentModelPick(
  snapshot: QuotaSnapshot,
  settings: Settings,
  nowMs: number,
): PickedGroup | undefined {
  const current = snapshot.currentModelProviderIds;
  if (!current || current.length === 0) return undefined;
  const place = { percent: "words", pace: "all" } as const;
  return pickedGroups(snapshot, settings, "statusLine", nowMs, place).find((group) =>
    current.includes(group.providerId),
  );
}

/**
 * "Claude 30%": a one-row surface's text for a group, with its row's name when `withName`, then
 * its error or `unchecked` when it has no percent, then its pace words in parentheses.
 */
export function pickedText(group: PickedGroup, unchecked: string, withName = false): string {
  const { row } = group;
  const name = withName && row?.percent !== undefined ? `${group.title} ${row.name}` : group.title;
  if (!row || row.percent === undefined) {
    const state = group.error ?? (group.unchecked ? unchecked : row?.value);
    return state ? `${name} ${state}` : name;
  }
  const pace = row.pace ? ` (${row.pace.words})` : "";
  return `${name} ${row.value}${pace}`;
}

/**
 * The bottom strip shows: on Home, when `statusLine.home` is on; in a session, when the status
 * line is on and it shows next to the sidebar, or no Quota panel is on screen. As in the TUI.
 */
export function statusStripShows(
  settings: Settings,
  where: { home: boolean; panelOnScreen: boolean },
): boolean {
  if (where.home) return settings.statusLine.home;
  if (!settings.statusLine.show) return false;
  return settings.statusLine.withSidebar || !(where.panelOnScreen && settings.sidebar.show);
}

/**
 * The bottom strip's room in characters for its layout: the measured room, or, while the strip
 * has not been measured (0), room for every provider in full; the strip cuts what overflows.
 */
export function stripRoom(measured: number): number {
  return measured > 0 ? measured : Number.POSITIVE_INFINITY;
}

/** The composer pill's tone for a row's level. */
export function levelTone(level: Level | undefined): "success" | "warning" | "danger" | undefined {
  if (level === "good") return "success";
  if (level === "warning") return "warning";
  return level === "low" ? "danger" : undefined;
}

type ColorChoice = NonNullable<Settings["colors"]["good"]>;
type NamedColor = Exclude<(typeof ROLE_THEME)[ColorRole], "bar">;

const HEX = /^#[0-9a-f]{6}$/iu;

function namedCss(name: NamedColor): string {
  return `var(--oq-n-${name})`;
}

/** A fixed choice ("bar" is not one: the level roles can't follow themselves). */
function fixedCss(choice: ColorChoice, fallback: NamedColor): string {
  if (choice === "bar") return namedCss(fallback);
  if (choice.startsWith("#")) return HEX.test(choice) ? choice : namedCss(fallback);
  return namedCss(choice as NamedColor);
}

function choiceFor(settings: Settings, role: ColorRole): ColorChoice {
  return settings.colors[role] ?? ROLE_THEME[role];
}

/** The bar color for a percent left, by the row's pace when the bar colors follow pace. */
export function levelCss(settings: Settings, percent: number, paceLevel?: Level): string {
  const role = barLevel(settings.colors, percent, paceLevel);
  return fixedCss(choiceFor(settings, role), ROLE_THEME[role] as NamedColor);
}

/** A role's color. A role set to "bar" takes the level color of the row's percent. */
export function roleCss(
  settings: Settings,
  role: ColorRole,
  percent = 100,
  paceLevel?: Level,
): string {
  const choice = choiceFor(settings, role);
  return choice === "bar" ? levelCss(settings, percent, paceLevel) : fixedCss(choice, "text");
}

/** The color of one line segment of the bottom strip. */
export function segmentCss(settings: Settings, segment: Segment): string {
  return segment.role === "bar"
    ? levelCss(settings, segment.percent ?? 100, segment.paceLevel)
    : roleCss(settings, segment.role, segment.percent, segment.paceLevel);
}
