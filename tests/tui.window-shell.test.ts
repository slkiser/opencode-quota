/**
 * The quota window (`src/tui/window/shell.tsx`) on a fake OpenCode host whose server answers
 * when the test says so: answers that arrive out of order, Plugin's sections, and the keyboard
 * when OpenCode draws the window again.
 */
import { createRoot } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { QuotaSnapshot } from "../src/core/types.js";
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
import { providerSnapshot, quotaRow } from "./helpers/fake-answers.js";
import { findAll, THEME, textLines } from "./helpers/jsx-tree.js";

type Key = { bind: string; run: () => void };
type Layer = { target: () => unknown; priority?: number; commands: Key[] };
/** The window's own keys; the Usage tab's sit above them (11). */
const WINDOW_KEYS_PRIORITY = 10;

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

/** A renderable that can have the keyboard; focusing one blurs the last one, as in OpenTUI. */
type FakeBox = {
  isDestroyed: boolean;
  focused: boolean;
  on(event: string, listener: () => void): void;
  focus(): void;
  blur(): void;
  destroy(): void;
};

/** The window on a fake host; `snapshot` is the quota every surface shows (none by default). */
function fakeHost(snapshot?: QuotaSnapshot) {
  const keyboard: { current?: FakeBox } = {};
  const box = (): FakeBox => {
    const listeners = new Map<string, Array<() => void>>();
    const emit = (event: string) => {
      for (const listener of listeners.get(event) ?? []) listener();
    };
    const self: FakeBox = {
      isDestroyed: false,
      focused: false,
      on: (event, listener) => listeners.set(event, [...(listeners.get(event) ?? []), listener]),
      focus() {
        if (self.isDestroyed || self.focused) return;
        self.focused = true;
        const previous = keyboard.current;
        keyboard.current = self;
        previous?.blur();
        emit("focused");
      },
      blur() {
        if (!self.focused) return;
        if (keyboard.current === self) keyboard.current = undefined;
        self.focused = false;
        emit("blurred");
      },
      // OpenTUI marks a renderable destroyed, then blurs it.
      destroy() {
        self.isDestroyed = true;
        self.blur();
      },
    };
    return self;
  };

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
  const layers: Layer[] = [];
  const copied: string[] = [];
  const resizeListeners: Array<() => void> = [];

  const api = {
    location: { directory: "/project" },
    theme: THEME,
    client: {
      rpc: () => ({
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
      }),
    },
    data: {},
    renderer: {
      root: { on: () => {}, off: () => {} },
      on: (_event: "resize", listener: () => void) => resizeListeners.push(listener),
      off: (_event: "resize", listener: () => void) =>
        resizeListeners.splice(resizeListeners.indexOf(listener), 1),
      get currentFocusedRenderable() {
        return keyboard.current ?? null;
      },
      copyToClipboardOSC52: (text: string) => {
        copied.push(text);
        return true;
      },
    },
    keymap: { layer: (build: () => Layer) => layers.push(build()) },
    ui: {
      router: { current: () => ({ type: "session", sessionID: "ses_1" }) },
      toast: { show: vi.fn() },
    },
  };
  const display = createFileDisplay(
    createServerSettings({
      settings: async () => ({ values: { ...server.values }, providers: [], custom: [] }),
      saveSettings: async (input) => {
        saveCalls.push(input);
        const system = (input.patch.system ?? {}) as Record<string, unknown>;
        for (const [key, value] of Object.entries(system)) server.values[`system.${key}`] = value;
        return { ok: true, issues: [] };
      },
    }),
  );
  const settings = createSettingsEditor(api as never, display, api.ui.toast.show);
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
  /** The terminal changes size: OpenTUI calls every resize listener, in the order they came. */
  const resize = () => {
    for (const listener of resizeListeners.slice()) listener();
  };
  return {
    quotaWindow,
    settings,
    display,
    toasts: api.ui.toast.show,
    server,
    noticeCalls,
    statusCalls,
    saveCalls,
    layers,
    copied,
    keyboard,
    box,
    resizeListeners,
    resize,
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

/** A key of the window's newest key layer. */
function press(layers: Layer[], bind: string): void {
  windowLayer(layers)
    ?.commands.find((key) => key.bind === bind)
    ?.run();
}

function windowLayer(layers: Layer[]): Layer | undefined {
  return layers.filter((layer) => layer.priority === WINDOW_KEYS_PRIORITY).at(-1);
}

describe("quota window shell", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("React", {
      createElement: (
        type: unknown,
        props: Record<string, unknown> | null,
        ...children: unknown[]
      ) => {
        const all = { ...props, children: children.length > 1 ? children : children[0] };
        return typeof type === "function" ? type(all) : { type, props: all };
      },
    });
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
    press(host.layers, "escape");
    first.dispose();
    host.quotaWindow.open("system");
    host.statusCalls[1]?.answer("# Quota Status (new)");
    host.statusCalls[0]?.answer("# Quota Status (old)");
    await flush();

    const lines = textLines(draw(host.quotaWindow).tree);
    expect(lines).toContain("# Quota Status (new)");
    expect(lines).not.toContain("# Quota Status (old)");
    press(host.layers, "return");
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
    expect(windowLayer(host.layers)?.target()).toBe(windowBox);

    // A click on the message box takes the keyboard on purpose; a later redraw leaves it there.
    messageBox.focus();
    await vi.advanceTimersByTimeAsync(0);
    await redraw();
    expect(host.keyboard.current).toBe(messageBox);

    // Clicking the window takes it back; esc closes and gives it to the message box.
    windowBox.focus();
    press(host.layers, "escape");
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
    press(host.layers, "c");
    expect(host.copied).toEqual([]);
    expect(host.toasts).toHaveBeenLastCalledWith(
      expect.objectContaining({
        variant: "info",
        title: "Limits",
        message: "Quota is still loading.",
      }),
    );
    view.dispose();
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

    press(host.layers, "c");
    expect(host.copied).toEqual([quotaLimitsText(snapshot, nowMs)]);
    expect(host.copied[0]).toBe("Quota\n● OpenAI  5h 65% left · 7d 26% left");
    expect(host.toasts).toHaveBeenLastCalledWith(
      expect.objectContaining({
        variant: "success",
        title: "Limits",
        message: "Copied the limits report",
      }),
    );

    // Only Limits copies with c.
    host.quotaWindow.open("system");
    press(host.layers, "c");
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
