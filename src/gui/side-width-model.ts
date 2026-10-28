/**
 * When the Quota tab narrows Desktop's side panel and when it gives the width back: the pure
 * decisions behind `side-width-follow.ts`, with no page in sight. Widths are the side panel's
 * own, in pixels. Desktop stores one width per session screen (the chat panel's), not one per
 * tab, so this window remembers the two it cares about itself: Quota's, and the one every other
 * tab shares.
 */

/** The tab whose width the side panel holds: Quota's, or any other tab's. */
export type SideTab = "quota" | "other";

/** The widths this window remembers, in pixels; 0 means none yet. */
export type SideWidths = { quota: number; other: number };

export const SIDE_WIDTHS_INITIAL: SideWidths = { quota: 0, other: 0 };

/**
 * Quota's width until the user sets one: less than the panel can be, so the app stops the drag
 * at its minimum.
 */
export const NARROWEST = 0;

/** Pixels of play between two measurements of the same width. */
const SAME_PX = 1;

/** Pixels between the divider's center and the panels' shared edge, for it to count as theirs. */
const EDGE_PX = 12;

/** A rectangle on screen, as `getBoundingClientRect` answers it. */
export type Box = { left: number; right: number; width: number; height: number };

export type WidthStep = {
  /** What to remember now; the same object when nothing changes. */
  widths: SideWidths;
  /** Pixels to make the side panel narrower (wider when negative); undefined to leave it. */
  narrowerBy: number | undefined;
};

/** The widths with `width` remembered for `tab`; the same object when it is already so. */
export function remember(widths: SideWidths, tab: SideTab, width: number): SideWidths {
  const pixels = Math.round(width);
  if (!(pixels > 0) || widths[tab] === pixels) return widths;
  return { ...widths, [tab]: pixels };
}

function narrowerBy(current: number, target: number | undefined): number | undefined {
  if (target === undefined) return undefined;
  const by = current - target;
  return Math.abs(by) < SAME_PX ? undefined : by;
}

/**
 * What to do now that `shows` is the tab the side panel shows.
 * @param held the tab whose width the panel holds as far as this window knows; undefined when it
 *   has not seen this session yet.
 * @param current the panel's width now.
 */
export function widthStep(input: {
  shows: SideTab;
  held: SideTab | undefined;
  current: number;
  widths: SideWidths;
}): WidthStep {
  const { shows, held, current, widths } = input;
  if (held === shows) return { widths, narrowerBy: undefined };

  if (shows === "other") {
    // Quota gave way: put back the width the other tabs had. A session first seen showing
    // another tab keeps the panel as it is.
    if (held === "quota") {
      return {
        widths,
        narrowerBy: narrowerBy(current, widths.other > 0 ? widths.other : undefined),
      };
    }
    return {
      widths: widths.other > 0 ? widths : remember(widths, "other", current),
      narrowerBy: undefined,
    };
  }

  // Quota shows, after another tab (the panel's width is that tab's) or in a session first seen.
  // A session first seen keeps the other tabs' width this window remembers.
  const adopt = held === "other" || widths.other === 0;
  return {
    widths: adopt ? remember(widths, "other", current) : widths,
    narrowerBy: narrowerBy(current, widths.quota > 0 ? widths.quota : NARROWEST),
  };
}

/**
 * Where the pointer goes to make the side panel `narrowerBy` pixels narrower (wider when
 * negative), starting at `x`. The chat panel grows toward the side panel, so that is to the right
 * on a left-to-right page.
 */
export function dragX(x: number, narrowerBy: number, rtl: boolean): number {
  return rtl ? x - narrowerBy : x + narrowerBy;
}

/** The last `frames` widths all lie within `tolerance` pixels of each other. */
export function stillFor(widths: readonly number[], frames: number, tolerance: number): boolean {
  if (widths.length < frames) return false;
  const last = widths.slice(-frames);
  return Math.max(...last) - Math.min(...last) <= tolerance;
}

const shown = (box: Box) => box.width > 0 && box.height > 0;

/**
 * The resize handle sits on the edge the chat panel shares with the side panel, whichever side
 * the side panel is on, and all three are on screen. The app has other horizontal handles (the
 * left sidebar's, the review pane's) that fail this.
 */
export function isSessionDivider(handle: Box, chat: Box, side: Box): boolean {
  if (![handle, chat, side].every(shown)) return false;
  const edge =
    side.left >= chat.right - SAME_PX
      ? chat.right
      : side.right <= chat.left + SAME_PX
        ? chat.left
        : undefined;
  if (edge === undefined) return false;
  return Math.abs(handle.left + handle.width / 2 - edge) <= EDGE_PX;
}
