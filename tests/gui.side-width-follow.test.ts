import type { Context } from "@opencode/plugin/gui";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { followSideWidth } from "../src/gui/side-width-follow.js";
import { dragSide, watchHandDrags, whenSideStill } from "../src/gui/side-width.js";

/**
 * The effects and cleanups `followSideWidth` registers with Solid; on the server build effects
 * never run by themselves, so the tests run them.
 */
const solid = vi.hoisted(() => ({
  effects: [] as Array<() => void>,
  cleanups: [] as Array<() => void>,
}));
vi.mock("solid-js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("solid-js")>()),
  createEffect: (effect: () => void) => {
    solid.effects.push(effect);
  },
  onCleanup: (cleanup: () => void) => {
    solid.cleanups.push(cleanup);
  },
}));

/** The page: what the DOM module finds. Its calls are the trick's only effect. */
const page = vi.hoisted(() => ({
  panel: { width: 700, showsQuota: false, divider: {} },
  stopWaiting: undefined as unknown as () => void,
}));
vi.mock("../src/gui/side-width.js", () => ({
  dragSide: vi.fn(() => true),
  watchHandDrags: vi.fn(() => () => {}),
  whenSideStill: vi.fn((ready: (panel: unknown) => void) => {
    ready(page.panel);
    return page.stopWaiting;
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
  for (const cleanup of solid.cleanups.splice(0)) cleanup();
  for (const effect of solid.effects) effect();
}

/** The panel as the page shows it: `width` pixels, with Quota or another tab. */
function show(tab: "quota" | "other", width: number) {
  screen.quota = tab === "quota" ? "visible" : "open";
  page.panel.width = width;
  page.panel.showsQuota = tab === "quota";
  rerun();
}

beforeEach(() => {
  solid.effects.length = 0;
  solid.cleanups.length = 0;
  page.panel.width = 700;
  page.panel.showsQuota = false;
  page.stopWaiting = vi.fn();
  screen = { session: SESSION, open: true, quota: "open", narrow: false };
  vi.mocked(dragSide).mockClear().mockReturnValue(true);
  vi.mocked(whenSideStill).mockClear();
  vi.mocked(watchHandDrags).mockClear();
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

  it("waits for the Quota tab to show inside the panel before narrowing it", () => {
    start();
    show("quota", 700);

    expect(vi.mocked(whenSideStill).mock.calls.map((call) => call[1])).toEqual([false, true]);
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
    ended?.({ ...page.panel, width: 450, showsQuota: true } as never);
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

    ended?.({ ...page.panel, width: 540, showsQuota: false } as never);
    show("quota", 540);
    show("other", 320);

    expect(dragSide).toHaveBeenLastCalledWith(page.panel, -220);
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
