/**
 * Desktop's side panel width, through Desktop's own page. UNOFFICIAL: the GUI plugin API can
 * neither read nor set that width, so this finds the divider between the chat panel and the side
 * panel and drags it with mouse events it makes up, as the user's mouse would. It leans on
 * Desktop 2.2's markup: the `data-slot` names of the session screen, and the resize handle's
 * protocol (`mousedown` on the handle, then `mousemove` and `mouseup` on the document).
 *
 * When any of that differs on this Desktop (an element is missing, two side panels are on screen,
 * the geometry is off, an event throws), each function here answers undefined or false and
 * changes nothing, so the app keeps its own width. Nothing here throws.
 *
 * The divider is found from the side panel, not by its class: it is a horizontal resize handle
 * directly under the chat panel, the chat panel's sibling is the side panel, and its position
 * must sit on their shared edge (`isSessionDivider`). The left sidebar's, the review pane's and
 * the bottom pane's handles are elsewhere and fail that.
 *
 * Quota counts as "alone" in the side panel when its panel is on screen in the side panel and
 * the side panel has only one pane (`data-slot="session-side-pane"`). It has a second pane when
 * a tab sits in the split pane below the side pane, and the bottom pane is not inside the side
 * panel at all; the app's own tab state cannot tell these apart, as it answers "visible" for
 * Quota in any of the three.
 */
import { dragX, isSessionDivider, stillFor } from "./side-width-model.js";

const SIDE_PANEL = '[data-slot="session-side-panel-presence"]';
const CHAT_PANEL = '[data-slot="session-chat-panel"]';
const DIVIDER = ':scope > div > [data-component="resize-handle"][data-direction="horizontal"]';
/** The side pane, and the split pane below it when it holds tabs. */
const SIDE_PANE = '[data-slot="session-side-pane"]';
/** The Quota tab's own root (`panel.tsx`). */
const QUOTA_PANEL = ".oq-panel";

/** Frames the width must stay put before it counts as still. */
const STILL_FRAMES = 4;
const STILL_PX = 0.5;
/** The side panel opens with an animation; the wait ends after this long, whether still or not. */
const GIVE_UP_MS = 2000;

/** The side panel on screen, and what the trick needs of it. */
export type SidePanel = {
  /** The divider between the chat panel and the side panel. */
  readonly divider: HTMLElement;
  /** The side panel's width in pixels. */
  readonly width: number;
  /** The side panel's element. */
  readonly element: HTMLElement;
  /**
   * The Quota tab is the only tab on screen in the side panel: not in the bottom pane, and not
   * next to another tab in the split pane.
   */
  readonly quotaAlone: boolean;
};

/** True while this module drags the divider, so its own events are not taken for the user's. */
let dragging = false;

const onScreen = (element: Element) => {
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0;
};

/**
 * The panes and whether Quota's panel shows in the side panel, as a string; no layout is read.
 * The new-tab view covers Quota by hiding it with the `hidden` class, so a hidden Quota is absent.
 */
const tabsShape = (side: Element) => {
  const quota = [...side.querySelectorAll(QUOTA_PANEL)].some((panel) => !panel.closest(".hidden"));
  return `${side.querySelectorAll(SIDE_PANE).length}:${quota ? "quota" : "-"}`;
};

/** The side panel of the session on screen; undefined when there is none, or not exactly one. */
export function findSidePanel(): SidePanel | undefined {
  try {
    const sides = [...document.querySelectorAll(SIDE_PANEL)].filter(onScreen);
    const side = sides[0];
    if (sides.length !== 1 || !side) return undefined;
    const chat = side.parentElement?.querySelector(`:scope > ${CHAT_PANEL}`);
    if (!chat) return undefined;
    const sideBox = side.getBoundingClientRect();
    const chatBox = chat.getBoundingClientRect();
    const divider = [...chat.querySelectorAll<HTMLElement>(DIVIDER)].find((handle) =>
      isSessionDivider(handle.getBoundingClientRect(), chatBox, sideBox),
    );
    if (!divider) return undefined;
    // Every pane counts, sized yet or not: a split pane has no height for its first frame.
    const panes = side.querySelectorAll(SIDE_PANE);
    const [pane] = panes;
    return {
      divider,
      width: sideBox.width,
      element: side as HTMLElement,
      quotaAlone:
        panes.length === 1 && !!pane && [...pane.querySelectorAll(QUOTA_PANEL)].some(onScreen),
    };
  } catch {
    return undefined;
  }
}

/**
 * Calls `ready` once with the side panel when its width has stayed put for a few frames, as it
 * does after the panel opens or a tab switches. Gives up quietly after two seconds. Returns the
 * function that stops the wait.
 */
export function whenSideStill(ready: (panel: SidePanel) => void): () => void {
  if (typeof requestAnimationFrame === "undefined") return () => {};
  const started = performance.now();
  const widths: number[] = [];
  let frame = 0;
  let stopped = false;
  const look = () => {
    if (stopped) return;
    const panel = findSidePanel();
    if (panel) {
      widths.push(panel.width);
      if (stillFor(widths, STILL_FRAMES, STILL_PX)) {
        ready(panel);
        return;
      }
    } else {
      widths.length = 0;
    }
    if (performance.now() - started < GIVE_UP_MS) frame = requestAnimationFrame(look);
  };
  frame = requestAnimationFrame(look);
  return () => {
    stopped = true;
    cancelAnimationFrame(frame);
  };
}

/**
 * Calls `changed` when the side panel's panes or Quota's place in it change: a tab moved in, out,
 * or between the panes, or the new-tab view covered or uncovered Quota. The app's tab state does not say that (it answers "visible" for Quota in
 * the side panel, its split pane and the bottom pane alike), so this watches the panel's DOM. It
 * looks at most once a frame, and reads no layout until the panes or Quota's presence differ.
 * Returns the function that stops watching.
 */
export function watchSideTabs(panel: SidePanel, changed: () => void): () => void {
  if (typeof MutationObserver === "undefined" || typeof requestAnimationFrame === "undefined") {
    return () => {};
  }
  const side = panel.element;
  let shape = tabsShape(side);
  let queued = false;
  let frame = 0;
  const look = () => {
    queued = false;
    const now = tabsShape(side);
    if (now === shape) return;
    shape = now;
    changed();
  };
  try {
    const observer = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      frame = requestAnimationFrame(look);
    });
    observer.observe(side, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  } catch {
    return () => {};
  }
}

/**
 * Drags the divider so the side panel gets `narrowerBy` pixels narrower (wider when negative);
 * Desktop stops the drag at its minimum and maximum. The events follow Desktop's handle: a
 * pointerdown (it pauses the panel's animations), mousedown on the handle, mousemove and mouseup
 * on the document. Answers whether it dragged; it does not while the user is dragging.
 */
export function dragSide(panel: SidePanel, narrowerBy: number): boolean {
  const { divider } = panel;
  if (divider.hasAttribute("data-dragging")) return false;
  try {
    const box = divider.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const to = dragX(x, narrowerBy, getComputedStyle(divider).direction === "rtl");
    const mouse = (type: string, clientX: number) =>
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        button: 0,
        detail: 1,
        clientX,
        clientY: y,
      });
    dragging = true;
    try {
      divider.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: x, clientY: y }),
      );
      divider.dispatchEvent(mouse("mousedown", x));
      document.dispatchEvent(mouse("mousemove", to));
    } finally {
      // Always end the drag, or Desktop keeps its listeners and the page's cursor and scrolling lock.
      document.dispatchEvent(mouse("mouseup", to));
      document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      dragging = false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Calls `started` when the user presses the divider, and `ended` with the side panel once they
 * let go and its width is still. Only the user's drags count: a window resize moves no divider,
 * and this module's own drags are left out. Returns the function that stops watching.
 */
export function watchHandDrags(started: () => void, ended: (panel: SidePanel) => void): () => void {
  if (typeof document === "undefined") return () => {};
  let stopWaiting = () => {};
  const up = () => {
    stopWaiting();
    stopWaiting = whenSideStill(ended);
  };
  const down = (event: MouseEvent) => {
    if (dragging || !(event.target instanceof Element)) return;
    const divider = findSidePanel()?.divider;
    if (!divider?.contains(event.target)) return;
    started();
    document.addEventListener("mouseup", up, { once: true, capture: true });
  };
  document.addEventListener("mousedown", down, true);
  return () => {
    document.removeEventListener("mousedown", down, true);
    document.removeEventListener("mouseup", up, true);
    stopWaiting();
  };
}
