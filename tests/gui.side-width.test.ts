import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  dragSide,
  findSidePanel,
  watchHandDrags,
  watchSideTabs,
  whenSideStill,
} from "../src/gui/side-width.js";
import {
  FakeElement,
  FakeEvent,
  installFakePage,
  OFF_SCREEN,
  removeFakePage,
  type FakePage,
  type Rect,
} from "./helpers/fake-page.js";

const rect = (left: number, width: number, height = 800, top = 0): Rect => ({
  left,
  top,
  width,
  height,
});

const HANDLE = { "data-component": "resize-handle", "data-direction": "horizontal" };

const div = (name: string, attributes: Record<string, string> = {}, box: Rect = OFF_SCREEN) =>
  new FakeElement("div", { name, attributes, rect: box });

/**
 * Desktop 2.2's session screen, as far as the DOM module looks at it: the chat panel (0-900 px)
 * with the divider on its right edge, the side panel (908-1400 px) with one pane that holds the
 * Quota tab, and the bottom pane under both, outside the side panel.
 */
function build() {
  const divider = div("divider", HANDLE, rect(896, 8));
  const dividerWrap = div("divider-wrap").append(divider);
  const chat = div("chat", { "data-slot": "session-chat-panel" }, rect(0, 900)).append(dividerWrap);
  const quota = div("quota", { class: "oq-surface oq-panel" }, rect(908, 492, 700, 100));
  const sidePane = div(
    "side-pane",
    { "data-slot": "session-side-pane", "data-pane": "side" },
    rect(908, 492),
  ).append(quota);
  const side = div("side", { "data-slot": "session-side-panel-presence" }, rect(908, 492)).append(
    div("side-content").append(sidePane),
  );
  const row = div("row").append(chat, side);
  const bottom = div(
    "bottom-pane",
    { "data-slot": "session-bottom-pane" },
    rect(0, 1400, 200, 800),
  );
  return { row, chat, divider, dividerWrap, side, sidePane, quota, bottom };
}

/** A second pane below the side pane, as the split pane is, holding `tab`. */
function splitBelow(side: FakeElement, tab: FakeElement) {
  const split = div(
    "split-pane",
    { "data-slot": "session-side-pane", "data-pane": "split" },
    rect(908, 492, 300, 500),
  ).append(tab);
  side.children[0]?.append(split);
  return split;
}

const mouse = (type: string) => new FakeEvent(type, { bubbles: true, button: 0 });

let page: FakePage;
let screen: ReturnType<typeof build>;

beforeEach(() => {
  page = installFakePage();
  screen = build();
  page.document.body.append(screen.row, screen.bottom);
});

afterEach(() => {
  removeFakePage();
});

describe("findSidePanel", () => {
  it("finds the divider and the width, and Quota alone in the side panel's one pane", () => {
    const panel = findSidePanel();

    expect(panel?.divider).toBe(screen.divider);
    expect(panel?.element).toBe(screen.side);
    expect(panel?.width).toBe(492);
    expect(panel?.quotaAlone).toBe(true);
  });

  it("counts Quota alone when the split pane takes the whole height, as the only pane", () => {
    screen.sidePane.setAttribute("data-pane", "split");

    expect(findSidePanel()?.quotaAlone).toBe(true);
  });

  it("does not count Quota alone in the side pane with another tab in the split pane", () => {
    splitBelow(screen.side, div("changes", {}, rect(908, 492, 280, 520)));

    expect(findSidePanel()?.quotaAlone).toBe(false);
  });

  it("counts a split pane that has no size yet, as it has for its first frame", () => {
    splitBelow(screen.side, div("changes")).rect = OFF_SCREEN;

    expect(findSidePanel()?.quotaAlone).toBe(false);
  });

  it("does not count Quota alone in the split pane with another tab above it", () => {
    screen.quota.remove();
    screen.sidePane.append(div("changes", {}, rect(908, 492, 500)));
    splitBelow(screen.side, screen.quota);

    expect(findSidePanel()?.quotaAlone).toBe(false);
  });

  it("does not count Quota in the bottom pane, which is outside the side panel", () => {
    screen.quota.remove();
    screen.sidePane.append(div("changes", {}, rect(908, 492)));
    screen.bottom.append(screen.quota);
    screen.quota.rect = rect(0, 1400, 150, 850);

    const panel = findSidePanel();

    expect(panel?.width).toBe(492);
    expect(panel?.quotaAlone).toBe(false);
  });

  it("does not count Quota when its panel is not on screen, or is not there", () => {
    screen.quota.rect = OFF_SCREEN;
    expect(findSidePanel()?.quotaAlone).toBe(false);

    screen.quota.remove();
    expect(findSidePanel()?.quotaAlone).toBe(false);
  });

  it("does not take another class that starts with oq-panel for Quota's panel", () => {
    screen.quota.setAttribute("class", "oq-surface oq-panel-title");

    expect(findSidePanel()?.quotaAlone).toBe(false);
  });

  it("picks the handle on the chat and side panels' shared edge, whatever else is there", () => {
    // Before the real divider in the page, and after it.
    screen.divider.remove();
    screen.dividerWrap.append(
      div("far-handle", HANDLE, rect(232, 8)),
      screen.divider,
      div("inner-handle", HANDLE, rect(1100, 8)),
    );

    expect(findSidePanel()?.divider).toBe(screen.divider);
  });

  it("finds no divider when the only handles are elsewhere, vertical, or not under the chat panel", () => {
    screen.divider.rect = rect(232, 8);
    expect(findSidePanel()).toBeUndefined();

    screen.divider.rect = rect(896, 8);
    screen.divider.setAttribute("data-direction", "vertical");
    expect(findSidePanel()).toBeUndefined();

    screen.divider.setAttribute("data-direction", "horizontal");
    screen.divider.remove();
    screen.chat.append(div("deeper").append(div("deeper-still").append(screen.divider)));
    expect(findSidePanel()).toBeUndefined();
  });

  it("finds nothing without exactly one side panel on screen, or without its chat panel", () => {
    const second = div("second-side", { "data-slot": "session-side-panel-presence" }, rect(0, 10));
    screen.row.append(second);
    expect(findSidePanel()).toBeUndefined();

    // A closed panel is out of the row, with no size.
    second.rect = OFF_SCREEN;
    expect(findSidePanel()?.width).toBe(492);

    screen.chat.remove();
    expect(findSidePanel()).toBeUndefined();

    screen.side.rect = OFF_SCREEN;
    expect(findSidePanel()).toBeUndefined();
  });

  it("answers undefined instead of throwing when the page does", () => {
    vi.spyOn(page.document, "querySelectorAll").mockImplementation(() => {
      throw new Error("boom");
    });

    expect(findSidePanel()).toBeUndefined();
  });
});

describe("dragSide", () => {
  it("presses the divider and moves and lets go on the document, in the app's order", () => {
    const panel = findSidePanel();
    if (!panel) throw new Error("no panel");

    expect(dragSide(panel, 250)).toBe(true);

    expect(page.events.map((event) => [event.type, event.target, event.clientX])).toEqual([
      ["pointerdown", "divider", 900],
      ["mousedown", "divider", 900],
      ["mousemove", "document", 1150],
      ["mouseup", "document", 1150],
      ["pointerup", "document", undefined],
    ]);
    // The handle's vertical middle.
    expect(page.events[0]?.clientY).toBe(400);
  });

  it("moves the pointer the other way to widen the panel", () => {
    const panel = findSidePanel();
    if (!panel) throw new Error("no panel");

    dragSide(panel, -100);

    expect(page.events.find((event) => event.type === "mousemove")?.clientX).toBe(800);
  });

  it("flips the direction on a right-to-left page", () => {
    const panel = findSidePanel();
    if (!panel) throw new Error("no panel");
    screen.divider.direction = "rtl";

    dragSide(panel, 250);

    expect(page.events.find((event) => event.type === "mousemove")?.clientX).toBe(650);
  });

  it("does not drag while the user is dragging the divider", () => {
    const panel = findSidePanel();
    if (!panel) throw new Error("no panel");
    screen.divider.setAttribute("data-dragging");

    expect(dragSide(panel, 250)).toBe(false);
    expect(page.events).toEqual([]);
  });

  it("lets go even when a step throws, and answers false", () => {
    const panel = findSidePanel();
    if (!panel) throw new Error("no panel");
    const dispatch = screen.divider.dispatchEvent.bind(screen.divider);
    vi.spyOn(screen.divider, "dispatchEvent").mockImplementation((event) => {
      if (event.type === "mousedown") throw new Error("boom");
      return dispatch(event);
    });

    expect(dragSide(panel, 250)).toBe(false);

    expect(page.events.slice(-2).map((event) => [event.type, event.target])).toEqual([
      ["mouseup", "document"],
      ["pointerup", "document"],
    ]);
  });
});

describe("whenSideStill", () => {
  it("calls ready once with the panel after its width stays put for four frames", () => {
    const ready = vi.fn();
    whenSideStill(ready);

    // The side panel opens with an animation.
    for (const width of [100, 300, 492, 492, 492]) {
      screen.side.rect = rect(908, width);
      page.frames(1);
      expect(ready).not.toHaveBeenCalled();
    }
    screen.side.rect = rect(908, 492);
    page.frames(1);
    page.frames(10);

    expect(ready).toHaveBeenCalledTimes(1);
    expect(ready.mock.calls[0]?.[0]?.width).toBe(492);
    expect(page.pendingFrames()).toBe(0);
  });

  it("starts counting again when the panel is gone for a frame", () => {
    const ready = vi.fn();
    whenSideStill(ready);

    page.frames(3);
    screen.side.rect = OFF_SCREEN;
    page.frames(1);
    screen.side.rect = rect(908, 492);
    page.frames(3);
    expect(ready).not.toHaveBeenCalled();

    page.frames(1);
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it("gives up after two seconds of a panel that never sits still", () => {
    const ready = vi.fn();
    whenSideStill(ready);

    for (let frame = 0; frame < 130; frame++) {
      screen.side.rect = rect(908, 300 + frame);
      page.frames(1);
    }

    expect(ready).not.toHaveBeenCalled();
    expect(page.pendingFrames()).toBe(0);
  });

  it("stops when asked, and does nothing without animation frames", () => {
    const ready = vi.fn();
    const stop = whenSideStill(ready);
    page.frames(2);

    stop();
    expect(page.pendingFrames()).toBe(0);
    page.frames(10);
    expect(ready).not.toHaveBeenCalled();

    vi.stubGlobal("requestAnimationFrame", undefined);
    expect(() => whenSideStill(ready)()).not.toThrow();
    expect(ready).not.toHaveBeenCalled();
  });
});

describe("watchHandDrags", () => {
  it("tells when the user presses the divider, and when they let go and the width is still", () => {
    const started = vi.fn();
    const ended = vi.fn();
    watchHandDrags(started, ended);

    screen.divider.dispatchEvent(mouse("mousedown"));
    expect(started).toHaveBeenCalledTimes(1);

    page.document.dispatchEvent(mouse("mouseup"));
    page.frames(3);
    expect(ended).not.toHaveBeenCalled();
    page.frames(1);

    expect(ended).toHaveBeenCalledTimes(1);
    expect(ended.mock.calls[0]?.[0]?.width).toBe(492);
  });

  it("counts a press on anything inside the divider, and nothing outside it", () => {
    const started = vi.fn();
    watchHandDrags(started, vi.fn());
    const grip = div("grip");
    screen.divider.append(grip);

    screen.chat.dispatchEvent(mouse("mousedown"));
    screen.side.dispatchEvent(mouse("mousedown"));
    screen.bottom.dispatchEvent(mouse("mousedown"));
    expect(started).not.toHaveBeenCalled();

    grip.dispatchEvent(mouse("mousedown"));
    expect(started).toHaveBeenCalledTimes(1);
  });

  it("does not take its own drag for the user's", () => {
    const started = vi.fn();
    const ended = vi.fn();
    watchHandDrags(started, ended);
    const panel = findSidePanel();
    if (!panel) throw new Error("no panel");

    expect(dragSide(panel, 250)).toBe(true);
    page.frames(10);

    expect(started).not.toHaveBeenCalled();
    expect(ended).not.toHaveBeenCalled();
    expect(page.documentListeners()).toBe(1);
  });

  it("takes the next press for the user's after a drag of its own failed", () => {
    const started = vi.fn();
    watchHandDrags(started, vi.fn());
    const panel = findSidePanel();
    if (!panel) throw new Error("no panel");
    const dispatch = screen.divider.dispatchEvent.bind(screen.divider);
    const spy = vi.spyOn(screen.divider, "dispatchEvent").mockImplementation((event) => {
      if (event.type === "mousedown") throw new Error("boom");
      return dispatch(event);
    });
    dragSide(panel, 250);
    spy.mockRestore();

    screen.divider.dispatchEvent(mouse("mousedown"));

    expect(started).toHaveBeenCalledTimes(1);
  });

  it("leaves no listener or frame behind when stopped", () => {
    const ended = vi.fn();
    const stop = watchHandDrags(vi.fn(), ended);
    expect(page.documentListeners()).toBe(1);

    screen.divider.dispatchEvent(mouse("mousedown"));
    expect(page.documentListeners()).toBe(2);
    stop();
    expect(page.documentListeners()).toBe(0);

    screen.divider.dispatchEvent(mouse("mousedown"));
    page.document.dispatchEvent(mouse("mouseup"));
    page.frames(10);
    expect(ended).not.toHaveBeenCalled();
    expect(page.pendingFrames()).toBe(0);
  });

  it("stops waiting for the width when stopped after the user let go", () => {
    const ended = vi.fn();
    const stop = watchHandDrags(vi.fn(), ended);
    screen.divider.dispatchEvent(mouse("mousedown"));
    page.document.dispatchEvent(mouse("mouseup"));
    expect(page.pendingFrames()).toBe(1);

    stop();

    expect(page.pendingFrames()).toBe(0);
    page.frames(10);
    expect(ended).not.toHaveBeenCalled();
    expect(page.documentListeners()).toBe(0);
  });

  it("does nothing without a document", () => {
    vi.stubGlobal("document", undefined);

    expect(() => watchHandDrags(vi.fn(), vi.fn())()).not.toThrow();
  });
});

describe("watchSideTabs", () => {
  function watch() {
    const panel = findSidePanel();
    if (!panel) throw new Error("no panel");
    const changed = vi.fn();
    return { changed, stop: watchSideTabs(panel, changed) };
  }

  it("tells once, in the next frame, when Quota moves out to the bottom pane", () => {
    const { changed } = watch();

    screen.quota.remove();
    screen.sidePane.append(div("changes"));
    screen.bottom.append(screen.quota);
    page.flushMutations();
    expect(changed).not.toHaveBeenCalled();
    page.frames(1);
    page.frames(5);

    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("tells when Quota moves in from the bottom pane", () => {
    screen.quota.remove();
    screen.bottom.append(screen.quota);
    const { changed } = watch();

    screen.quota.remove();
    screen.sidePane.append(screen.quota);
    page.flushMutations();
    page.frames(1);

    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("tells when a split pane opens or closes", () => {
    const { changed } = watch();

    const split = splitBelow(screen.side, div("changes"));
    page.flushMutations();
    page.frames(1);
    expect(changed).toHaveBeenCalledTimes(1);

    split.remove();
    page.flushMutations();
    page.frames(1);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("looks at most once a frame, however many changes there are", () => {
    const { changed } = watch();

    for (let index = 0; index < 5; index++) {
      screen.quota.remove();
      screen.bottom.append(screen.quota);
      page.flushMutations();
      screen.quota.remove();
      screen.sidePane.append(screen.quota);
      page.flushMutations();
    }
    screen.quota.remove();
    screen.bottom.append(screen.quota);
    page.flushMutations();

    expect(page.pendingFrames()).toBe(1);
    page.frames(1);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("stays quiet, and reads no layout, for changes that move no pane or Quota", () => {
    const { changed } = watch();
    const layout = vi.spyOn(screen.sidePane, "getBoundingClientRect");
    const sideLayout = vi.spyOn(screen.side, "getBoundingClientRect");

    screen.quota.append(div("a row of usage"));
    screen.sidePane.append(div("a toolbar"));
    page.flushMutations();
    page.frames(1);
    // Changes outside the side panel are not even delivered.
    screen.bottom.append(div("terminal output"));
    page.flushMutations();

    expect(changed).not.toHaveBeenCalled();
    expect(page.pendingFrames()).toBe(0);
    expect(layout).not.toHaveBeenCalled();
    expect(sideLayout).not.toHaveBeenCalled();
  });

  it("stops watching and cancels the frame it asked for", () => {
    const { changed, stop } = watch();
    expect(page.observing()).toBe(1);
    screen.quota.remove();
    page.flushMutations();
    expect(page.pendingFrames()).toBe(1);

    stop();

    expect(page.observing()).toBe(0);
    expect(page.pendingFrames()).toBe(0);
    page.frames(3);
    expect(changed).not.toHaveBeenCalled();
  });

  it("does nothing where the page has no MutationObserver", () => {
    const panel = findSidePanel();
    if (!panel) throw new Error("no panel");
    vi.stubGlobal("MutationObserver", undefined);

    expect(() => watchSideTabs(panel, vi.fn())()).not.toThrow();
  });
});
