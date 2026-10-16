/**
 * The TUI plugin (`src/tui/index.tsx`) and its toasts (`toasts.ts`). The toasts on their own,
 * then the plugin on a fake OpenCode host: its commands, the quota commands typed in the prompt,
 * and what it does after a turn.
 */
import { createRoot } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ProviderSnapshot, QuotaSnapshot, ResetNotice } from "../src/core/types.js";
import type { QuotaClient } from "../src/tui/client.js";
import { type DisplaySettings, defaultDisplaySettings } from "../src/tui/display.js";
import plugin from "../src/tui/index.tsx";
import { createToasts, type TurnEnd, toastRoom } from "../src/tui/toasts.js";
import { THEME } from "./helpers/jsx-tree.js";

const NOW = Date.parse("2026-10-10T12:00:00.000Z");

/** The cleanups the TUI registers with Solid (on the server build they never run by themselves). */
const cleanups = vi.hoisted(() => [] as Array<() => void>);
vi.mock("solid-js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("solid-js")>()),
  onCleanup: (cleanup: () => void) => {
    cleanups.push(cleanup);
  },
}));

function provider(label: string, percentRemaining?: number, resetsAt?: string): ProviderSnapshot {
  const providerId = label.toLowerCase();
  return {
    providerId,
    label,
    rows:
      percentRemaining === undefined
        ? []
        : [
            {
              id: `${providerId}.weekly`,
              providerId,
              label: "Weekly",
              type: "quota",
              method: "remote_api",
              authority: "provider_reported",
              window: "week",
              prominence: "primary",
              percentRemaining,
              ...(resetsAt ? { resetsAt } : {}),
            },
          ],
    okAtMs: NOW,
    checkedAtMs: NOW,
    ...(percentRemaining === undefined ? { error: { code: "timeout" as const } } : {}),
    refreshing: false,
    debug: [],
  };
}

function snapshot(providers: ProviderSnapshot[], resetNotices: ResetNotice[] = []): QuotaSnapshot {
  return {
    version: 6,
    providers,
    resetNotices,
    generatedAtMs: NOW,
    serverId: "server",
    revision: NOW,
  };
}

function startToasts(answer: QuotaSnapshot | undefined, change: (d: DisplaySettings) => void) {
  const display = defaultDisplaySettings();
  change(display);
  const show = vi.fn();
  const refresh = vi.fn(async () => answer);
  const toasts = createToasts({
    show,
    display: () => display,
    terminalWidth: () => 120,
    quota: { refresh } as unknown as QuotaClient,
    isChildSession: (sessionID) => sessionID === "child",
    now: () => NOW,
  });
  return { toasts, show, refresh };
}

const OK = snapshot([provider("Claude", 80)]);
const LOW = snapshot([provider("Claude", 10)]);
/** 60% left with 5 of its 7 days to come: used faster than it refills, but not getting low. */
const FAST = snapshot([provider("Claude", 60, new Date(NOW + 5 * 86_400_000).toISOString())]);

describe("quota toasts", () => {
  it.each<{
    name: string;
    trigger: TurnEnd;
    answer: QuotaSnapshot;
    change?: (display: DisplaySettings) => void;
    shown: boolean;
  }>([
    { name: "after compaction by default", trigger: "compaction", answer: OK, shown: true },
    { name: "not after a reply by default", trigger: "reply", answer: OK, shown: false },
    { name: "not after a question by default", trigger: "question", answer: OK, shown: false },
    {
      name: "after every reply when turned on",
      trigger: "reply",
      answer: OK,
      change: (display) => {
        display.toast.afterReply = "always";
      },
      shown: true,
    },
    {
      name: "after a reply only when quota is low, with the low setting",
      trigger: "reply",
      answer: LOW,
      change: (display) => {
        display.toast.afterReply = "low";
      },
      shown: true,
    },
    {
      name: "not after a reply with plenty left, with the low setting",
      trigger: "reply",
      answer: OK,
      change: (display) => {
        display.toast.afterReply = "low";
      },
      shown: false,
    },
    {
      name: "not after a reply for a fast pace alone, with the bar colors following pace",
      trigger: "reply",
      answer: FAST,
      change: (display) => {
        display.toast.afterReply = "low";
        display.levelBy = "pace";
      },
      shown: false,
    },
    {
      name: "never when the toast surface is off",
      trigger: "compaction",
      answer: OK,
      change: (display) => {
        display.surfaces.toast.enabled = false;
      },
      shown: false,
    },
  ])("shows a toast $name", async ({ trigger, answer, change, shown }) => {
    const { toasts, show, refresh } = startToasts(answer, change ?? (() => {}));
    await toasts.afterTurn(trigger, "ses_1");
    expect(refresh).toHaveBeenCalledWith("turn", "ses_1");
    const bar =
      answer === LOW ? `${"█".repeat(2)}${"░".repeat(18)}  10%` : `${"█".repeat(16)}░░░░  80%`;
    expect(show.mock.calls.map(([toast]) => toast.message)).toEqual(
      shown ? [`Claude\n  7d ${bar} left`] : [],
    );
  });

  it("lays the toast out as picked on the Toast page, as wide as the terminal lets it", async () => {
    const message = async (layout: "grouped" | "detailed", terminalWidth: number) => {
      const show = vi.fn();
      const display = defaultDisplaySettings();
      display.toast.layout = layout;
      const toasts = createToasts({
        show,
        display: () => display,
        terminalWidth: () => terminalWidth,
        quota: { refresh: async () => OK } as unknown as QuotaClient,
        isChildSession: () => false,
        now: () => NOW,
      });
      await toasts.afterTurn("compaction", "ses_1");
      return show.mock.calls[0]?.[0].message;
    };
    expect({
      grouped: await message("grouped", 33),
      detailed: await message("detailed", 120),
      narrow: await message("detailed", 33),
    }).toEqual({
      // A 33-column terminal leaves the toast 18 columns of text beside its close "x".
      grouped: "Claude\n  7d ██░  80% left",
      detailed: `Claude\n7d\n${"█".repeat(33)}${"░".repeat(8)}  80% left`,
      narrow: "Claude\n7d\n██████░░  80% left",
    });
  });

  it("draws the even-use mark in the toast's bar only with Even-use mark on", async () => {
    // Half of the week has passed with 80% left: even use would leave 50%.
    const answer = snapshot([provider("Claude", 80)]);
    answer.providers[0]!.rows[0]!.resetsAt = new Date(NOW + 84 * 60 * 60_000).toISOString();
    const message = async (evenUse: boolean) => {
      const { toasts, show } = startToasts(answer, (display) => {
        display.layout.evenUse = evenUse;
      });
      await toasts.afterTurn("compaction", "ses_1");
      return show.mock.calls[0]?.[0].message;
    };
    expect({ off: await message(false), on: await message(true) }).toEqual({
      off: "Claude\n  7d ████████████████░░░░  80% left  3.5d",
      // The ┃ takes the place of the bar's middle cell; the bar keeps its 20 cells.
      on: "Claude\n  7d ██████████┃█████░░░░  80% left  3.5d",
    });
  });

  it("fits a toast's text in OpenCode's toast: 60 columns at most, 6 fewer than the terminal", () => {
    // Inside the toast: a border and 2 columns of padding on each side, then the close "x" 2
    // columns after the text, as a quota toast has no title.
    expect([toastRoom(200), toastRoom(66), toastRoom(50)]).toEqual([51, 51, 35]);
  });

  it("never asks or shows anything for a subagent session", async () => {
    const { toasts, show, refresh } = startToasts(OK, (display) => {
      display.toast.afterReply = "always";
    });
    await toasts.afterTurn("reply", "child");
    expect(refresh).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
  });

  it("says once that every provider fails, until one answers again", async () => {
    const failing = snapshot([provider("Claude"), provider("Copilot")]);
    let answer = failing;
    const show = vi.fn();
    const toasts = createToasts({
      show,
      display: defaultDisplaySettings,
      terminalWidth: () => 120,
      quota: { refresh: async () => answer } as unknown as QuotaClient,
      isChildSession: () => false,
      now: () => NOW,
    });
    for (const next of [failing, failing, OK, failing]) {
      answer = next;
      await toasts.afterTurn("reply", "ses_1");
    }
    expect(show.mock.calls.map(([toast]) => [toast.variant, toast.message])).toEqual([
      ["error", "Claude  Timed out\nCopilot  Timed out"],
      ["error", "Claude  Timed out\nCopilot  Timed out"],
    ]);
  });

  it.each([
    { setting: "off", expected: [] },
    {
      setting: "weekly",
      expected: ["Weekly quota reset: Claude (work) Weekly is available again (100% left)."],
    },
    {
      setting: "all",
      expected: [
        [
          "Weekly quota reset: Claude (work) Weekly is available again (100% left).",
          "5h quota reset: Claude 5h is available again (97% left).",
        ].join("\n"),
      ],
    },
  ] as const)(
    "shows new reset notices once, in one toast, with the $setting setting",
    ({ setting, expected }) => {
      const notice = (id: string, fields: Partial<ResetNotice>): ResetNotice => ({
        id,
        rowId: "claude.weekly",
        providerId: "claude",
        label: "Weekly",
        window: "week",
        percentRemaining: 100,
        atMs: NOW,
        ...fields,
      });
      const notices = [
        notice("weekly", { account: "work" }),
        notice("five-hour", {
          rowId: "claude.five_hour",
          label: "5h",
          window: "five_hour",
          percentRemaining: 96.6,
        }),
        // A reset from before this TUI started was news to the TUI that saw it then.
        notice("old", { atMs: NOW - 1 }),
      ];
      const { toasts, show } = startToasts(undefined, (display) => {
        display.toast.resetNotice = setting;
      });
      toasts.showResetNotices(snapshot([provider("Claude", 100)], notices));
      toasts.showResetNotices(snapshot([provider("Claude", 100)], notices));
      expect(show.mock.calls.map(([toast]) => toast.message)).toEqual(expected);
    },
  );

  /** Reset notices turned on, and a compaction turn whose refresh the test answers. */
  function turnWaitingForQuota() {
    let answer: (snapshot: QuotaSnapshot | undefined) => void = () => {};
    const show = vi.fn();
    const toasts = createToasts({
      show,
      display: () => {
        const display = defaultDisplaySettings();
        display.toast.resetNotice = "all";
        return display;
      },
      terminalWidth: () => 120,
      quota: {
        refresh: () =>
          new Promise<QuotaSnapshot | undefined>((resolve) => {
            answer = resolve;
          }),
      } as unknown as QuotaClient,
      isChildSession: () => false,
      now: () => NOW,
    });
    const turn = toasts.afterTurn("compaction", "ses_1");
    const notice: ResetNotice = {
      id: "weekly",
      rowId: "claude.weekly",
      providerId: "claude",
      label: "Weekly",
      window: "week",
      percentRemaining: 100,
      atMs: NOW,
    };
    const withNotice = snapshot([provider("Claude", 100)], [notice]);
    const titles = () => show.mock.calls.map(([toast]) => toast.title);
    return { toasts, turn, answer: (value?: QuotaSnapshot) => answer(value), withNotice, titles };
  }

  it("shows a reset notice that comes during a turn after the turn's toast", async () => {
    const { toasts, turn, answer, withNotice, titles } = turnWaitingForQuota();
    toasts.showResetNotices(withNotice);
    expect(titles()).toEqual([]);
    answer(OK);
    await turn;
    // The quota toast has no title: its rows say what it is.
    expect(titles()).toEqual([undefined, "Quota available"]);
  });

  it("drops the reset notices still waiting when the TUI leaves its server", async () => {
    const { toasts, turn, answer, withNotice, titles } = turnWaitingForQuota();
    toasts.showResetNotices(withNotice);
    toasts.cancel();
    // A stopped client answers nothing.
    answer(undefined);
    await turn;
    expect(titles()).toEqual([]);
    // Unshown, the notice shows when a snapshot brings it again.
    toasts.showResetNotices(withNotice);
    expect(titles()).toEqual(["Quota available"]);
  });
});

/** The quota RPC the plugin calls; each test sets what it answers. */
const rpc = {
  snapshot: vi.fn(),
  refresh: vi.fn(),
  notices: vi.fn(),
  noticeList: vi.fn(),
  status: vi.fn(),
  usage: vi.fn(),
  settings: vi.fn(),
  saveSettings: vi.fn(),
  events: { on: vi.fn(() => () => {}) },
};

type Listener = (event: { data: Record<string, unknown> }) => void;
type Layer = {
  mode?: string;
  priority?: number;
  commands: Array<{
    id?: string;
    bind?: string;
    slash?: { name: string };
    palette?: boolean;
    run: () => unknown;
  }>;
};
type Route = { type: "home" } | { type: "session"; sessionID: string };

/** The TUI plugin on a fake OpenCode host, on Home or in a session, of `version` when given. */
function startTui(route: Route = { type: "home" }, version?: string) {
  const listeners = new Map<string, Listener>();
  const layers: Layer[] = [];
  const editor = { plainText: "", clear: vi.fn() };
  let renderApp: () => unknown = () => null;
  const context = {
    ...(version ? { app: { version, channel: "latest" } } : {}),
    theme: THEME,
    location: { directory: process.cwd() },
    renderer: { currentFocusedEditor: editor as typeof editor | null, width: 120 },
    client: { rpc: vi.fn(() => rpc) },
    storage: {
      store: vi.fn((_key: string, options: { initial: unknown }) => [options.initial, vi.fn()]),
    },
    data: {
      session: { get: vi.fn() },
      on: vi.fn((name: string, listener: Listener) => {
        listeners.set(name, listener);
        return vi.fn(() => listeners.delete(name));
      }),
    },
    keymap: { layer: vi.fn((build: () => Layer) => layers.push(build())) },
    ui: {
      slot: vi.fn((claim: { append: string; render: () => unknown }) => {
        if (claim.append === "app") {
          // OpenCode draws the slot under its renderer, inside a Solid owner.
          renderApp = () => createRoot(() => claim.render());
          renderApp();
        }
        return vi.fn();
      }),
      toast: { show: vi.fn() },
      router: { current: () => route },
      dialog: {
        show: vi.fn((_render: () => unknown, onClose?: () => void) => onClose?.()),
        clear: vi.fn(),
        set: vi.fn(),
      },
    },
  };
  plugin.setup(context as never);
  return {
    context,
    editor,
    listeners,
    toast: context.ui.toast.show,
    sessionGet: context.data.session.get,
    /** The palette commands of the first mount. */
    commands: layers.find((layer) => layer.mode === "global")?.commands ?? [],
    /** The Enter binding of the typed quota commands. */
    enter: () => layers.find((layer) => layer.priority === 1)?.commands[0],
    layers,
    emit: (name: string, data: Record<string, unknown>) => listeners.get(name)?.({ data }),
    /** OpenCode mounts the "app" slot again, for example after it reconnects to its server. */
    mountAppAgain: () => renderApp(),
  };
}

beforeEach(() => {
  cleanups.length = 0;
  for (const mock of [rpc.notices, rpc.events.on]) mock.mockClear();
  rpc.snapshot.mockReset().mockResolvedValue({ snapshot: snapshot([]) });
  rpc.refresh.mockReset().mockResolvedValue({ snapshot: OK });
  rpc.settings.mockReset().mockResolvedValue({ values: {}, providers: [], custom: [] });
  rpc.saveSettings.mockReset().mockResolvedValue({ ok: true, issues: [] });
  rpc.noticeList.mockReset().mockResolvedValue({ notices: [] });
  rpc.status.mockReset().mockResolvedValue({ text: "status" });
  // The Usage tab's data never arrives here: these tests check what opens.
  rpc.usage.mockReset().mockReturnValue(new Promise(() => {}));
});

describe("commands of the TUI plugin", () => {
  it("registers every quota command in the palette, and slash entries only for the TUI-only ones", () => {
    const { context, commands } = startTui();

    // The RPC client is made per call, never during setup.
    expect(context.client.rpc).not.toHaveBeenCalled();
    expect(commands.map((command) => command.id)).toEqual([
      "quota.limits",
      "quota.usage",
      "quota.status",
      "quota.settings",
    ]);
    expect(commands.every((command) => command.palette)).toBe(true);
    // The server lists /quota, /quota_usage and /quota_status in the "/" list.
    expect(commands.flatMap((command) => (command.slash ? [command.slash.name] : []))).toEqual([
      "quota_settings",
    ]);
    expect(context.ui.slot.mock.calls.map(([claim]) => claim.append)).toEqual([
      "app",
      "sidebar.content",
      "prompt.footer",
      "home.footer.status",
      "session.composer.top",
    ]);
    expect(context.data.on.mock.calls.map(([event]) => event)).toEqual([
      "session.execution.succeeded",
      "session.compaction.ended",
      "session.step.ended",
      "session.tool.input.started",
      "session.tool.success",
      "session.tool.failed",
    ]);
  });

  it("registers its layers and listeners again when OpenCode mounts the app slot again", () => {
    const { context, mountAppAgain } = startTui();
    const firstListeners = context.data.on.mock.results.map((result) => result.value);
    const firstLayers = context.keymap.layer.mock.calls.length;

    mountAppAgain();

    // The previous mount's layers left with it, so every layer is registered again.
    expect(context.keymap.layer).toHaveBeenCalledTimes(firstLayers * 2);
    expect(context.data.on).toHaveBeenCalledTimes(firstListeners.length * 2);
    for (const dispose of firstListeners) expect(dispose).toHaveBeenCalledOnce();
    const secondListeners = context.data.on.mock.results.slice(firstListeners.length);
    for (const { value: dispose } of secondListeners) expect(dispose).not.toHaveBeenCalled();
  });

  it("catches a typed quota command with one Enter binding above OpenCode's prompt, only in the base mode", () => {
    const { layers, enter } = startTui();

    const layer = layers.find((item) => item.priority === 1);
    expect(layer?.mode).toBeUndefined();
    expect(layer?.commands).toHaveLength(1);
    expect(enter()?.bind).toBe("return");
    expect(enter()).not.toHaveProperty("id");
    expect(enter()).not.toHaveProperty("slash");
  });

  it("opens the Limits tab for a typed /quota, with fresh rows", () => {
    const session = startTui({ type: "session", sessionID: "ses_open" });
    session.editor.plainText = "/quota";
    expect(session.enter()?.run()).toBeUndefined();
    expect(session.editor.clear).toHaveBeenCalledOnce();
    expect(session.toast).not.toHaveBeenCalled();
    expect(rpc.refresh).toHaveBeenCalledExactlyOnceWith(
      { reason: "manual", sessionID: "ses_open" },
      expect.anything(),
    );
  });

  it("opens the quota window for every typed quota command, and on Home says to open a session first", () => {
    const home = startTui();
    for (const name of ["quota", "quota_usage", "quota_status", "quota_settings"]) {
      home.editor.plainText = `/${name}`;
      expect(home.enter()?.run()).toBeUndefined();
    }
    expect(home.editor.clear).toHaveBeenCalledTimes(4);
    expect(home.toast).toHaveBeenCalledTimes(4);
    expect(home.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Open a session first: the quota window opens above its message box.",
      }),
    );

    // A typed command runs synchronously: a returned promise would count as handled.
    const session = startTui({ type: "session", sessionID: "ses_open" });
    session.editor.plainText = "  /quota_status \n";
    expect(session.enter()?.run()).toBeUndefined();
    expect(session.toast).not.toHaveBeenCalled();
    expect(rpc.status).toHaveBeenCalledExactlyOnceWith(
      { sessionID: "ses_open" },
      expect.anything(),
    );
  });

  it("leaves other text and a missing editor to OpenCode's submit", () => {
    const { context, editor, enter } = startTui();
    for (const text of ["hello", "/quotax", "/quota_statu", "/help", "hello /quota", "/", ""]) {
      editor.plainText = text;
      expect(enter()?.run()).toBe(false);
    }
    context.renderer.currentFocusedEditor = null;
    expect(enter()?.run()).toBe(false);
    expect(editor.clear).not.toHaveBeenCalled();
  });
});

describe("turn events of the TUI plugin", () => {
  let tui: ReturnType<typeof startTui>;
  beforeEach(() => {
    tui = startTui();
  });

  it("refreshes quota after a question is answered, with no toast by default", async () => {
    tui.emit("session.tool.input.started", { name: "question", id: "call-1" });
    tui.emit("session.tool.success", { sessionID: "ses_1", id: "call-1" });
    await vi.waitFor(() => expect(rpc.refresh).toHaveBeenCalledOnce());
    expect(rpc.refresh).toHaveBeenCalledWith(
      { reason: "turn", sessionID: "ses_1" },
      expect.anything(),
    );
    // Only the subagent check reads the session.
    expect(tui.sessionGet).toHaveBeenCalledExactlyOnceWith("ses_1");
    expect(tui.toast).not.toHaveBeenCalled();
  });

  it.each([
    { name: "a failed question", tool: "question", end: "session.tool.failed" },
    { name: "another tool", tool: "bash", end: "session.tool.success" },
  ])("does nothing after $name", ({ tool, end }) => {
    tui.emit("session.tool.input.started", { name: tool, id: "call-2" });
    tui.emit(end, { sessionID: "ses_1", id: "call-2" });
    expect(rpc.refresh).not.toHaveBeenCalled();
    expect(tui.sessionGet).not.toHaveBeenCalled();
  });

  it("asks for the snapshot once mounted, so Home gets all file settings too", () => {
    expect(rpc.snapshot).toHaveBeenCalledWith({}, expect.anything());
  });

  it("announces v5 conversion once without saving settings in plugin storage", async () => {
    rpc.refresh.mockResolvedValue({
      snapshot: { ...OK, settingsConverted: true, revision: OK.revision + 1 },
    });
    tui.emit("session.step.ended", { sessionID: "ses_1" });
    await vi.waitFor(() =>
      expect(tui.toast).toHaveBeenCalledWith({
        variant: "info",
        title: "OpenCode Quota",
        message: "Your 4.x or 5.x settings are now in settings.jsonc, details in /quota_status",
        duration: 15_000,
      }),
    );
    tui.emit("session.step.ended", { sessionID: "ses_1" });
    await vi.waitFor(() => expect(rpc.refresh).toHaveBeenCalledTimes(2));
    expect(tui.toast).toHaveBeenCalledTimes(1);
    expect(tui.context.storage.store.mock.calls.some(([key]) => key === "settings")).toBe(false);
  });

  it("loads file settings from live snapshot updates without a settings store", async () => {
    const settings = { values: { "toast.afterReply": "always" }, providers: [], custom: [] };
    rpc.refresh.mockResolvedValue({ snapshot: { ...OK, settings, revision: OK.revision + 1 } });
    tui.emit("session.step.ended", { sessionID: "ses_1" });
    await vi.waitFor(() => expect(rpc.refresh).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));
    tui.emit("session.execution.succeeded", { sessionID: "ses_1" });
    await vi.waitFor(() =>
      expect(tui.toast).toHaveBeenCalledWith(
        expect.objectContaining({ variant: "info", message: expect.stringContaining("80% left") }),
      ),
    );
  });

  it("stops listening when OpenCode unmounts the app slot", () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    tui.emit("session.step.ended", { sessionID: "ses_1" });
    expect(tui.listeners.size).toBe(0);
    expect(rpc.refresh).not.toHaveBeenCalled();
  });

  it("drops the reset notices still waiting when OpenCode unmounts the app slot", async () => {
    let answer: (output: { snapshot: QuotaSnapshot }) => void = () => {};
    rpc.refresh.mockReset().mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    // A reply's turn waits for quota; meanwhile the server announces a reset.
    tui.emit("session.execution.succeeded", { sessionID: "ses_1" });
    await vi.waitFor(() => expect(rpc.refresh).toHaveBeenCalledOnce());
    const notice: ResetNotice = {
      id: "weekly",
      rowId: "claude.weekly",
      providerId: "claude",
      label: "Weekly",
      window: "week",
      percentRemaining: 100,
      atMs: Date.now() + 60_000,
    };
    const changed = rpc.events.on.mock.lastCall?.[1] as unknown as (event: {
      data: { snapshot: QuotaSnapshot };
    }) => void;
    changed({
      data: {
        snapshot: {
          ...snapshot([provider("Claude", 100)], [notice]),
          settings: { values: { "toast.resetNotice": "all" }, providers: [], custom: [] },
        },
      },
    });

    for (const cleanup of cleanups.splice(0)) cleanup();
    answer({ snapshot: OK });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tui.toast).not.toHaveBeenCalled();
  });

  it("refreshes after each step of a session, never of a subagent", () => {
    tui.sessionGet.mockImplementation((id: string) =>
      id === "child" ? { parentID: "ses_1" } : {},
    );
    tui.emit("session.step.ended", { sessionID: "child" });
    tui.emit("session.step.ended", { sessionID: "ses_1" });
    expect(rpc.refresh.mock.calls.map(([input]) => input)).toEqual([
      { reason: "turn", sessionID: "ses_1" },
    ]);
  });
});

describe("colored toasts of the TUI plugin", () => {
  const PLAIN = `Claude\n  7d ${"█".repeat(16)}░░░░  80% left`;

  /**
   * The messages OpenCode `version`'s toast gets after a compaction (its `show` stands for that
   * toast). JSX makes plain `{ type, props }` nodes here.
   */
  async function afterCompaction(version?: string, show?: (toast: { message: unknown }) => void) {
    vi.stubGlobal("React", {
      createElement: (type: unknown, props: object | null, ...children: unknown[]) => ({
        type,
        props: { ...props, children: children.length > 1 ? children : children[0] },
      }),
    });
    const tui = startTui({ type: "session", sessionID: "ses_1" }, version);
    if (show) tui.toast.mockImplementation(show);
    tui.emit("session.compaction.ended", { sessionID: "ses_1" });
    await vi.waitFor(() => expect(tui.toast).toHaveBeenCalled());
    return tui.toast.mock.calls.map(([toast]) => toast.message as unknown);
  }

  /** What OpenCode's <text> draws of a message of spans. */
  const drawn = (message: unknown) =>
    (message as Array<string | { props: { children: string } }>)
      .map((child) => (typeof child === "string" ? child : child.props.children))
      .join("");

  it.each(["2.0.28", "2.1.0", undefined])(
    "colors the quota toast on OpenCode %s, with the plain message's text",
    async (version) => {
      const colored = await afterCompaction(version);
      expect(colored).toHaveLength(1);
      expect(typeof colored[0]).not.toBe("string");
      expect(drawn(colored[0])).toBe(PLAIN);
    },
  );

  it("shows the plain toast when OpenCode's toast throws on the colored one", async () => {
    const messages = await afterCompaction("2.0.28", (toast) => {
      if (typeof toast.message !== "string") throw new Error("message must be a string");
    });
    expect(messages).toHaveLength(2);
    expect(messages[1]).toBe(PLAIN);
  });
});
