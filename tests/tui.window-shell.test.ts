/**
 * The quota window (`src/tui/window/shell.tsx`) on a fake OpenCode host whose server answers
 * when the test says so: answers that arrive out of order, Plugin's sections, and the keyboard
 * when OpenCode draws the window again.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { QuotaSnapshot } from "../src/core/types.js";
import {
  DEFAULT_USAGE_RANGE,
  parseUsageArguments,
  USAGE_RANGES,
  usageRangeLabel,
} from "../src/core/usage-ranges.js";
import { type UsageQuery, usageReport } from "../src/core/usage.js";
import { quotaLimitsText } from "../src/lib/quota-report-message.js";
import type {
  QuotaRpcNoticeListInput,
  QuotaRpcNoticeListOutput,
  QuotaRpcSaveSettingsInput,
} from "../src/rpc.js";
import { createFileDisplay, setIn } from "../src/tui/display.js";
import { createServerSettings } from "../src/tui/server-settings.js";
import { createSettingsEditor } from "../src/tui/window/settings.tsx";
import { createQuotaWindow, type QuotaWindow } from "../src/tui/window/shell.tsx";
import type { UsageChoice } from "../src/tui/window/usage.tsx";
import { providerSnapshot, quotaRow } from "./helpers/fake-answers.js";
import { createFakeTuiHost, type FakeBox, stubJsx } from "./helpers/fake-tui-host.js";
import {
  activeLabels,
  clickable,
  findAll,
  type Node,
  settingLine,
  THEME,
  textLines,
  words,
} from "./helpers/jsx-tree.js";
import { localDate, writeUsageHistory } from "./helpers/usage-history.js";

/** The range list's line under the default range, where ↓ goes from it. */
const RANGE_AFTER_DEFAULT =
  USAGE_RANGES[USAGE_RANGES.findIndex((item) => item.range === DEFAULT_USAGE_RANGE) + 1]?.label;

/** The terminal's size, as the Usage tab's popup reads it. */
const terminal = vi.hoisted(() => ({ size: { width: 120, height: 40 } }));
vi.mock("@opentui/solid", () => ({ useTerminalDimensions: () => () => terminal.size }));

/** Clicks the innermost clickable part that shows `text`. */
function click(tree: unknown, text: string): void {
  const target = findAll(
    tree,
    (node) =>
      typeof node.props?.onMouseUp === "function" &&
      textLines(node).some((line) => line.includes(text)),
  ).at(-1);
  if (!target) throw new Error(`nothing clickable shows ${text}`);
  target.props.onMouseUp();
}

/** Clicks the › of the option line titled `title`, as a click on its value does. */
function clickLine(tree: unknown, title: string): void {
  const line = findAll(
    tree,
    (node) =>
      node.type === "box" &&
      typeof node.props?.onMouseDown === "function" &&
      textLines(node).some((text) => text.includes(title)),
  ).at(-1);
  if (!line) throw new Error(`no option line shows ${title}`);
  click(line, "›");
}

/** Lets the answered requests run to their end. */
async function flush(): Promise<void> {
  for (let step = 0; step < 20; step += 1) await Promise.resolve();
}

/**
 * The window on a fake host; `snapshot` is the quota every surface shows (none by default), and
 * `answers` are more of the server's RPC methods.
 */
function fakeHost(snapshot?: QuotaSnapshot, answers: Record<string, unknown> = {}) {
  // The server's notices; the answer comes when the test says so.
  const server = {
    notices: [
      { id: "a", message: "Copilot moves to AI Credits." },
      { id: "b", message: "v6 is out." },
    ],
    /** The saved settings by dotted key, as the settings RPC answers them. */
    values: {} as Record<string, unknown>,
  };
  const saveCalls: QuotaRpcSaveSettingsInput[] = [];
  const noticeCalls: Array<{
    input: QuotaRpcNoticeListInput;
    answered: boolean;
    answer(): void;
    fail(message: string): void;
  }> = [];
  const statusCalls: Array<{ answered: boolean; answer(text: string): void }> = [];

  const tui = createFakeTuiHost({
    rpc: {
      noticeList: (input: QuotaRpcNoticeListInput) => {
        const board: QuotaRpcNoticeListOutput = {
          notices: server.notices.map((notice) => ({ ...notice })),
        };
        return new Promise<QuotaRpcNoticeListOutput>((resolve, reject) => {
          const call = {
            input,
            answered: false,
            answer: () => {
              call.answered = true;
              resolve(board);
            },
            // RPC calls reject with a plain { type, message } object.
            fail: (message: string) => {
              call.answered = true;
              reject({ type: "UnknownError", message });
            },
          };
          noticeCalls.push(call);
        });
      },
      status: () =>
        new Promise<{ text: string }>((resolve) => {
          const call = {
            answered: false,
            answer: (text: string) => {
              call.answered = true;
              resolve({ text });
            },
          };
          statusCalls.push(call);
        }),
      ...answers,
    },
    route: { type: "session", sessionID: "ses_1" },
    theme: THEME,
  });
  const api = tui.context;
  const display = createFileDisplay(
    createServerSettings({
      settings: async () => ({
        values: { ...server.values },
        fromFile: [],
        providers: [],
        custom: [],
      }),
      saveSettings: async (input) => {
        saveCalls.push(input);
        const system = (input.patch.system ?? {}) as Record<string, unknown>;
        for (const [key, value] of Object.entries(system)) server.values[`system.${key}`] = value;
        return { ok: true, issues: [] };
      },
    }),
  );
  const settings = createSettingsEditor(api as never, display, () => {});
  const surface = {
    theme: () => THEME,
    display: display.shown,
    quota: {
      snapshot: () => snapshot,
      watch: () => () => {},
      refresh: async () => undefined,
    },
    editing: settings,
  };
  const quotaWindow = createQuotaWindow(api as never, surface as never, settings);
  return {
    ...tui,
    quotaWindow,
    settings,
    display,
    server,
    noticeCalls,
    statusCalls,
    saveCalls,
  };
}

/** Draws the window as OpenCode's slot does; `dispose` takes it away again. */
function draw(quotaWindow: QuotaWindow) {
  return createRoot((dispose) => ({ tree: quotaWindow.Slot({ sessionID: "ses_1" }), dispose }));
}

/** Gives the drawn window its box, as OpenTUI does when it creates it. */
function mount(tree: unknown, box: FakeBox): void {
  findAll(tree, (node) => node.type === "box" && node.props.focusable === true)[0]?.props.ref(box);
}

describe("quota window shell", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stubJsx();
  });

  it("saves a Plugin switch straight away and shows the saved value", async () => {
    const host = fakeHost();
    host.quotaWindow.open("system");
    await flush();

    // Two quick clicks send one save; the line shows what the server saved.
    let view = draw(host.quotaWindow);
    expect(textLines(view.tree)).toEqual(
      expect.arrayContaining([
        " Commands",
        expect.stringContaining("Old command names"),
        " For other tools",
        expect.stringContaining("Quota file (JSON)"),
        "off",
        expect.stringContaining("OpenTelemetry metrics"),
      ]),
    );
    clickLine(view.tree, "Quota file (JSON)");
    clickLine(view.tree, "Quota file (JSON)");
    view.dispose();
    await flush();
    expect(host.saveCalls).toEqual([{ patch: { system: { exportFile: true } } }]);
    view = draw(host.quotaWindow);
    const fileLine = findAll(
      view.tree,
      (node) =>
        node.type === "box" &&
        typeof node.props?.onMouseDown === "function" &&
        textLines(node).some((text) => text.includes("Quota file (JSON)")),
    ).at(-1);
    expect(textLines(fileLine).map((text) => text.trim())).toContain("on");

    // The next click turns it off again; telemetry and the old command names save their own key.
    clickLine(view.tree, "Quota file (JSON)");
    clickLine(view.tree, "OpenTelemetry metrics");
    clickLine(view.tree, "Old command names");
    view.dispose();
    await flush();
    expect(host.saveCalls.slice(1)).toEqual([
      { patch: { system: { exportFile: false } } },
      { patch: { system: { telemetry: true } } },
      { patch: { system: { oldCommands: false } } },
    ]);
  });

  it("shows and copies the newest status report after closing and opening again", async () => {
    const host = fakeHost();
    host.quotaWindow.open("system");
    const first = draw(host.quotaWindow);
    host.press("window", "escape");
    first.dispose();
    host.quotaWindow.open("system");
    host.statusCalls[1]?.answer("# Quota Status (new)");
    host.statusCalls[0]?.answer("# Quota Status (old)");
    await flush();

    const lines = textLines(draw(host.quotaWindow).tree);
    expect(lines).toContain("# Quota Status (new)");
    expect(lines).not.toContain("# Quota Status (old)");
    host.press("window", "return");
    expect(host.copied).toEqual(["# Quota Status (new)"]);
  });

  it("shows Plugin's notices, switches and status report under their own titles", async () => {
    const host = fakeHost();
    host.quotaWindow.open("system");
    host.noticeCalls[0]?.answer();
    host.statusCalls[0]?.answer("# Quota Status");
    await flush();

    const lines = textLines(draw(host.quotaWindow).tree);
    const at = (text: string) => lines.findIndex((line) => line.includes(text));
    expect(lines).toEqual(
      expect.arrayContaining([" Notices", "   • ", "Copilot moves to AI Credits."]),
    );
    expect(at(" Notices")).toBeLessThan(at("Copilot moves to AI Credits."));
    expect(at("v6 is out.")).toBeLessThan(at(" Commands"));
    expect(at(" Commands")).toBeLessThan(at(" For other tools"));
    expect(at(" For other tools")).toBeLessThan(at(" Status report"));
    expect(at(" Status report")).toBeLessThan(at("Copy the report"));
    expect(at("Copy the report")).toBeLessThan(at("# Quota Status"));
  });

  it("asks for the notices each time Plugin shows, and shows the newest answer", async () => {
    const host = fakeHost();
    host.quotaWindow.open("system");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.noticeCalls).toHaveLength(1);

    // A notice starts; Plugin shows again and its answer comes before the older one.
    host.server.notices.push({ id: "c", message: "A new notice." });
    host.quotaWindow.open("limits");
    host.quotaWindow.open("system");
    expect(host.noticeCalls).toHaveLength(2);
    host.noticeCalls[1]?.answer();
    host.noticeCalls[0]?.answer();
    await flush();
    expect(textLines(draw(host.quotaWindow).tree)).toContain("A new notice.");
  });

  it("says why the notices could not load, and asks again the next time Plugin shows", async () => {
    const host = fakeHost();
    host.quotaWindow.open("system");
    host.noticeCalls[0]?.fail("the server is gone");
    await flush();
    expect(textLines(draw(host.quotaWindow).tree)).toContain(
      "   Couldn't load the notices: the server is gone",
    );

    host.quotaWindow.open("limits");
    host.quotaWindow.open("system");
    host.noticeCalls[1]?.answer();
    await flush();
    const lines = textLines(draw(host.quotaWindow).tree);
    expect(lines).toContain("Copilot moves to AI Credits.");
    expect(lines.join("\n")).not.toContain("Couldn't load the notices");
  });

  it.each([
    { order: "OpenCode's listener first", windowListenerFirst: false },
    { order: "the window's listener first", windowListenerFirst: true },
  ])(
    "takes the keyboard back when a resize gives it to the message box ($order)",
    async ({ windowListenerFirst }) => {
      const host = fakeHost();
      const messageBox = host.box();
      messageBox.focus();
      // Across the sidebar's breakpoint, OpenCode gives the keyboard to its message box.
      const openCodeListener = () => messageBox.focus();
      if (!windowListenerFirst) host.resizeListeners.push(openCodeListener);
      host.quotaWindow.open("limits");
      const view = draw(host.quotaWindow);
      const windowBox = host.box();
      mount(view.tree, windowBox);
      if (windowListenerFirst) host.resizeListeners.push(openCodeListener);
      await vi.advanceTimersByTimeAsync(50);
      expect(host.keyboard.current).toBe(windowBox);

      // Narrower, then wider again: Esc and Tab still reach the window.
      for (const _direction of ["narrower", "wider"]) {
        host.resize();
        await vi.advanceTimersByTimeAsync(0);
        expect(host.keyboard.current).toBe(windowBox);
      }

      // A click on the message box takes the keyboard on purpose, and a resize leaves it there.
      messageBox.focus();
      await vi.advanceTimersByTimeAsync(0);
      host.resize();
      await vi.advanceTimersByTimeAsync(0);
      expect(host.keyboard.current).toBe(messageBox);
      view.dispose();
      expect(host.resizeListeners).toEqual([openCodeListener]);
    },
  );

  it("keeps the keyboard when OpenCode draws the window again, unless something took it", async () => {
    const host = fakeHost();
    const messageBox = host.box();
    messageBox.focus();
    host.quotaWindow.open("limits");
    let view = draw(host.quotaWindow);
    let windowBox = host.box();
    mount(view.tree, windowBox);
    await vi.advanceTimersByTimeAsync(50);
    expect(host.keyboard.current).toBe(windowBox);

    /** A new window, the old one destroyed a moment later, as @opentui/solid does. */
    async function redraw(): Promise<void> {
      const old = windowBox;
      view.dispose();
      view = draw(host.quotaWindow);
      windowBox = host.box();
      mount(view.tree, windowBox);
      old.destroy();
      await vi.advanceTimersByTimeAsync(0);
    }

    await redraw();
    expect(host.keyboard.current).toBe(windowBox);
    expect(host.layer("window").target?.()).toBe(windowBox);

    // A click on the message box takes the keyboard on purpose; a later redraw leaves it there.
    messageBox.focus();
    await vi.advanceTimersByTimeAsync(0);
    await redraw();
    expect(host.keyboard.current).toBe(messageBox);

    // Clicking the window takes it back; esc closes and gives it to the message box.
    windowBox.focus();
    host.press("window", "escape");
    expect(host.keyboard.current).toBe(messageBox);
    view.dispose();
  });

  it("says Limits is loading three columns in, as its rows will be", () => {
    const host = fakeHost();
    host.quotaWindow.open("limits");
    const view = draw(host.quotaWindow);
    expect(textLines(view.tree)).toContain("   Loading quota…");
    view.dispose();
  });

  it("edits Collapsed's windows from a click on For all providers and on a provider's ‹ ›", async () => {
    const snapshot: QuotaSnapshot = {
      version: 6,
      generatedAtMs: 0,
      resetNotices: [],
      providers: [
        providerSnapshot("openai", "OpenAI", [
          quotaRow("openai.five_hour", { label: "5h", window: "five_hour", percentRemaining: 65 }),
          quotaRow("openai.weekly", { label: "Weekly", window: "week", percentRemaining: 26 }),
        ]),
      ],
    };
    const host = fakeHost(snapshot);
    host.quotaWindow.open("collapsed");
    await flush();
    let view = draw(host.quotaWindow);
    clickLine(view.tree, "For all providers");
    view.dispose();
    view = draw(host.quotaWindow);
    click(view.tree, "‹ 5h ");
    view.dispose();
    expect(host.display.shown().collapsed.window).toEqual({ "*": "five_hour", openai: "week" });
  });

  it("shows a row's newest label or saved name as its rename placeholder while typing", async () => {
    const cursor = (label: string) =>
      providerSnapshot("cursor", "Cursor", [quotaRow("cursor.api", { label })]);
    const snapshot: QuotaSnapshot = {
      version: 6,
      generatedAtMs: 0,
      resetNotices: [],
      providers: [cursor("Known API")],
    };
    const host = fakeHost(snapshot);
    host.quotaWindow.open("sidebar");
    await flush();
    let view = draw(host.quotaWindow);
    const row = findAll(
      view.tree,
      (node) =>
        typeof node.props?.onMouseDown === "function" &&
        textLines(node).some((line) => line.includes("Known API")),
    ).at(-1);
    row?.props.onMouseDown({ button: 0 });
    row?.props.onMouseDown({ button: 0 });
    view.dispose();
    /** The rename input's placeholder, as the window draws it now. */
    const placeholder = () => {
      view = draw(host.quotaWindow);
      const input = findAll(view.tree, (node) => node.type === "input")[0];
      view.dispose();
      return input?.props.placeholder;
    };
    expect(placeholder()).toBe("Known API");
    snapshot.providers = [cursor("API")];
    expect(placeholder()).toBe("API");
    host.display.edit((settings) => setIn(settings, ["sidebar", "names", "cursor.api"], "Mine"));
    expect(placeholder()).toBe("Mine");
  });

  it("says Limits is still loading when c has nothing to copy yet", () => {
    const host = fakeHost();
    host.quotaWindow.open("limits");
    const view = draw(host.quotaWindow);
    host.press("window", "c");
    expect(host.copied).toEqual([]);
    expect(host.toast).toHaveBeenLastCalledWith(
      expect.objectContaining({
        variant: "info",
        title: "Limits",
        message: "Quota is still loading.",
      }),
    );
    view.dispose();
  });

  it("counts the Settings tree's reset times down with the window's clock", () => {
    const resetMs = Date.UTC(2026, 9, 18, 12);
    const snapshot: QuotaSnapshot = {
      version: 6,
      generatedAtMs: resetMs - 4 * 3_600_000,
      resetNotices: [],
      providers: [
        providerSnapshot("openai", "OpenAI", [
          quotaRow("openai.five_hour", {
            label: "5h",
            window: "five_hour",
            percentRemaining: 65,
            resetsAt: new Date(resetMs).toISOString(),
          }),
        ]),
      ],
    };
    const { settings } = fakeHost(snapshot);
    const body = (nowMs: number) =>
      createRoot(() =>
        textLines(
          settings.Body({
            tab: "sidebar",
            showPage: () => {},
            host: { quota: { snapshot: () => snapshot } } as never,
            sessionID: "ses_1",
            box: () => undefined,
            scroll: () => undefined,
            width: 80,
            nowMs,
          }),
        ).join("\n"),
      );

    expect(body(resetMs - 3 * 3_600_000)).toContain("65% left · 3h");
    expect(body(resetMs - 3_600_000)).toContain("65% left · 1h");
  });

  it("copies the limits on Limits as Web /quota writes them", () => {
    const nowMs = Date.now();
    const snapshot: QuotaSnapshot = {
      version: 6,
      generatedAtMs: nowMs,
      resetNotices: [],
      providers: [
        providerSnapshot(
          "openai",
          "OpenAI",
          [
            quotaRow("openai.five_hour", {
              label: "5h",
              window: "five_hour",
              percentRemaining: 65,
            }),
            quotaRow("openai.weekly", { label: "Weekly", window: "week", percentRemaining: 26 }),
          ],
          { checkedAtMs: nowMs },
        ),
      ],
    };
    const host = fakeHost(snapshot);
    host.quotaWindow.open("limits");
    const view = draw(host.quotaWindow);

    host.press("window", "c");
    expect(host.copied).toEqual([quotaLimitsText(snapshot, nowMs)]);
    expect(host.copied[0]).toBe("Quota\n● OpenAI  5h 65% left · 7d 26% left");
    expect(host.toast).toHaveBeenLastCalledWith(
      expect.objectContaining({
        variant: "success",
        title: "Limits",
        message: "Copied the limits report",
      }),
    );

    // Only Limits copies with c.
    host.quotaWindow.open("system");
    host.press("window", "c");
    expect(host.copied).toHaveLength(1);
    view.dispose();
  });

  it("names the page list's keys while a Layout page shows", () => {
    const host = fakeHost();
    host.quotaWindow.open("settings");
    expect(host.settings.hint("layout", true)).toBe(
      "↑↓ page · → or enter the page's lines · tab next tab · ctrl+s save · ctrl+r reset page · esc close",
    );
  });
});

/** The ids of the window's lit Settings lines, after their "quota-settings." prefix. */
function litSettingLines(tree: unknown): string[] {
  return findAll(
    tree,
    (node) =>
      String(node.props?.id ?? "").startsWith("quota-settings.") &&
      node.props.backgroundColor === "action-bg",
  ).map((node) => String(node.props.id).slice("quota-settings.".length));
}

/** Layout's page list: the box around its pages. */
function pageList(tree: unknown): Node | undefined {
  return findAll(
    tree,
    (node) =>
      node.type === "box" &&
      findAll(node.props.children, (child) => child.props?.id === "quota-layout-page-layout")
        .length > 0,
  ).at(-1);
}

describe("quota window: the Settings tabs on the keyboard", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  /** Opens Settings on `tab`, and on Layout on one of its pages ("Sidebar", "All places"). */
  async function openSettings(tab: string, page?: string) {
    const tui = fakeHost();
    stubJsx({ renderables: tui });
    tui.quotaWindow.open("settings");
    const windowTree = () => tui.quotaWindow.Slot({ sessionID: "ses_1" });
    // The tab bar shows the tabs around the current one; tab steps on to the others.
    for (let step = 0; step < 12 && !clickable(windowTree(), tab); step += 1) {
      tui.press("window", "tab");
    }
    clickable(windowTree(), tab).props.onMouseUp();
    if (page) clickable(windowTree(), page).props.onMouseUp();
    await vi.waitFor(() => expect(words(windowTree())).not.toContain("Loading settings…"));
    return { tui, windowTree };
  }

  it.each([
    { page: "All places", heading: " Preset", line: "Layout preset" },
    {
      page: "Sidebar",
      toggle: "   [x] Show the Quota panel in the session sidebar",
      heading: " What it shows",
      line: "Session tokens line",
    },
    {
      page: "Collapsed",
      toggle: "   [x] When the panel is collapsed, show one line per provider",
      heading: " What it shows",
      line: "Runs out in …",
    },
    {
      page: "Status line",
      toggle: "   [x] Show the quota line under the message box",
      heading: " When it shows",
      line: "Next to the sidebar",
    },
    {
      page: "Toast",
      toggle: "   [x] Show quota toasts",
      heading: " Preset",
      line: "When toasts show",
    },
  ])(
    "puts $page's first lines under a heading, and its switch under Enable/disable",
    async ({ page, toggle, heading, line }) => {
      const { windowTree } = await openSettings("Layout", page);
      await vi.waitFor(() => expect(textLines(windowTree())).toContain(heading));
      const lines = textLines(windowTree());
      if (toggle) expect(lines[lines.indexOf(toggle) - 1]).toBe(" Enable/disable");
      const at = lines.findIndex((text) => text.startsWith(`   ${line}`));
      expect(at).toBeGreaterThan(0);
      expect(lines[at - 1]).toBe(heading);
    },
  );

  it("closes with unsaved changes only after Save or Discard", async () => {
    const { tui, windowTree } = await openSettings("Layout", "All places");
    clickable(settingLine(windowTree(), "layout.barWidth"), "›").props.onMouseUp();
    clickable(windowTree(), "esc").props.onMouseUp();
    clickable(windowTree(), "esc").props.onMouseUp();
    expect(words(windowTree())).toContain("Keep your changes?");
    expect(tui.stored.has("settings")).toBe(false);
    clickable(windowTree(), "Discard").props.onMouseUp();
    expect(windowTree()).toBe("");
  });

  it("gives the typed text's keys to its input, and the window its keys back on a tab change", async () => {
    const { tui, windowTree } = await openSettings("Colors");
    const press = () =>
      settingLine(windowTree(), "colors.good")[0]?.props.onMouseDown({ button: 0 });
    press();
    press();
    const input = findAll(windowTree(), (node) => node.type === "input")[0];
    input?.props.ref(input);
    expect([tui.layer("typing").enabled?.(), tui.layer("typing").target?.()]).toEqual([
      true,
      input,
    ]);
    expect(tui.layer("window").enabled?.()).toBe(false);

    // Each render makes new nodes, so the window box is "the focusable box".
    clickable(windowTree(), "Layout").props.onMouseUp();
    expect(tui.layer("window").enabled?.()).toBe(true);
    expect(tui.keyboard.current).toMatchObject({ type: "box", props: { focusable: true } });
  });

  it("lists Layout's pages left of the body: ↑↓ change the page, → or enter go to its lines, ↑ on the first line goes back", async () => {
    const { tui, windowTree } = await openSettings("Layout");
    // /quota_settings opens Layout on All places; its page list has the keyboard, so no line
    // is lit.
    expect(activeLabels(windowTree())).toEqual(expect.arrayContaining(["Layout", "All places"]));
    await vi.waitFor(() => expect(settingLine(windowTree(), "words.detail")).not.toEqual([]));
    expect(litSettingLines(windowTree())).toEqual([]);

    // The pages are a column with a line at its right, left of the scrolling body, like
    // Usage's ranges.
    const tree = windowTree();
    const list = pageList(tree);
    expect(textLines(list).map((line) => line.trim())).toEqual([
      "› All places",
      "Sidebar",
      "Collapsed",
      "Status line",
      "Toast",
    ]);
    // The chosen page's › in the title's column, every label two columns in, as wide as
    // Usage's range list. The page's lines start right after the list's line: they carry their
    // own indent.
    expect(textLines(list).slice(0, 2)).toEqual(["› All places   ", "  Sidebar      "]);
    expect(list?.props.width).toBe(16);
    expect(list?.props).toMatchObject({
      marginRight: 0,
      flexDirection: "column",
      border: ["right"],
      overflow: "hidden",
    });
    const row = findAll(
      tree,
      (node) => Array.isArray(node.props?.children) && node.props.children.includes(list),
    )[0];
    expect(row?.props.flexDirection).toBe("row");
    const rightOfList = row?.props.children.slice(row.props.children.indexOf(list) + 1);
    expect(findAll(rightOfList, (node) => node.type === "scrollbox")).toHaveLength(1);
    // On a short window the switch and warning above the body end at the bottom line too.
    expect(rightOfList?.[0]?.props.overflow).toBe("hidden");

    // All places: the layout lines, Wording above the words lines it sets, then What shows.
    const lineIds = findAll(windowTree(), (node) =>
      String(node.props?.id ?? "").startsWith("quota-settings."),
    ).map((node) => String(node.props.id).slice("quota-settings.".length));
    expect(lineIds).toEqual([
      "preset.layout",
      "layout.bar",
      "layout.barWidth",
      "layout.evenUse",
      "layout.indent",
      "layout.labelWidth",
      "layout.providerGap",
      "layout.separator",
      "preset.words",
      "words.percent",
      "words.reset",
      "words.resetDecimals",
      "words.rowNames",
      "words.detail",
      "words.onlyCurrentModel",
      "words.sessionTokens",
    ]);
    expect(words(windowTree())).toEqual(expect.arrayContaining(["Words", "What shows"]));
    expect(words(settingLine(windowTree(), "preset.words"))).toContain(
      "sets Percent, Reset times and Row names",
    );
    expect(words(settingLine(windowTree(), "preset.layout"))).toContain(
      "sets Bar width and the 3 Spacing lines",
    );

    // ↓ shows the next page at once, ↑ the one before; above the first page ↑ stays there.
    tui.press("tab", "down");
    expect(activeLabels(windowTree())).toContain("Sidebar");
    tui.press("tab", "down");
    expect(activeLabels(windowTree())).toContain("Collapsed");
    tui.press("tab", "up");
    expect(activeLabels(windowTree())).toContain("Sidebar");

    // → goes to the page's first line, its switch; ↑ there goes back to the list.
    tui.press("tab", "right");
    expect(litSettingLines(windowTree())).toEqual(["surface"]);
    tui.press("tab", "up");
    expect(litSettingLines(windowTree())).toEqual([]);
    tui.press("tab", "up");
    expect(activeLabels(windowTree())).toContain("All places");
    tui.press("tab", "up");
    expect(activeLabels(windowTree())).toContain("All places");

    // Enter goes to All places' first line, its first option; ←/→ there change its value.
    tui.press("tab", "return");
    expect(litSettingLines(windowTree())).toEqual(["preset.layout"]);
    const preset = words(settingLine(windowTree(), "preset.layout"));
    tui.press("tab", "right");
    expect(words(settingLine(windowTree(), "preset.layout"))).not.toEqual(preset);
    expect(activeLabels(windowTree())).toContain("All places");
    tui.press("tab", "down");
    expect(litSettingLines(windowTree())).toEqual(["layout.bar"]);
    tui.press("tab", "up");
    tui.press("tab", "up");
    expect(litSettingLines(windowTree())).toEqual([]);

    // A click on a page shows it and gives the list the keyboard, even on the page shown.
    tui.press("tab", "return");
    clickable(windowTree(), "All places").props.onMouseUp();
    expect(litSettingLines(windowTree())).toEqual([]);
    clickable(windowTree(), "Toast").props.onMouseUp();
    expect(activeLabels(windowTree())).toContain("Toast");
    tui.press("tab", "up");
    expect(activeLabels(windowTree())).toContain("Status line");
    tui.press("tab", "down");

    // Back on Layout from another tab: the page shown last.
    clickable(windowTree(), "Colors").props.onMouseUp();
    clickable(windowTree(), "Layout").props.onMouseUp();
    expect(activeLabels(windowTree())).toContain("Toast");
    expect(words(windowTree())).toContain("Reset page");
  });

  it("has no /quota form setting on the Layout tab", async () => {
    const { tui, windowTree } = await openSettings("Layout", "All places");
    expect(words(windowTree())).not.toContain("/quota shows");
    expect(tui.stored.has("settings")).toBe(false);
  });

  it("opens OpenCode's theme list from the theme line's ▸", async () => {
    const { tui, windowTree } = await openSettings("Colors");
    clickable(settingLine(windowTree(), "theme"), "▸").props.onMouseUp();
    expect(tui.dispatch).toHaveBeenCalledWith("theme.switch");
  });

  it("takes the keyboard back after Light or dark gives it to the message box", async () => {
    const { tui, windowTree } = await openSettings("Colors");
    const windowBox = { type: "box", props: { focusable: true } };
    const messageBox = tui.box();
    await vi.waitFor(() => expect(tui.keyboard.current).toMatchObject(windowBox));
    // OpenCode's switch closes its dialogs, which focuses the message box a moment later.
    tui.dispatch.mockImplementationOnce(() => setTimeout(messageBox.focus, 1));
    clickable(settingLine(windowTree(), "themeMode"), "›").props.onMouseUp();
    expect(tui.dispatch).toHaveBeenCalledWith("theme.switch_mode");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(tui.keyboard.current).toBe(messageBox);
    await vi.waitFor(() => expect(tui.keyboard.current).toMatchObject(windowBox));
  });
});

/** The ids of the Usage tab's lit model rows. */
function litUsageLines(node: unknown): string[] {
  return findAll(node, (item) => String(item.props?.id ?? "").startsWith("quota-usage-"))
    .filter(
      (item) =>
        item.props.backgroundColor === "action-bg" ||
        findAll(item.props.children, (child) => child.props?.style?.bg === "action-bg").length > 0,
    )
    .map((item) => String(item.props.id));
}

/** OpenTUI inputs as the Usage tab uses them: a value, and focus with its events. */
function fakeInputs(values: string[]) {
  type FakeInput = {
    value: string;
    focused: boolean;
    on(name: string, listener: () => void): void;
    focus(): void;
    moveCursorLeft(): void;
    moveCursorRight(): void;
  };
  const listeners = new Map<FakeInput, Map<string, () => void>>();
  const inputs: FakeInput[] = values.map((value) => {
    const input: FakeInput = {
      value,
      focused: false,
      on: (name, listener) => listeners.get(input)?.set(name, listener),
      focus: () => {
        for (const other of inputs) {
          if (other === input || !other.focused) continue;
          other.focused = false;
          listeners.get(other)?.get("blurred")?.();
        }
        input.focused = true;
        listeners.get(input)?.get("focused")?.();
      },
      moveCursorLeft: () => {},
      moveCursorRight: () => {},
    };
    listeners.set(input, new Map());
    return input;
  });
  return inputs;
}

describe("quota window: the Usage tab", () => {
  let root: string;
  const databasePath = () => join(root, "data", "opencode", "opencode.db");
  /** `/quota_usage 30d`. */
  const THIRTY_DAYS = parseUsageArguments("30d") as UsageChoice;

  beforeEach(async () => {
    vi.useRealTimers();
    root = await mkdtemp(join(tmpdir(), "quota-window-usage-"));
    vi.stubEnv("XDG_DATA_HOME", join(root, "data"));
    vi.stubEnv("XDG_CACHE_HOME", join(root, "cache"));
    vi.stubEnv("XDG_STATE_HOME", join(root, "state"));
    vi.stubEnv("OPENCODE_CONFIG_DIR", join(root, "config"));
    vi.stubEnv("OPENCODE_DB", "");
    terminal.size = { width: 120, height: 40 };
    writeUsageHistory(databasePath());
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  /** The window on a fake host whose server reads the usage history; a test can swap `answers`. */
  function usageHost() {
    const answers = {
      usage: async (query: UsageQuery) => ({ report: await usageReport(query) }),
    };
    const tui = fakeHost(undefined, { usage: (query: UsageQuery) => answers.usage(query) });
    stubJsx({ renderables: tui });
    const usageTab = () => tui.quotaWindow.Slot({ sessionID: "ses_1" });
    return { tui: { ...tui, answers }, usageTab };
  }

  it("keeps the newest range when an older answer arrives last", async () => {
    const { tui, usageTab } = usageHost();
    const usage = tui.answers.usage;
    let releaseFirst = () => {};
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    tui.answers.usage = async (input: UsageQuery) => {
      calls += 1;
      const answer = await usage(input);
      if (calls === 1) await firstHeld;
      return answer;
    };

    tui.quotaWindow.open("usage");
    clickable(usageTab(), "30 days").props.onMouseUp();
    await vi.waitFor(() =>
      expect(words(usageTab())).toContainEqual(expect.stringMatching(/ 2 sessions · /u)),
    );
    // Today's answer, asked first, arrives now; the tab keeps the last 30 days.
    releaseFirst();
    await vi.waitFor(() => expect(calls).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(words(usageTab())).toContainEqual(expect.stringMatching(/ 2 sessions · /u));
    expect(activeLabels(usageTab())).toContain("30 days");
  });

  it("starts Between on the month of the day it asks, not the day the plugin started", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 18, 12));
    const { tui, usageTab } = usageHost();
    const asked: UsageQuery[] = [];
    const usage = tui.answers.usage;
    tui.answers.usage = (query: UsageQuery) => {
      asked.push(query);
      return usage(query);
    };

    vi.setSystemTime(new Date(2026, 10, 3, 12));
    tui.quotaWindow.open("usage");
    clickable(usageTab(), "Between").props.onMouseUp();
    await vi.waitFor(() => expect(asked).toHaveLength(2));
    vi.useRealTimers();

    expect(asked[1]).toEqual(
      expect.objectContaining({ range: "between", from: "2026-11-01", to: "2026-11-03" }),
    );
  });

  it("applies two Between dates typed in the tab, and warns about dates out of order", async () => {
    const { tui, usageTab } = usageHost();
    tui.quotaWindow.open("usage");
    await vi.waitFor(() => expect(words(usageTab())).toContain("Breakdown"));

    clickable(usageTab(), "Between").props.onMouseUp();
    const [from, to] = fakeInputs([localDate(-12), localDate(-14)]);
    for (const [index, node] of findAll(usageTab(), (item) => item.type === "input").entries()) {
      node.props.ref([from, to][index]);
    }
    await vi.waitFor(() => expect(from?.focused).toBe(true));
    // While a date has the keyboard, the window's bottom line names the keys there.
    expect(words(usageTab())).toContain("enter next date tab other date esc back");

    tui.press("tab", "return");
    expect(to?.focused).toBe(true);
    expect(words(usageTab())).toContain("enter apply tab other date esc back");
    // A click on a date box stays with it: the window under it does not take the keyboard back.
    const click = { stopPropagation: vi.fn() };
    findAll(usageTab(), (item) => item.type === "input")[1]?.props.onMouseDown(click);
    expect(click.stopPropagation).toHaveBeenCalledOnce();
    expect(to?.focused).toBe(true);
    tui.press("tab", "return");
    expect(tui.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: "warning",
        message: "Type two dates like 2026-09-01, the first one not after the second.",
      }),
    );

    if (to) to.value = localDate(-8);
    tui.press("tab", "return");
    await vi.waitFor(() =>
      expect(words(usageTab())).toContainEqual(expect.stringMatching(/^1 ● mystery-old /u)),
    );
    expect(words(usageTab())).not.toContainEqual(expect.stringContaining("claude-sonnet-4-5"));
    // The boxes give way to the dates after the range's name.
    expect(findAll(usageTab(), (node) => node.type === "input")).toEqual([]);
    expect(words(usageTab())).toContainEqual(
      expect.stringMatching(/^\w{3} \d{1,2}(, \d{4})? – \w{3} \d{1,2}(, \d{4})?$/u),
    );
  });

  it("picks a range with ↑↓, walks the model rows after →, and switches what it shows with c, t and b", async () => {
    const { tui, usageTab } = usageHost();
    tui.quotaWindow.openUsage(THIRTY_DAYS);
    await vi.waitFor(() => expect(words(usageTab())).toContain("Breakdown"));
    // Headings are bold: a span takes `bold` from its style (it ignores `attributes`).
    expect(
      findAll(
        usageTab(),
        (node) => node.type === "span" && node.props.children === "Breakdown",
      ).map((node) => node.props.style.bold),
    ).toEqual([true]);
    // On a short window the range list cuts its lines instead of drawing over the key line.
    const rangeList = findAll(
      usageTab(),
      (node) =>
        node.type === "box" &&
        findAll(node.props.children, (child) => child.props?.id === "quota-usage-range-today")
          .length > 0,
    ).at(-1);
    expect(rangeList?.props.overflow).toBe("hidden");
    // The chosen range's › in the title's column, every label two columns in, as wide as
    // Layout's page list; the content starts one column after the list's line.
    expect(textLines(rangeList)).toEqual(
      expect.arrayContaining(["  Today        ", "› 30 days      ", "  This session "]),
    );
    expect(rangeList?.props.width).toBe(16);
    expect(rangeList?.props.marginRight).toBe(1);

    // The range list has the keyboard: ↑ shows 7 days at once, ↓ 30 days again. No row is lit.
    expect(litUsageLines(usageTab())).toEqual([]);
    tui.press("tab", "up");
    expect(activeLabels(usageTab())).toContain("7 days");
    tui.press("tab", "down");
    expect(activeLabels(usageTab())).toContain("30 days");
    await vi.waitFor(() =>
      expect(words(usageTab())).toContainEqual(expect.stringMatching(/ 2 sessions · /u)),
    );

    // → gives the model rows the keyboard, each lit alone; past the last one ↓ scrolls the
    // window. Enter opens the lit one's details.
    tui.press("tab", "right");
    expect(litUsageLines(usageTab())).toEqual(["quota-usage-model-0"]);
    tui.press("tab", "down");
    expect(litUsageLines(usageTab())).toEqual(["quota-usage-model-1"]);
    expect(tui.press("tab", "down")).toBe(false);
    tui.press("tab", "return");
    expect(tui.dialog.show).toHaveBeenCalledOnce();
    expect(words(tui.dialog.show.mock.calls[0]?.[0]())).toContain("● mystery-old");

    // t shows tokens and c cost, from the first row again; b breaks down by day, which has no
    // model rows, then by model again.
    tui.press("tab", "t");
    expect(activeLabels(usageTab())).toContain("Tokens");
    expect(litUsageLines(usageTab())).toEqual(["quota-usage-model-0"]);
    tui.press("tab", "c");
    expect(activeLabels(usageTab())).toContain("Cost");
    tui.press("tab", "b");
    expect(activeLabels(usageTab())).toContain("Day");
    expect(litUsageLines(usageTab())).toEqual([]);
    tui.press("tab", "b");
    expect(activeLabels(usageTab())).toContain("Model");

    // ← gives the range list the keyboard back.
    tui.press("tab", "left");
    expect(litUsageLines(usageTab())).toEqual([]);
    tui.press("tab", "up");
    expect(activeLabels(usageTab())).toContain("7 days");
  });

  it("gives the range list the keyboard when the tab shows again, and keeps it there without model rows", async () => {
    const { tui, usageTab } = usageHost();
    tui.quotaWindow.openUsage(THIRTY_DAYS);
    await vi.waitFor(() => expect(words(usageTab())).toContain("Breakdown"));
    tui.press("tab", "right");
    expect(litUsageLines(usageTab())).toEqual(["quota-usage-model-0"]);

    // Away to Limits and back: the reload fails, so there is no Breakdown line nor model rows.
    tui.answers.usage = async () => {
      throw new Error("usage history unreadable");
    };
    tui.press("window", "tab");
    usageTab();
    tui.press("window", "shift+tab");
    await vi.waitFor(() =>
      expect(words(usageTab())).toContainEqual(expect.stringContaining("Couldn't load the usage")),
    );
    expect(litUsageLines(usageTab())).toEqual([]);
    expect(tui.press("tab", "right")).toBe(false);
    tui.press("tab", "down");
    expect(activeLabels(usageTab())).toContain(RANGE_AFTER_DEFAULT);
  });

  it("shows the default range whenever you switch to the Usage tab, and keeps Cost or Tokens and Model or Day", async () => {
    const { tui, usageTab } = usageHost();
    const defaultLabel = usageRangeLabel(DEFAULT_USAGE_RANGE);
    tui.quotaWindow.openUsage(THIRTY_DAYS);
    await vi.waitFor(() => expect(words(usageTab())).toContain("Breakdown"));
    expect(activeLabels(usageTab())).toContain("30 days");
    tui.press("tab", "t");
    tui.press("tab", "b");

    // tab and shift+tab: back on Usage, the default range, still Tokens by day.
    tui.press("window", "tab");
    usageTab();
    tui.press("window", "shift+tab");
    expect(activeLabels(usageTab())).toEqual(
      expect.arrayContaining(["Usage", defaultLabel, "Tokens"]),
    );
    expect(activeLabels(usageTab())).not.toContain("30 days");
    await vi.waitFor(() => expect(activeLabels(usageTab())).toContain("Day"));

    // A click on the tab bar's Usage.
    clickable(usageTab(), "30 days").props.onMouseUp();
    expect(activeLabels(usageTab())).toContain("30 days");
    clickable(usageTab(), "Limits").props.onMouseUp();
    clickable(usageTab(), "Usage").props.onMouseUp();
    expect(activeLabels(usageTab())).toContain(defaultLabel);

    // The window opening on Usage from the command palette.
    clickable(usageTab(), "30 days").props.onMouseUp();
    tui.quotaWindow.open("limits");
    tui.quotaWindow.open("usage");
    expect(activeLabels(usageTab())).toContain(defaultLabel);

    // A command that names a range still shows it.
    tui.quotaWindow.openUsage(THIRTY_DAYS);
    expect(activeLabels(usageTab())).toContain("30 days");
    await vi.waitFor(() =>
      expect(words(usageTab())).toContainEqual(expect.stringMatching(/ 2 sessions · /u)),
    );

    // Model and Day sit at the right end of the Breakdown line, as Cost and Tokens do on the
    // first line: a spacer that grows sits between them and the heading.
    const optionsLine = (first: string) =>
      findAll(
        usageTab(),
        (node) =>
          node.type === "box" && node.props.flexDirection === "row" && textLines(node)[0] === first,
      ).at(-1)?.props.children as Node[];
    expect(optionsLine("Breakdown").map((child) => child.props.flexGrow)).toEqual([
      undefined,
      1,
      undefined,
    ]);
    expect(textLines(optionsLine("Breakdown").at(-1))).toEqual(["Model", "Day"]);
    expect(textLines(optionsLine("30 days").slice(-2))).toEqual(["Cost", "Tokens"]);
    expect(optionsLine("30 days").at(-3)?.props.flexGrow).toBe(1);
  });

  it("keeps the model popup's esc whole on a 32 × 16 terminal", async () => {
    terminal.size = { width: 32, height: 16 };
    await rm(databasePath());
    writeUsageHistory(databasePath(), "claude-sonnet-4-5-with-a-very-long-model-name");
    const { tui, usageTab } = usageHost();
    tui.quotaWindow.open("usage");
    await vi.waitFor(() => expect(words(usageTab())).toContain("Breakdown"));

    findAll(
      usageTab(),
      (node) => node.type === "text" && textLines(node)[0]?.includes("claude-sonnet-4-5") === true,
    )
      .find((node) => typeof node.props.onMouseUp === "function")
      ?.props.onMouseUp();
    const popup = tui.dialog.show.mock.calls[0]?.[0]();
    const header = findAll(
      popup,
      (node) => node.type === "box" && node.props.flexDirection === "row",
    )[0];
    const [title = "", close] = textLines(header);
    // The dialog is 30 columns on this terminal; its paddings leave 26 for the title and " esc".
    expect(close).toBe("esc");
    expect(title).toMatch(/^● claude-sonnet-4-5-.*…$/u);
    expect([...title].length + " esc".length).toBeLessThanOrEqual(26);
  });
});
