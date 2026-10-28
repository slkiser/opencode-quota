import type { Context } from "@opencode/plugin/gui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { followSideWidth } from "../src/gui/side-width-follow.js";
import { dragSide, watchHandDrags, watchSideTabs, whenSideStill } from "../src/gui/side-width.js";

/**
 * The effects and cleanups `followSideWidth` registers with Solid; on the server build effects
 * never run by themselves, so the tests run them. As in Solid, a cleanup registered while an
 * effect runs belongs to that run and goes before the effect's next one; one registered by the
 * plugin itself, outside any effect, goes only when the plugin does.
 */
const solid = vi.hoisted(() => ({
  effects: [] as Array<() => void>,
  effectCleanups: [] as Array<() => void>,
  pluginCleanups: [] as Array<() => void>,
  inEffect: false,
}));
vi.mock("solid-js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("solid-js")>()),
  createEffect: (effect: () => void) => {
    solid.effects.push(effect);
  },
  onCleanup: (cleanup: () => void) => {
    (solid.inEffect ? solid.effectCleanups : solid.pluginCleanups).push(cleanup);
  },
}));

/** The page: what the DOM module finds. Its calls are the trick's only effect. */
const page = vi.hoisted(() => {
  type Wait = { ready: (panel: unknown) => void; stopped: boolean };
  const state = {
    panel: { width: 700, quotaAlone: false, divider: {}, element: {} as object },
    /** False holds each wait until `settle`, as the page does until the panel sits still. */
    still: true,
    waiting: [] as Wait[],
    stopWaiting: undefined as unknown as () => void,
    stopTabs: undefined as unknown as () => void,
    /** What the tab watcher calls when the panes or Quota's place in them change. */
    tabsChanged: undefined as undefined | (() => void),
    settle() {
      for (const wait of state.waiting.splice(0)) if (!wait.stopped) wait.ready(state.panel);
    },
  };
  return state;
});
vi.mock("../src/gui/side-width.js", () => ({
  dragSide: vi.fn(() => true),
  watchHandDrags: vi.fn(() => () => {}),
  watchSideTabs: vi.fn((_panel: unknown, changed: () => void) => {
    page.tabsChanged = changed;
    return page.stopTabs;
  }),
  whenSideStill: vi.fn((ready: (panel: unknown) => void) => {
    const wait = { ready, stopped: false };
    page.waiting.push(wait);
    if (page.still) page.settle();
    return () => {
      wait.stopped = true;
      page.stopWaiting();
    };
  }),
}));

type Screen = {
  session: { key: string; server: { builtin: boolean } } | undefined;
  open: boolean;
  quota: "visible" | "open" | "closed";
  narrow: boolean;
};

const SESSION = { key: "local\nses_1", server: { builtin: true } };
let screen: Screen;

function start() {
  const ctx = {
    sessions: { current: () => screen.session },
    layout: {
      narrow: () => screen.narrow,
      side: { opened: () => screen.open },
      state: () => screen.quota,
    },
  } as unknown as Context;
  followSideWidth(ctx, "opencode-quota:quota");
  rerun();
}

/** Runs the effect again, after the cleanups Solid would run first. */
function rerun() {
  for (const cleanup of solid.effectCleanups.splice(0)) cleanup();
  for (const effect of solid.effects) {
    solid.inEffect = true;
    try {
      effect();
    } finally {
      solid.inEffect = false;
    }
  }
}

/**
 * The panel as the page shows it: `width` pixels, with Quota or another tab. The app's state
 * says Quota is visible whenever it is the shown tab in any pane; `alone` is whether the page
 * has it as the only tab on screen in the side panel.
 */
function show(tab: "quota" | "other", width: number, alone = tab === "quota") {
  screen.quota = tab === "quota" ? "visible" : "open";
  page.panel.width = width;
  page.panel.quotaAlone = alone;
  rerun();
}

/** The page changes under the app's state: a tab moved between the panes. */
function move(width: number, alone: boolean) {
  page.panel.width = width;
  page.panel.quotaAlone = alone;
  page.tabsChanged?.();
}

beforeEach(() => {
  solid.effects.length = 0;
  solid.effectCleanups.length = 0;
  solid.pluginCleanups.length = 0;
  solid.inEffect = false;
  page.panel.width = 700;
  page.panel.quotaAlone = false;
  page.panel.element = {};
  page.still = true;
  page.waiting.length = 0;
  page.tabsChanged = undefined;
  page.stopWaiting = vi.fn();
  page.stopTabs = vi.fn();
  screen = { session: SESSION, open: true, quota: "open", narrow: false };
  vi.mocked(dragSide).mockClear().mockReturnValue(true);
  vi.mocked(whenSideStill).mockClear();
  vi.mocked(watchHandDrags).mockClear();
  vi.mocked(watchSideTabs).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("followSideWidth", () => {
  it("narrows the panel when Quota shows, and puts the other tabs' width back after it", () => {
    start();
    expect(dragSide).not.toHaveBeenCalled();

    show("quota", 700);
    expect(dragSide).toHaveBeenLastCalledWith(page.panel, 700);

    show("other", 320);
    expect(dragSide).toHaveBeenLastCalledWith(page.panel, -380);
    expect(dragSide).toHaveBeenCalledTimes(2);
  });

  it("does not drag again while the panel already holds the shown tab's width", () => {
    start();
    show("quota", 700);
    show("quota", 320);
    rerun();

    expect(dragSide).toHaveBeenCalledTimes(1);
  });

  it("takes a hand-resize as the shown tab's width, for the next time", () => {
    start();
    show("quota", 700);
    const [started, ended] = vi.mocked(watchHandDrags).mock.calls[0] ?? [];

    // The user drags the divider until the Quota tab is 450 wide.
    started?.();
    ended?.({ ...page.panel, width: 450, quotaAlone: true } as never);
    show("other", 700);
    vi.mocked(dragSide).mockClear();
    show("quota", 700);

    expect(dragSide).toHaveBeenLastCalledWith(page.panel, 250);
  });

  it("takes a hand-resize while another tab shows as the width all other tabs get back", () => {
    start();
    show("quota", 700);
    const [, ended] = vi.mocked(watchHandDrags).mock.calls[0] ?? [];
    show("other", 700);

    ended?.({ ...page.panel, width: 540, quotaAlone: false } as never);
    show("quota", 540);
    show("other", 320);

    expect(dragSide).toHaveBeenLastCalledWith(page.panel, -220);
  });

  it("treats Quota in the split pane or the bottom pane like another tab: the width stays", () => {
    start();

    // The app's state says "visible"; the page has Quota next to another tab, or outside the side panel.
    show("quota", 700, false);
    show("quota", 700, false);

    expect(dragSide).not.toHaveBeenCalled();
  });

  it("gives the other tabs' width back when Quota moves out of the side panel, though its state stays visible", () => {
    start();
    show("quota", 700);
    expect(dragSide).toHaveBeenLastCalledWith(page.panel, 700);

    // The user drags the Quota tab down into the bottom pane; another tab takes the side pane.
    move(320, false);

    expect(screen.quota).toBe("visible");
    expect(dragSide).toHaveBeenLastCalledWith(page.panel, -380);
    expect(dragSide).toHaveBeenCalledTimes(2);
  });

  it("gives the width back when another tab opens in a split pane next to Quota", () => {
    start();
    show("quota", 700);

    move(320, false);

    expect(dragSide).toHaveBeenLastCalledWith(page.panel, -380);
  });

  it("narrows the panel when Quota moves in from the bottom pane, and widens it when it goes back", () => {
    start();
    show("quota", 700, false);
    expect(dragSide).not.toHaveBeenCalled();

    move(700, true);
    expect(dragSide).toHaveBeenLastCalledWith(page.panel, 700);

    move(320, false);
    expect(dragSide).toHaveBeenLastCalledWith(page.panel, -380);
    expect(dragSide).toHaveBeenCalledTimes(2);
  });

  it("does not drag when the page changes but Quota's place does not", () => {
    start();
    show("quota", 700);
    vi.mocked(dragSide).mockClear();

    move(320, true);
    move(320, true);

    expect(dragSide).not.toHaveBeenCalled();
  });

  it("takes a hand-resize with Quota next to another tab as the other tabs' width, not Quota's", () => {
    start();
    show("quota", 700);
    move(320, false);
    const [, ended] = vi.mocked(watchHandDrags).mock.calls[0] ?? [];

    // The user widens the panel to 540 while Quota sits in the split pane.
    ended?.({ ...page.panel, width: 540, quotaAlone: false } as never);
    vi.mocked(dragSide).mockClear();
    move(540, true);

    // Quota has no width of its own yet, so it goes to the narrowest, not to the 540.
    expect(dragSide).toHaveBeenLastCalledWith(page.panel, 540);

    move(320, false);
    expect(dragSide).toHaveBeenLastCalledWith(page.panel, -220);
  });

  it("watches the panes only while Quota is visible, and stops when it is not or the effect runs again", () => {
    start();
    expect(watchSideTabs).not.toHaveBeenCalled();

    show("quota", 700);
    expect(watchSideTabs).toHaveBeenCalledTimes(1);
    expect(watchSideTabs).toHaveBeenLastCalledWith(page.panel, expect.any(Function));
    expect(page.stopTabs).not.toHaveBeenCalled();

    show("other", 320);
    expect(page.stopTabs).toHaveBeenCalledTimes(1);
    expect(watchSideTabs).toHaveBeenCalledTimes(1);

    show("quota", 700);
    expect(watchSideTabs).toHaveBeenCalledTimes(2);
  });

  it("watches again when the side panel is a new element, and keeps watching when it is the same", () => {
    start();
    show("quota", 700);
    move(700, true);
    expect(watchSideTabs).toHaveBeenCalledTimes(1);
    expect(page.stopTabs).not.toHaveBeenCalled();

    page.panel.element = {};
    move(700, true);

    expect(page.stopTabs).toHaveBeenCalledTimes(1);
    expect(watchSideTabs).toHaveBeenCalledTimes(2);
  });

  it("does not watch the panes for a panel that is closed, or on a narrow screen", () => {
    start();
    screen.open = false;
    show("quota", 700);
    screen.open = true;
    screen.narrow = true;
    show("quota", 700);

    expect(watchSideTabs).not.toHaveBeenCalled();
  });

  it("leaves the decision to the latest state when the panel is not still yet", () => {
    page.still = false;
    start();
    page.settle();

    // Quota shows and gives way again before the panel sits still: only the last one counts.
    show("quota", 700);
    show("other", 700);
    page.settle();

    expect(dragSide).not.toHaveBeenCalled();
    expect(page.stopWaiting).toHaveBeenCalled();
  });

  it("decides nothing for a pane change that is followed by another before the panel sits still", () => {
    start();
    show("quota", 700);
    expect(dragSide).toHaveBeenCalledTimes(1);

    page.still = false;
    move(320, false);
    move(320, true);
    page.settle();

    // The panel went out and back; it was never seen still without Quota.
    expect(dragSide).toHaveBeenCalledTimes(1);
  });

  it("stops the pane watcher and the wait when the plugin goes", () => {
    start();
    show("quota", 700);

    for (const cleanup of [...solid.effectCleanups.splice(0), ...solid.pluginCleanups.splice(0)]) {
      cleanup();
    }

    expect(page.stopTabs).toHaveBeenCalledTimes(1);
    expect(page.stopWaiting).toHaveBeenCalled();
  });

  it("keeps the hand-drag watcher through the effect's re-runs, and stops it with the plugin", () => {
    const stopDrags = vi.fn();
    vi.mocked(watchHandDrags).mockReturnValueOnce(stopDrags);
    start();

    show("quota", 700);
    show("other", 320);
    show("quota", 700);
    expect(watchHandDrags).toHaveBeenCalledTimes(1);
    expect(stopDrags).not.toHaveBeenCalled();

    for (const cleanup of solid.pluginCleanups.splice(0)) cleanup();
    expect(stopDrags).toHaveBeenCalledTimes(1);
  });

  it("opens the plugin's storage once, before any effect runs, and uses what it holds", () => {
    const set = vi.fn();
    const store = vi.fn(() => ({ value: { quota: 450, other: 700 }, ready: () => true, set }));
    vi.stubGlobal("require", () => ({ Schema: { Struct: (fields: object) => fields, Finite: 0 } }));
    const ctx = {
      sessions: { current: () => screen.session },
      storage: { store },
      layout: {
        narrow: () => screen.narrow,
        side: { opened: () => screen.open },
        state: () => screen.quota,
      },
    } as unknown as Context;

    followSideWidth(ctx, "opencode-quota:quota");
    expect(store).toHaveBeenCalledTimes(1);
    expect(store).toHaveBeenCalledWith(
      "side-width",
      expect.objectContaining({ initial: expect.anything() }),
    );
    expect(solid.effects).toHaveLength(1);

    rerun();
    show("quota", 700);
    show("other", 450);
    rerun();

    expect(store).toHaveBeenCalledTimes(1);
    expect(dragSide).toHaveBeenNthCalledWith(1, page.panel, 250);
    expect(dragSide).toHaveBeenNthCalledWith(2, page.panel, -250);
  });

  it("stops waiting for the panel to sit still when the user takes the divider", () => {
    start();
    const [started] = vi.mocked(watchHandDrags).mock.calls[0] ?? [];

    started?.();

    expect(page.stopWaiting).toHaveBeenCalledTimes(1);
  });

  it("tries again at the next change when the user was dragging", () => {
    start();
    vi.mocked(dragSide).mockReturnValueOnce(false);
    show("quota", 700);
    show("quota", 700);

    expect(dragSide).toHaveBeenCalledTimes(2);
  });

  it("leaves the width alone with the side panel closed, on a narrow screen, on Home, or on another server", () => {
    start();
    vi.mocked(whenSideStill).mockClear();

    screen.open = false;
    show("quota", 700);
    screen.open = true;
    screen.narrow = true;
    show("quota", 700);
    screen.narrow = false;
    screen.session = undefined;
    show("quota", 700);
    screen.session = { key: "remote\nses_2", server: { builtin: false } };
    show("quota", 700);

    expect(whenSideStill).not.toHaveBeenCalled();
    expect(dragSide).not.toHaveBeenCalled();
  });

  it("keeps each session's own state: a session already sized is left as it is", () => {
    start();
    show("quota", 700);
    screen.session = { key: "local\nses_2", server: { builtin: true } };
    show("other", 500);
    screen.session = SESSION;
    show("quota", 320);

    expect(dragSide).toHaveBeenCalledTimes(1);
  });

  it("falls back to the app's own width when the trick throws, and says so once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    start();
    vi.mocked(dragSide).mockImplementation(() => {
      throw new Error("no divider");
    });

    show("quota", 700);
    show("other", 320);
    show("quota", 700);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no divider"));
    warn.mockRestore();
  });

  it("falls back when the app's layout answers differently than expected", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = { sessions: { current: () => SESSION }, layout: {} } as unknown as Context;
    followSideWidth(ctx, "opencode-quota:quota");

    expect(() => rerun()).not.toThrow();
    expect(whenSideStill).not.toHaveBeenCalled();
    expect(dragSide).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
