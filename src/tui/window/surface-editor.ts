/**
 * The provider tree of a Settings surface page (Sidebar, Collapsed, Status line, Toast): its
 * lines, and the edits the page's keys, clicks and drags make to the display settings. A provider
 * moves with its rows; a row moves only among its own provider's rows. Pure.
 */
import type { ProviderSnapshot, QuotaRow, QuotaSnapshot } from "../../core/types.js";
import { errorWords, type Place, rowFacts } from "../../view/row-facts.js";
import {
  type Group,
  ordered,
  pickRow,
  type Surface,
  visibleRow,
  type WindowChoice,
  windowFor,
} from "../../view/select.js";
import { type DisplaySettings, renameRow, type SettingsTab, setIn, stepIn } from "../display.js";

/** A change of the display settings, as `DisplayStore.edit` makes it. */
export type SettingsEdit = (settings: DisplaySettings) => DisplaySettings;

/**
 * One line of the tree: a provider, or one of its rows on a page that shows rows. `detail` is
 * what the page shows of it ("3% left · 2h"), its error, or why it shows nothing; `window` is what
 * its ‹ › shows (only a provider with two windows or more, on Collapsed and Status line); `hidden`
 * is an unticked line; `muted` a line that it, its provider or the surface switch leaves out.
 */
export type TreeLine = {
  id: string;
  providerId: string;
  row: boolean;
  /** A row that is its provider's last one (└, not ├). */
  last: boolean;
  label: string;
  detail: string;
  window?: WindowChoice;
  hidden: boolean;
  muted: boolean;
};

export type SurfaceEditor = ReturnType<typeof surfaceEditor>;

/** A provider and its rows (one per row id: the first account's), in the surface's order. */
type TreeProvider = { provider: ProviderSnapshot; rows: QuotaRow[] };

/** Sidebar and Toast list each provider's rows under it; Collapsed and Status line don't. */
export function showsRows(page: SettingsTab): boolean {
  return page === "sidebar" || page === "toast";
}

/** The windows ‹ › steps through: lowest, then the group's own; none for fewer than two. */
function windowChoices(group: Pick<Group, "rows">): WindowChoice[] {
  const windows = group.rows.flatMap(({ row }) =>
    row.window && row.percentRemaining !== undefined ? [row.window] : [],
  );
  const unique = [...new Set(windows)];
  return unique.length > 1 ? ["lowest", ...unique] : [];
}

/** A provider's rows that `hidden` leaves on the page, as one group: its window and summary. */
function shownGroup(provider: ProviderSnapshot, hidden: readonly string[]) {
  const rows = provider.rows.filter((row) => !hidden.includes(row.id));
  return { providerId: provider.providerId, rows: rows.map((row) => visibleRow(row, {})) };
}

/**
 * The tree and edits of `surface`'s page. Without a snapshot the tree is empty, so only the
 * surface switch and the ticks edit anything. Each edit reads the settings it is given.
 */
export function surfaceEditor(surface: Surface, snapshot?: QuotaSnapshot) {
  const withRows = showsRows(surface);
  // Toast has its own row names and Status line its own windows; the other pages use Sidebar's
  // names and Collapsed's windows.
  const namesKey = surface === "toast" ? "toast" : "sidebar";
  const windowsKey = surface === "statusLine" ? "statusLine" : "collapsed";

  function tree(settings: DisplaySettings): TreeProvider[] {
    const { providerOrder, rowOrder } = settings.surfaces[surface];
    const providers = snapshot?.providers ?? [];
    return ordered(providers, (item) => item.providerId, providerOrder).map((provider) => {
      const firsts = provider.rows.filter(
        (row, index) => provider.rows.findIndex((other) => other.id === row.id) === index,
      );
      const rows = ordered(firsts, (row) => row.id, rowOrder[provider.providerId] ?? []);
      return { provider, rows };
    });
  }

  /**
   * The settings with `id` (a provider, or a row within its provider) moved to the index `to`
   * picks in its list of `providers`, the settings' tree; the same object when it stays.
   */
  function placed(
    settings: DisplaySettings,
    providers: readonly TreeProvider[],
    id: string,
    to: (order: readonly string[], from: number, owner?: TreeProvider) => number,
  ): DisplaySettings {
    const providerIds = providers.map(({ provider }) => provider.providerId);
    const from = providerIds.indexOf(id);
    if (from >= 0) {
      const index = to(providerIds, from);
      if (index === from) return settings;
      return setIn(settings, [surface, "providerOrder"], moveTo(providerIds, id, index));
    }
    const owner = providers.find((item) => item.rows.some((row) => row.id === id));
    if (!owner) return settings;
    const rowIds = owner.rows.map((row) => row.id);
    const rowFrom = rowIds.indexOf(id);
    const index = to(rowIds, rowFrom, owner);
    if (index === rowFrom) return settings;
    const path = [surface, "rowOrder", owner.provider.providerId];
    return setIn(settings, path, moveTo(rowIds, id, index));
  }

  return {
    /** The tree's lines, top to bottom: each provider, then its rows on a page that shows rows. */
    lines(settings: DisplaySettings, nowMs: number): TreeLine[] {
      const shown = settings.surfaces[surface];
      const names = settings[namesKey].names;
      const windows = settings[windowsKey].window;
      const words = settings.words;
      const place: Place = { words, nowMs, names: "label", percent: "words" };
      /** A row's percent and reset as the Web text shows them. */
      const summary = (row: QuotaRow): string => {
        const item = visibleRow(row, names);
        const { value, reset } = rowFacts(item, { rows: [item] }, place);
        return reset ? `${value} · ${reset}` : value;
      };
      const off = (id: string) => !shown.enabled || shown.hidden.includes(id);
      return tree(settings).flatMap(({ provider, rows }) => {
        const { providerId } = provider;
        const group = shownGroup(provider, shown.hidden);
        // Its error when it has no rows; else, on a page without rows, the row that page shows.
        const named = { error: provider.error, name: provider.label };
        const error = provider.rows.length === 0 ? errorWords(named, nowMs) : undefined;
        const picked = withRows ? undefined : pickRow(group, windowFor(windows, group));
        const providerLine: TreeLine = {
          id: providerId,
          providerId,
          row: false,
          last: false,
          label: provider.label,
          detail: error ?? (picked ? summary(picked.row) : ""),
          ...(!withRows && windowChoices(group).length > 0
            ? { window: windowFor(windows, group) }
            : {}),
          hidden: shown.hidden.includes(providerId),
          muted: off(providerId),
        };
        if (!withRows) return [providerLine];
        const rowLines = rows.map((row): TreeLine => {
          const item = visibleRow(row, names);
          return {
            id: row.id,
            providerId,
            row: true,
            last: row === rows.at(-1),
            label: item.label,
            detail: item.named
              ? `was "${row.label}"`
              : row.prominence === "supplementary" && words.detail !== "detailed"
                ? "only with all rows"
                : summary(row),
            hidden: shown.hidden.includes(row.id),
            muted: off(row.id) || shown.hidden.includes(providerId),
          };
        });
        return [providerLine, ...rowLines];
      });
    },

    /** The surface switch on top of the page, flipped. */
    toggleSurface(): SettingsEdit {
      return (settings) => setIn(settings, [surface, "show"], !settings[surface].show);
    },

    /** A tick: the page shows the provider or row again, or leaves it out. */
    toggleHidden(id: string): SettingsEdit {
      return (settings) => {
        const { hidden } = settings[surface];
        const next = hidden.includes(id) ? hidden.filter((item) => item !== id) : [...hidden, id];
        return setIn(settings, [surface, "hidden"], next);
      };
    },

    /**
     * ‹ or ›: the provider's window steps `delta` through its choices. The window it would show
     * without a pick of its own is no pick, so it follows "For all providers" again. Nothing on a
     * line without ‹ ›: a page that shows rows, or a provider with fewer than two windows.
     */
    cycleWindow(providerId: string, delta: number): SettingsEdit {
      return (settings) => {
        const provider = snapshot?.providers.find((item) => item.providerId === providerId);
        const group = provider && shownGroup(provider, settings[surface].hidden);
        const choices = group ? windowChoices(group) : [];
        if (withRows || !group || choices.length === 0) return settings;
        const windows = settings[windowsKey].window;
        const { [providerId]: _ownPick, ...withoutOwnPick } = windows;
        const inherited = windowFor(withoutOwnPick, group);
        const next = stepIn(choices, windowFor(windows, group), delta);
        const value = next === inherited ? undefined : next;
        return setIn(settings, [windowsKey, "window", providerId], value);
      };
    },

    /** shift+↑↓: `id` moves `delta` places. */
    move(id: string, delta: number): SettingsEdit {
      return (settings) =>
        placed(settings, tree(settings), id, (order, from) =>
          clamp(from + delta, 0, order.length - 1),
        );
    },

    /**
     * A drag: `id` goes where the pointer is, `pointer` lines below the tree's first line. A row
     * never leaves its provider: a pointer outside counts as its provider's first or last row.
     */
    drag(id: string, pointer: number): SettingsEdit {
      return (settings) => {
        const providers = tree(settings);
        const height = (item: TreeProvider) => 1 + (withRows ? item.rows.length : 0);
        return placed(settings, providers, id, (order, from, owner) => {
          if (!owner) return dropIndex(from, providers.map(height), pointer);
          const above = providers.slice(0, providers.indexOf(owner));
          const firstRowLine = 1 + above.reduce((sum, item) => sum + height(item), 0);
          const rowHeights = order.map(() => 1);
          return dropIndex(from, rowHeights, pointer - firstRowLine);
        });
      };
    },

    /**
     * e or a double-click on a row: typing its new name (nothing typed puts its own name back),
     * with the hint. Its line's label is the input's placeholder. Undefined for a provider, or on a
     * page without rows.
     */
    rename(id: string) {
      const all = snapshot?.providers.flatMap((provider) => provider.rows) ?? [];
      const row = withRows ? all.find((item) => item.id === id) : undefined;
      if (!row) return undefined;
      return {
        hint: `Type a new name, then enter · enter with nothing typed = its own name ("${row.label}") · esc stop`,
        apply:
          (text: string): SettingsEdit =>
          (next) =>
            renameRow(next, namesKey, id, text),
      };
    },
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Where a dragged block goes, given the line under the pointer (0 = the first block's first
 * line). It moves only when the pointer would land inside it after the move, so blocks of
 * different heights never flip back and forth.
 */
export function dropIndex(from: number, heights: readonly number[], pointer: number): number {
  const starts: number[] = [];
  let total = 0;
  for (const height of heights) {
    starts.push(total);
    total += height;
  }
  const line = clamp(pointer, 0, total - 1);
  const over = starts.filter((start) => start <= line).length - 1;
  const fromHeight = heights[from] ?? 1;
  const overStart = starts[over] ?? 0;
  if (over > from) return line >= overStart + (heights[over] ?? 1) - fromHeight ? over : from;
  if (over < from) return line < overStart + fromHeight ? over : from;
  return from;
}

function moveTo(order: readonly string[], id: string, index: number): string[] {
  const next = order.filter((item) => item !== id);
  next.splice(index, 0, id);
  return next;
}
