/**
 * Which providers and rows a surface shows, in which order and under which names. Pure:
 * every surface (TUI, Web text, CLI) picks its rows here from the snapshot and the display
 * settings.
 */
import type {
  ProviderSnapshot,
  QuotaError,
  QuotaRow,
  QuotaSnapshot,
  QuotaWindow,
  Words,
} from "../core/types.js";
import { ALL_PROVIDERS } from "../core/windows.js";

export type Surface = "sidebar" | "collapsed" | "statusLine" | "toast";

/** What one surface shows. Ids not named in an order follow in the snapshot's order. */
export type SurfaceRows = {
  enabled: boolean;
  /** Names selected from this surface's tab. */
  names?: Record<string, string>;
  /** Provider ids and row ids this surface leaves out. */
  hidden: string[];
  providerOrder: string[];
  /** Row ids per provider id. */
  rowOrder: Record<string, string[]>;
};

/** The window a provider shows in the collapsed sidebar and the status line. */
export type WindowChoice = "lowest" | QuotaWindow;

/** The part of the display settings that picks rows. */
export type RowSettings = {
  /** Your names for rows, by row id. */
  labels: Record<string, string>;
  surfaces: Record<Surface, SurfaceRows>;
  /**
   * Preferred window by provider id, and by `ALL_PROVIDERS` for every other provider; "lowest"
   * (the default) shows the row with the least left.
   */
  window: Record<string, WindowChoice>;
};

/** A row as a place shows it: `label` is your name for it, or its own; `named` says you named it. */
export type VisibleRow = { row: QuotaRow; label: string; named: boolean };

/** `row` under your name for it in `names`, else its own label. */
export function visibleRow(row: QuotaRow, names: Readonly<Record<string, string>>): VisibleRow {
  const name = names[row.id];
  return { row, label: name ?? row.label, named: name !== undefined };
}

/** One provider account on a surface: its title, its rows, and its last error. */
export type Group = {
  /** Provider id, or `${providerId} (account)` when it has several accounts. */
  id: string;
  providerId: string;
  /** "Claude" or "Claude (work)". */
  title: string;
  name: string;
  account?: string;
  rows: VisibleRow[];
  error?: QuotaError;
  /** True before the provider was ever checked. */
  unchecked: boolean;
};

/** `ids` first in the given order, then the rest in their own order. */
export function ordered<T>(
  items: readonly T[],
  idOf: (item: T) => string,
  order: readonly string[],
): T[] {
  const rank = new Map(order.map((id, index) => [id, index]));
  return items
    .map((item, index) => ({ item, index, rank: rank.get(idOf(item)) ?? order.length + index }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ item }) => item);
}

/**
 * A provider's rows, one group per account in the order the accounts first appear. The
 * provider's last error shows once, on its first shown group: the one the collapsed sidebar,
 * the status line and the big bar show first. A failed check can't be told apart by account
 * (a custom source that failed has none), so the other accounts keep their rows without it.
 */
function groupsOf(provider: ProviderSnapshot, rows: VisibleRow[], hadRows: boolean): Group[] {
  const accounts = [...new Set(provider.rows.map((row) => row.account))];
  if (accounts.length === 0) accounts.push(undefined);
  const several = accounts.length > 1;
  const unchecked = provider.checkedAtMs === undefined && provider.rows.length === 0;
  const group = (account: string | undefined, own: VisibleRow[]): Group => ({
    id:
      several && account !== undefined
        ? `${provider.providerId} (${account})`
        : provider.providerId,
    providerId: provider.providerId,
    title: account ? `${provider.label} (${account})` : provider.label,
    name: provider.label,
    ...(account === undefined ? {} : { account }),
    rows: own,
    unchecked,
  });
  const groups = accounts
    .map((account) =>
      group(
        account,
        rows.filter((item) => item.row.account === account),
      ),
    )
    // An account whose rows are all hidden is left out.
    .filter((item) => !hadRows || item.rows.length > 0);
  if (!provider.error) return groups;
  // Every row hidden: the error still shows, on a line of the provider's own.
  const [first = group(several ? undefined : accounts[0], []), ...rest] = groups;
  return [{ ...first, error: provider.error }, ...rest];
}

/** The providers and rows `surface` shows, in order, with your row names. */
export function visibleGroups(
  snapshot: QuotaSnapshot,
  settings: RowSettings,
  surface: Surface,
  words: Words,
): Group[] {
  const shown = settings.surfaces[surface];
  const hidden = new Set(shown.hidden);
  const currentModel = words.onlyCurrentModel ? snapshot.currentModelProviderIds : undefined;
  const rowPrefixes = words.onlyCurrentModel ? snapshot.currentModelRowPrefixes : undefined;
  const providers = ordered(
    snapshot.providers,
    (provider) => provider.providerId,
    shown.providerOrder,
  ).filter(
    (provider) =>
      !hidden.has(provider.providerId) &&
      (currentModel === undefined || currentModel.includes(provider.providerId)),
  );
  return providers.flatMap((provider) => {
    // A provider whose rows serve different models shows only those of the current one.
    const prefixes = rowPrefixes?.[provider.providerId];
    const rows = ordered(provider.rows, (row) => row.id, shown.rowOrder[provider.providerId] ?? [])
      .filter((row) => !hidden.has(row.id))
      .filter(
        (row) => prefixes === undefined || prefixes.some((prefix) => row.id.startsWith(prefix)),
      )
      .filter((row) => words.detail === "detailed" || row.prominence === "primary")
      .map((row) => visibleRow(row, shown.names ?? settings.labels));
    return groupsOf(provider, rows, provider.rows.length > 0);
  });
}

/**
 * The window a group shows in the collapsed sidebar or the status line, and the one its Settings
 * ‹ › shows: its provider's own pick; else the pick for all providers when one of its rows with a
 * percent has that window; else "lowest" (where `pickRow` would fall back anyway).
 */
export function windowFor(
  windows: Readonly<Record<string, WindowChoice>>,
  group: Pick<Group, "providerId" | "rows">,
): WindowChoice {
  const all = windows[ALL_PROVIDERS];
  const hasAll = group.rows.some(
    ({ row }) => row.percentRemaining !== undefined && row.window === all,
  );
  return windows[group.providerId] ?? (all !== undefined && hasAll ? all : "lowest");
}

/**
 * The one row a group shows in the collapsed sidebar and the status line: the preferred
 * window's row; with "lowest", or when the group has no row of that window, the row with the
 * least left; else the first row.
 */
export function pickRow(
  group: Pick<Group, "rows">,
  choice: WindowChoice = "lowest",
): VisibleRow | undefined {
  const withPercent = group.rows.filter((item) => item.row.percentRemaining !== undefined);
  const preferred = withPercent.find((item) => choice !== "lowest" && item.row.window === choice);
  if (preferred) return preferred;
  const primary = withPercent.filter((item) => item.row.prominence === "primary");
  const candidates = primary.length > 0 ? primary : withPercent;
  const lowest = [...candidates].sort(
    (a, b) => (a.row.percentRemaining as number) - (b.row.percentRemaining as number),
  )[0];
  return lowest ?? group.rows[0];
}
