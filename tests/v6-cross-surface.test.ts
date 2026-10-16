import { DEFAULT_USAGE_RANGE, USAGE_RANGES, usageRangeLabel } from "../src/core/usage-ranges.js";
import { QUOTA_PROVIDER_CATALOG } from "../src/lib/provider-metadata.js";

const CONFIG_PROVIDER_IDS = Object.keys(QUOTA_PROVIDER_CATALOG).map((id) =>
  id === "quota-providers" ? "custom" : id,
);

/** The range list's line under the default range, where ↓ goes from it. */
const RANGE_AFTER_DEFAULT =
  USAGE_RANGES[USAGE_RANGES.findIndex((item) => item.range === DEFAULT_USAGE_RANGE) + 1]?.label;

/**
 * The v6 surfaces end to end: the real server plugin (`src/plugin.ts`) and the real TUI plugin
 * (`src/tui/index.tsx`) on fake OpenCode hosts, joined by a JSON RPC bridge. Three providers:
 * Copilot with only its plan, MiniMax over its quota, and a custom json-v1 source next to a
 * failing one. OpenCode's history (a session database) used Anthropic and GitHub Copilot.
 * API keys and a private error body are canaries no surface may show. Then the quota window's
 * Settings tabs change a surface, words and a custom
 * provider switched on to settings.jsonc.
 *
 * Agent tool to plugin: a custom provider an agent replaces is switched off, and the running
 * server stops its requests through the settings reload alone.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ProviderRow } from "../src/providers/contract.js";
import { answer, percentRow } from "./helpers/fake-answers.js";
import { createFakeIntegration } from "./helpers/fake-integration.js";
import { findAll, type Node, THEME, textLines } from "./helpers/jsx-tree.js";
import {
  createAlibabaAuthModuleMock,
  createProvidersRegistryModuleMock,
  createSessionTokensModuleMock,
  seedDefaultPluginBootstrapMocks,
  writePluginTestSettings,
} from "./helpers/plugin-test-harness.js";
import { createQuotaRpcBridge, createQuotaRpcEvents } from "./helpers/quota-rpc-bridge.js";
import { writeSessionDatabase } from "./helpers/session-database.js";

const CANARIES = {
  teamKey: "v6-team-key-secret-canary",
  failingKey: "v6-failing-key-secret-canary",
  failureBody: "v6-private-http-body-canary",
};

const mocks = vi.hoisted(() => ({
  root: "",
  terminal: { width: 120, height: 40 },
  getProviders: vi.fn(),
  resolveAlibabaCodingPlanAuthCached: vi.fn(),
  fetchSessionTokensForDisplay: vi.fn(),
}));

vi.mock("@opentui/solid", () => ({
  useTerminalDimensions: () => () => mocks.terminal,
}));
vi.mock("../src/providers/registry.js", () =>
  createProvidersRegistryModuleMock(mocks.getProviders),
);
vi.mock("../src/lib/session-tokens.js", () =>
  createSessionTokensModuleMock(mocks.fetchSessionTokensForDisplay),
);
vi.mock("../src/lib/alibaba-auth.js", () =>
  createAlibabaAuthModuleMock(mocks.resolveAlibabaCodingPlanAuthCached),
);
vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirs: () => ({
    dataDir: `${mocks.root}/data`,
    configDir: `${mocks.root}/config`,
    cacheDir: `${mocks.root}/cache`,
    stateDir: `${mocks.root}/state`,
  }),
}));

// Resets in 2h 14m (the 30 s margin keeps the minute while the test runs).
const RESET = new Date(Date.now() + 134 * 60_000 - 30_000).toISOString();

const CUSTOM_SOURCES = [
  {
    id: "team-accounting",
    providerId: "team-gateway",
    label: "Team",
    url: "https://team-gateway.example/accounting",
    mode: "remote-api",
    format: "json-v1",
    apiKeyEnv: "V6_TEAM_KEY",
    adapter: {
      mappings: [
        {
          resultType: "quota",
          name: "Monthly",
          label: "Monthly:",
          resetTime: { path: ["quota", "resetAt"], encoding: "iso-8601" },
          metric: {
            type: "remaining-limit",
            remaining: { path: ["quota", "remaining"] },
            limit: { path: ["quota", "limit"] },
          },
        },
      ],
    },
  },
  {
    id: "failing-accounting",
    providerId: "failing-gateway",
    label: "Failing",
    url: "https://failing-gateway.example/accounting",
    mode: "remote-api",
    format: "quota-v1",
    apiKeyEnv: "V6_FAILING_KEY",
  },
];

/** Copilot without a billing token shows only its plan; MiniMax is past its 5h quota. */
function fakeProvider(id: string, name: string, rows: ProviderRow[]) {
  return { id, isAvailable: async () => true, fetch: async () => answer({ name, rows }) };
}

function httpFetch(url: string, init?: RequestInit): Response {
  const authorization = new Headers(init?.headers).get("authorization");
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  if (url === CUSTOM_SOURCES[0]?.url) {
    expect(authorization).toBe(`Bearer ${CANARIES.teamKey}`);
    return json({ quota: { remaining: 64, limit: 100, resetAt: RESET } });
  }
  if (url === CUSTOM_SOURCES[1]?.url) {
    expect(authorization).toBe(`Bearer ${CANARIES.failingKey}`);
    return new Response(CANARIES.failureBody, { status: 503 });
  }
  if (url === "https://models.dev/api.json") throw new Error("network down");
  throw new Error(`unexpected URL: ${url}`);
}

type Listener = (event: { data: Record<string, unknown> }) => void;
type ServerCommand = {
  name: string;
  execute(invocation: { sessionID: string; prompt: { text: string } }): Promise<void>;
};

/** The text lines with runs of spaces as one space, so layout tweaks don't break the checks. */
function words(node: unknown): string[] {
  return textLines(node).map((line) => line.replace(/\s+/gu, " ").trim());
}

/** The labels of the active choices: the tab, Cost or Tokens, the range (without its ›), Model or Day. */
function activeLabels(node: unknown): string[] {
  return findAll(node, (item) => item.type === "text" && item.props.fg === "selected").map((item) =>
    (textLines(item)[0] ?? "").trim().replace(/^› /u, ""),
  );
}

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

/** The local date `days` calendar days from today, like "2026-10-01". */
function localDate(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${String(date.getDate()).padStart(2, "0")}`;
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

/**
 * OpenCode's history for the Usage tab: this session a minute ago with `modelID`, and an older
 * session 10 days ago with an unpriced model.
 */
function writeUsageHistory(modelID = "claude-sonnet-4-5"): void {
  const now = Date.now();
  const old = now - 10 * 24 * 60 * 60_000;
  writeSessionDatabase(join(mocks.root, "data", "opencode.db"), {
    sessions: [
      { id: "ses_1", created: now - 3_600_000 },
      { id: "ses_old", created: old },
    ],
    messages: [
      {
        id: "msg_1",
        sessionID: "ses_1",
        created: now - 60_000,
        completed: now - 59_000,
        providerID: "anthropic",
        modelID,
        tokens: { input: 1_000_000, output: 100_000 },
      },
      {
        id: "msg_old",
        sessionID: "ses_old",
        created: old,
        completed: old + 1_000,
        providerID: "acme",
        modelID: "mystery-old",
        tokens: { output: 500_000 },
      },
    ],
  });
}

function expectNoCanary(...outputs: unknown[]): void {
  const text = JSON.stringify(outputs);
  for (const canary of Object.values(CANARIES)) expect(text).not.toContain(canary);
}

type KeyLayer = {
  mode?: string;
  priority?: number;
  enabled?: () => boolean;
  target?: () => unknown;
  commands: Array<{ bind?: string; run: () => unknown }>;
};

/** A line on a node that a click uses: its text is `text` (a list's chosen item has › before it). */
function clickable(tree: unknown, text: string): Node {
  return findAll(
    tree,
    (node) =>
      typeof node.props?.onMouseUp === "function" &&
      textLines(node).join("").trim().replace(/^› /u, "") === text,
  )[0]!;
}

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

/** The lines of the window's Settings line with this setting path (or id). */
function settingLine(tree: unknown, id: string): Node[] {
  return findAll(tree, (node) => node.props?.id === `quota-settings.${id}`);
}

async function startHosts() {
  const { default: serverPlugin } = await import("../src/plugin.js");
  const events = createQuotaRpcEvents();
  const register = vi.fn(async () => ({ dispose: async () => {}, events: { emit: events.emit } }));
  // The server's slash commands, and the messages they post (Web, Desktop, the TUI chat form).
  const serverCommands: ServerCommand[] = [];
  const posted = vi.fn(async (_message: { sessionID: string; text: string }) => ({}));
  const disposeServer = await serverPlugin.setup({
    location: { directory: process.cwd() },
    provider: {
      list: async () => ({ data: ["team-gateway", "failing-gateway"].map((id) => ({ id })) }),
    },
    session: {
      get: async () => ({ model: { id: "model-one", providerID: "github-copilot" } }),
      hook: vi.fn(),
      wait: async () => {},
      prompt: posted,
    },
    command: {
      transform: async (build: (editor: { add(command: ServerCommand): void }) => void) =>
        build({ add: (command) => serverCommands.push(command) }),
    },
    rpc: { register },
    integration: createFakeIntegration([]),
    event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
    tool: { transform: vi.fn() },
  } as never);
  const [, handlers] = register.mock.calls[0] as unknown as [
    unknown,
    Parameters<typeof createQuotaRpcBridge>[0],
  ];

  // OpenCode's plugin storage: one live object per key. A toast after every reply.
  const stored = new Map<string, any>();
  const storage = {
    store: (key: string, options: { initial: any }) => {
      if (!stored.has(key)) stored.set(key, structuredClone(options.initial));
      const value = stored.get(key);
      return [value, async (mutation: (draft: any) => void) => mutation(value)];
    },
  };
  const listeners = new Map<string, Listener>();
  const renderers = new Map<string, (props?: { sessionID?: string }) => unknown>();
  let commands: Array<{ id: string; run: () => Promise<void> }> = [];
  // Every keymap layer, newest last: the Usage tab adds its own each time it renders.
  const layers: KeyLayer[] = [];
  let focused: unknown;
  const renderer: {
    currentFocusedEditor: { plainText: string; clear(): void } | null;
    width: number;
    on(): void;
    off(): void;
  } = { currentFocusedEditor: null, width: 120, on: () => {}, off: () => {} };
  const toast = vi.fn();
  const dispatch = vi.fn();
  const dialog = { show: vi.fn(), clear: vi.fn(), prompt: vi.fn(), set: vi.fn() };
  // Like OpenCode's prompt, the TUI client runs a server slash command in a session.
  const sessionCommand = vi.fn(async (input: { sessionID: string; name: string; text: string }) =>
    serverCommands
      .find((command) => command.name === input.name)
      ?.execute({ sessionID: input.sessionID, prompt: { text: input.text } }),
  );
  vi.stubGlobal("React", {
    createElement: (
      type: unknown,
      props: Record<string, unknown> | null,
      ...children: unknown[]
    ) => {
      const all = { ...props, children: children.length > 1 ? children : children[0] };
      if (typeof type === "function") return type(all);
      // A renderable, enough for refs: it takes the keyboard (at once when `focused`). A test
      // hands an input its own renderable through `ref`.
      const node = {
        type,
        props: all,
        focus: () => {
          focused = node;
        },
        on: () => {},
        scrollTo: () => {},
        scrollBy: () => {},
        scrollChildIntoView: () => {},
      };
      if (typeof all.ref === "function" && type !== "input") all.ref(node);
      if (all.focused === true) node.focus();
      return node;
    },
  });
  const { default: tuiPlugin } = await import("../src/tui/index.tsx");
  const disposeTui = tuiPlugin.setup({
    location: { directory: process.cwd() },
    renderer,
    client: { rpc: createQuotaRpcBridge(handlers, events), session: { command: sessionCommand } },
    theme: THEME,
    storage,
    data: {
      on: (name: string, listener: Listener) => {
        listeners.set(name, listener);
        return () => listeners.delete(name);
      },
      session: { get: () => ({}) },
      location: { default: () => ({ directory: process.cwd() }) },
    },
    keymap: {
      layer: (build: () => KeyLayer) => {
        const layer = build();
        layers.push(layer);
        if (layer.mode === "global") commands = layer.commands as typeof commands;
      },
      dispatch,
    },
    ui: {
      slot: (claim: { append: string; render: (props?: { sessionID?: string }) => unknown }) => {
        renderers.set(claim.append, claim.render);
        if (claim.append === "app") claim.render();
        return () => {};
      },
      toast: { show: toast },
      router: { current: () => ({ type: "session", sessionID: "ses_1" }) },
      dialog,
    },
  } as never);
  return {
    render: (slot: string, props?: { sessionID?: string }) => renderers.get(slot)?.(props),
    emit: (name: string, data: Record<string, unknown>) => listeners.get(name)?.({ data }),
    command: (id: string) => commands.find((command) => command.id === `quota.${id}`)!,
    /** The last layer registered with this priority. */
    layer: (priority: number) => layers.filter((layer) => layer.priority === priority).at(-1)!,
    focused: () => focused,
    /** OpenCode gives the keyboard to the message box. */
    focusMessageBox: () => {
      focused = "message box";
    },
    /** The open dialog, drawn again. */
    renderDialog: () => (dialog.show.mock.calls.at(-1)![0] as () => unknown)(),
    /** Presses a key of the open dialog (its newest modal layer). */
    pressDialog: (bind: string) =>
      layers
        .findLast((layer) => layer.mode === "modal")
        ?.commands.find((key) => key.bind === bind)
        ?.run(),
    /** Types `text` in the message box and presses enter. */
    typed: (text: string) => {
      renderer.currentFocusedEditor = {
        plainText: text,
        clear: () => {
          renderer.currentFocusedEditor = null;
        },
      };
      return layers.find((layer) => layer.priority === 1)?.commands[0]?.run();
    },
    /** Presses `bind` in the newest layer of `priority`: the Usage tab's keys are 11. */
    press: (priority: number, bind: string) =>
      layers
        .findLast((layer) => layer.priority === priority)
        ?.commands.find((command) => command.bind === bind)
        ?.run(),
    /** The server's RPC handlers, looked up on each call: a test can wrap one. */
    handlers: handlers as Record<string, (input: unknown, context: unknown) => Promise<unknown>>,
    /** Runs a Web and Desktop slash command; `posted` gets its chat message. */
    serverCommand: (name: string, sessionID: string, text = "") =>
      serverCommands
        .find((command) => command.name === name)!
        .execute({ sessionID, prompt: { text } }),
    dialog,
    sessionCommand,
    posted,
    toast,
    dispatch,
    stored,
    dispose: async () => {
      (disposeTui as () => void)();
      await (disposeServer as unknown as () => Promise<void>)?.();
    },
  };
}

type Observation = { value: number; attributes?: Record<string, unknown> };
type GaugeCallback = (result: {
  observe(value: number, attributes?: Observation["attributes"]): void;
}) => void;

/** OpenTelemetry's API with one gauge callback per name; `collect` reads a gauge. */
function fakeTelemetry() {
  const callbacks = new Map<string, GaugeCallback>();
  const api = {
    metrics: {
      getMeter: () => ({
        createObservableGauge: (name: string) => ({
          addCallback: (callback: GaugeCallback) => callbacks.set(name, callback),
          removeCallback: () => callbacks.delete(name),
        }),
      }),
    },
  };
  const collect = (name: string) => {
    const observations: Observation[] = [];
    callbacks.get(name)?.({
      observe: (value, attributes) => observations.push({ value, attributes }),
    });
    return observations;
  };
  return { api, collect };
}

describe("v6 surfaces on the quota snapshot", () => {
  const savedEnv = {
    V6_TEAM_KEY: process.env.V6_TEAM_KEY,
    V6_FAILING_KEY: process.env.V6_FAILING_KEY,
  };
  let telemetry = fakeTelemetry();

  beforeEach(async () => {
    mocks.root = await mkdtemp(join(tmpdir(), "opencode-quota-v6-cross-surface-"));
    mocks.terminal = { width: 120, height: 40 };
    process.env.V6_TEAM_KEY = CANARIES.teamKey;
    process.env.V6_FAILING_KEY = CANARIES.failingKey;
    seedDefaultPluginBootstrapMocks(mocks, { resetPluginState: true });
    writePluginTestSettings(mocks.root, {
      toast: { afterReply: "always" },
      statusLine: { detail: "one", withSidebar: true },
      words: { sessionTokens: "current" },
      providers: {
        off: CONFIG_PROVIDER_IDS.filter(
          (id) => !["copilot", "minimax-coding-plan", "custom"].includes(id),
        ),
        custom: CUSTOM_SOURCES,
        checking: { minIntervalMs: 60_000 },
      },
      system: {
        exportFile: true,
        exportPath: join(mocks.root, "quota-export.json"),
        telemetry: true,
      },
    });
    mocks.fetchSessionTokensForDisplay.mockResolvedValue({
      sessionTokens: {
        totalInput: 1200,
        totalCachedInput: 300,
        totalOutput: 45,
        models: [{ modelID: "gpt-5", input: 1200, cacheRead: 300, cacheWrite: 0 }],
      },
    });
    const { quotaProvidersProvider } = await import("../src/providers/quota-providers.js");
    mocks.getProviders.mockReturnValue([
      fakeProvider("copilot", "Copilot (pro)", [percentRow("allowance", "Plan", 81)]),
      fakeProvider("minimax-coding-plan", "MiniMax Token Plan", [
        percentRow("five_hour", "5h", -5, { window: "five_hour", resetsAt: RESET }),
        percentRow("weekly", "Weekly", 40, { window: "week" }),
      ]),
      quotaProvidersProvider,
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => httpFetch(url, init)),
    );

    telemetry = fakeTelemetry();
    const quotaTelemetry = await import("../src/lib/quota-telemetry.js");
    quotaTelemetry.__resetQuotaTelemetryForTests();
    quotaTelemetry.__setQuotaTelemetryApiLoaderForTests(async () => telemetry.api as never);
  });

  afterEach(async () => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(mocks.root, { recursive: true, force: true, maxRetries: 3 });
  });

  it("shows one snapshot in the sidebar, status line, toast, the window, export and gauges", async () => {
    const tui = await startHosts();
    const sidebar = () => tui.render("sidebar.content", { sessionID: "ses_1" });
    // The first look asks the server; the providers answer in the background and the
    // `changed` event brings their rows, the last of them the custom source's.
    await vi.waitFor(
      () => expect(words(sidebar())).toContain("30d ████████████░░░░░░ 64% 2h 14m"),
      {
        timeout: 10_000,
      },
    );

    // Sidebar: every provider and its rows, under a title that says the percents are what is
    // left; a row with a window is named by its length, one without by its label; an
    // over-quota row shows 0%. Each bar takes its level's theme color: plenty, getting low,
    // almost out.
    const expanded = sidebar();
    expect(words(expanded)).toEqual(
      expect.arrayContaining([
        "▼ Quota left",
        "Plan ███████████████░░░ 81%",
        "5h ░░░░░░░░░░░░░░░░░░ 0% 2h 14m",
        "Custom providers (Team) Provider e…",
        "Session 1.20K in · 45 out",
      ]),
    );
    const barColor = (start: string) => {
      const text = findAll(expanded, (node) => node.type === "text").find((node) =>
        textLines(node)[0]?.trim().startsWith(start),
      );
      return findAll(text, (node) => node.type === "span")[1]?.props.style.fg;
    };
    expect(["Plan", "7d", "5h"].map(barColor)).toEqual(["green", "yellow", "red"]);
    // Provider names are bold: a span takes `bold` from its style (it ignores `attributes`).
    const nameStyles = findAll(
      expanded,
      (node) => node.type === "span" && node.props.children === "Copilot",
    ).map((node) => node.props.style);
    expect(nameStyles).toEqual([expect.objectContaining({ bold: true })]);

    // Collapsed: a click on the title collapses the panel; plugin storage remembers it. A
    // provider with an error keeps its rows and shows the error next to them.
    findAll(
      expanded,
      (node) => typeof node.props?.onMouseDown === "function",
    )[0]?.props.onMouseDown();
    expect(tui.stored.get("sidebar")).toEqual({ open: false });
    expect(words(sidebar())).toEqual(
      expect.arrayContaining([
        "▶ Quota (3 providers, 1 error)",
        "Custom p… 30d █████░░░ 64% Provi…",
      ]),
    );

    // Status line under the message box, here "one provider, big bar".
    expect(words(tui.render("prompt.footer", { sessionID: "ses_1" }))).toEqual([
      "Copilot Plan ████████░░ 81% left",
    ]);

    // Toast after a reply.
    tui.emit("session.execution.succeeded", { sessionID: "ses_1" });
    await vi.waitFor(() => expect(tui.toast).toHaveBeenCalledOnce());
    const toast = tui.toast.mock.calls[0]?.[0];
    expect(toast).toMatchObject({ variant: "info" });
    // No title: the rows say what it is.
    expect(toast).not.toHaveProperty("title");
    expect(toast.message).toBe(
      [
        "Copilot (pro)",
        "  Plan ████████████████░░░░  81% left",
        "MiniMax Token Plan",
        "  5h   ░░░░░░░░░░░░░░░░░░░░   0% left  2h 14m",
        "  7d   ████████░░░░░░░░░░░░  40% left",
        "Custom providers (Team)  Provider error 503",
        "  30d  █████████████░░░░░░░  64% left  2h 14m",
        "Session  1.20K in · 45 out",
      ].join("\n"),
    );

    // /quota opens the window on Limits: every row with its bar, percent, reset and pace.
    await tui.command("limits").run();
    const quotaWindow = () => textLines(tui.render("session.composer.top", { sessionID: "ses_1" }));
    await vi.waitFor(() => expect(quotaWindow()).toContain("   Provider error 503"));
    // A release sets package.json to its tag first, such as 6.0.0-beta.1.
    const { version } = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(quotaWindow()).toEqual(
      expect.arrayContaining([
        // The title and the plugin's version from package.json.
        `OpenCode Quota v${version}`,
        "Usage",
        "Limits",
        "Plugin",
        // Every tab and the Settings label fit in the 120 columns the window starts with.
        "Settings",
        "Layout",
        "Colors",
        "Providers",
        "esc",
        // Like the window's other tabs: a provider one column in, its rows and errors three.
        " Copilot  pro",
        expect.stringMatching(/^ {3}Plan +█+░+ {2}81% left$/u),
        expect.stringMatching(
          /^ {3}5h +░+┃░+ {3}0% left {3}resets in 2h 14m {3}faster than it refills$/u,
        ),
        " Custom providers  Team",
      ]),
    );
    expect(quotaWindow()).not.toContain("Close");

    // /quota_usage opens it on Usage (its range list; the window starts without the keyboard, so
    // no key hint), /quota_status on Plugin, /quota_settings on Layout's first page, All places.
    await tui.command("usage").run();
    await vi.waitFor(() =>
      expect(quotaWindow()).toContainEqual(expect.stringContaining("90 days")),
    );
    await tui.command("status").run();
    expect(quotaWindow()).toContainEqual(expect.stringContaining("Copy the report"));
    await tui.command("settings").run();
    expect(quotaWindow()).toContainEqual(expect.stringContaining("Layout preset"));

    // The export file (version 3) and the gauges follow the snapshot without asking a provider
    // again.
    const exportPath = join(mocks.root, "quota-export.json");
    const exported = await vi.waitFor(async () => {
      const file = JSON.parse(await readFile(exportPath, "utf8"));
      expect(file.providers["quota-providers"]?.status).toBe("partial");
      return file;
    });
    expect(
      Object.entries(exported.providers).map(([id, provider]: [string, any]) => [
        id,
        provider.status,
        provider.entries.map((entry: any) => [entry.name, entry.percentRemaining]),
      ]),
    ).toEqual([
      ["copilot", "ok", [["Copilot (pro) Plan", 81]]],
      [
        "minimax-coding-plan",
        "ok",
        [
          ["MiniMax Token Plan 5h", -5],
          ["MiniMax Token Plan Weekly", 40],
        ],
      ],
      ["quota-providers", "partial", [["Custom providers (Team) Monthly", 64]]],
    ]);
    expect(exported.providers["quota-providers"]).toMatchObject({
      entries: [{ window: "Monthly", ownership: "user_configured" }],
      sources: [
        { id: "team-accounting", status: "ok", entryCount: 1 },
        { id: "failing-accounting", status: "error", entryCount: 0 },
      ],
    });
    const gauges = telemetry.collect("opencode.quota.consumed");
    expect(
      gauges.map(({ value, attributes }) => [
        attributes?.["quota.provider"],
        attributes?.["quota.window"],
        value,
      ]),
    ).toEqual([
      ["copilot", "unknown", 0.19],
      ["custom", "month", 0.36],
      ["minimax-coding-plan", "five_hour", 1],
      ["minimax-coding-plan", "week", 0.6],
    ]);

    // No API key and no private error body reaches a surface, the RPC, a file or a gauge.
    const savedSnapshot = await vi.waitFor(() =>
      readFile(join(mocks.root, "state", "opencode-quota", "snapshot-v6.json"), "utf8"),
    );
    expectNoCanary(
      expanded,
      sidebar(),
      tui.toast.mock.calls,
      quotaWindow(),
      tui.posted.mock.calls,
      exported,
      gauges,
      savedSnapshot,
    );

    // Settings: the window's Sidebar tab edits a draft that the real sidebar shows at once (the
    // tab expands the panel collapsed above); Save writes settings.jsonc and closes.
    const windowTree = () => tui.render("session.composer.top", { sessionID: "ses_1" });
    clickable(windowTree(), "Sidebar").props.onMouseUp();
    expect(words(sidebar())).toContain("Session 1.20K in · 45 out");
    const sessionTokens = settingLine(windowTree(), "sidebar.sessionTokens");
    expect(words(sessionTokens)).toEqual(["Session tokens line", "‹", "shown", "›"]);
    clickable(sessionTokens, "›").props.onMouseUp();
    expect(words(sidebar())).not.toContain("Session 1.20K in · 45 out");
    expect(tui.stored.has("settings")).toBe(false);
    clickable(windowTree(), "Save").props.onMouseUp();
    await vi.waitFor(() => expect(windowTree()).toBe(""), { timeout: 5_000 });
    expect(
      parseJsonc(
        await readFile(join(mocks.root, "config", "opencode-quota", "settings.jsonc"), "utf8"),
      ),
    ).toMatchObject({ sidebar: { sessionTokens: false } });
    expect(tui.stored.has("settings")).toBe(false);
    expect(tui.toast).toHaveBeenLastCalledWith(
      expect.objectContaining({ variant: "success", title: "Quota settings saved" }),
    );
    await tui.dispose();
  });

  describe("the quota window's Settings tabs", () => {
    /** Opens Settings on `tab`, and on Layout on one of its pages ("Sidebar", "All places"). */
    async function openSettings(tab: string, page?: string) {
      const tui = await startHosts();
      await tui.command("settings").run();
      const windowTree = () => tui.render("session.composer.top", { sessionID: "ses_1" });
      // The tab bar shows the tabs around the current one; tab steps on to the others.
      for (let step = 0; step < 12 && !clickable(windowTree(), tab); step += 1) {
        tui
          .layer(10)
          .commands.find((command) => command.bind === "tab")
          ?.run();
      }
      clickable(windowTree(), tab).props.onMouseUp();
      if (page) clickable(windowTree(), page).props.onMouseUp();
      await vi.waitFor(() => expect(words(windowTree())).not.toContain("Loading settings…"));
      return { tui, windowTree };
    }

    it("checks found providers by default, saves unticks and checks a provider found later", async () => {
      writePluginTestSettings(mocks.root, {
        providers: { off: [], checking: { minIntervalMs: 1 } },
      });
      let cursorFound = false;
      const cursor = {
        ...fakeProvider("cursor", "Cursor", [percentRow("monthly", "Month", 60)]),
        isAvailable: async () => cursorFound,
      };
      mocks.getProviders.mockReturnValue([
        fakeProvider("copilot", "Copilot", [percentRow("allowance", "Plan", 81)]),
        cursor,
      ]);
      const { tui, windowTree } = await openSettings("Providers");
      try {
        // Only a ticked provider quota can't find has a word; the tick says the rest.
        await vi.waitFor(() =>
          expect(words(settingLine(windowTree(), "provider.cursor"))).toContain("not set up"),
        );
        expect(words(settingLine(windowTree(), "provider.copilot"))).toEqual([
          "[x] Copilot",
          "",
          "",
          "",
        ]);
        expect(words(windowTree())).not.toContain("Check");
        // A tick with a word keeps it lined up; without one a long name shows whole.
        const alibaba = () => settingLine(windowTree(), "provider.alibaba-token-plan");
        expect(words(alibaba())).toEqual(["[x] Alibaba Personal Toke…", "", "not set up", ""]);
        clickable(alibaba(), "[x] Alibaba Personal Toke…").props.onMouseUp();
        expect(words(alibaba())[0]).toBe("[ ] Alibaba Personal Token Plan");
        clickable(alibaba(), "[ ] Alibaba Personal Token Plan").props.onMouseUp();
        // The ticks are the tab's top lines, as far in as any other line.
        expect(textLines(settingLine(windowTree(), "provider.copilot"))[0]).toMatch(
          /^ {3}\[x\] Copilot/u,
        );
        clickable(settingLine(windowTree(), "provider.copilot"), "[x] Copilot").props.onMouseUp();
        expect(words(settingLine(windowTree(), "provider.copilot"))).toEqual([
          "[ ] Copilot",
          "",
          "",
          "",
        ]);
        clickable(windowTree(), "Save").props.onMouseUp();
        await vi.waitFor(() => expect(windowTree()).toBe(""), { timeout: 5_000 });
        expect(
          parseJsonc(
            await readFile(join(mocks.root, "config", "opencode-quota", "settings.jsonc"), "utf8"),
          ).providers.off,
        ).toEqual(["copilot"]);
        cursorFound = true;
        await tui.handlers.refresh!({ reason: "manual", sessionID: "ses_1" }, {});
        await tui.command("settings").run();
        for (let step = 0; step < 12 && !clickable(windowTree(), "Providers"); step += 1)
          tui.press(10, "tab");
        clickable(windowTree(), "Providers").props.onMouseUp();
        await vi.waitFor(() =>
          expect(words(settingLine(windowTree(), "provider.cursor"))).not.toContain("not set up"),
        );
        expect(words(settingLine(windowTree(), "provider.cursor"))).toContain("[x] Cursor");
        // A tick not saved yet is not checked yet, so it has no word either.
        clickable(settingLine(windowTree(), "provider.copilot"), "[ ] Copilot").props.onMouseUp();
        expect(words(settingLine(windowTree(), "provider.copilot"))).toEqual([
          "[x] Copilot",
          "",
          "",
          "",
        ]);
      } finally {
        await tui.dispose();
      }
    });

    it("a hand edit updates the real sidebar, footer, toast and Limits tab over a draft", async () => {
      const { tui, windowTree } = await openSettings("Layout", "Sidebar");
      try {
        const sidebar = () => words(tui.render("sidebar.content", { sessionID: "ses_1" }));
        await vi.waitFor(() => expect(sidebar()).toContain("Plan ███████████████░░░ 81%"));
        clickable(settingLine(windowTree(), "sidebar.sessionTokens"), "›").props.onMouseUp();
        const path = join(mocks.root, "config", "opencode-quota", "settings.jsonc");
        const file = parseJsonc(await readFile(path, "utf8"));
        file.sidebar = { names: { "copilot.allowance": "Sidebar quota" } };
        file.toast = { afterReply: "always", names: { "copilot.allowance": "Reply" } };
        file.statusLine = { detail: "one", withSidebar: true, window: { copilot: "month" } };
        file.words = { percent: "used" };
        await writeFile(path, JSON.stringify(file));
        await vi.waitFor(() =>
          expect(sidebar().join(" ")).toContain("Sidebar… ███████████░░░ 19%"),
        );
        expect(sidebar()).toContain("▼ Quota used");
        expect(sidebar().join(" ")).not.toContain("Session 1.20K");
        const footer = () => words(tui.render("prompt.footer", { sessionID: "ses_1" })).join(" ");
        await vi.waitFor(() => expect(footer()).toContain("19%"));
        tui.emit("session.execution.succeeded", { sessionID: "ses_1" });
        await vi.waitFor(() =>
          expect(tui.toast).toHaveBeenLastCalledWith(
            expect.objectContaining({ message: expect.stringContaining("Reply") }),
          ),
        );
        clickable(windowTree(), "Limits").props.onMouseUp();
        expect(words(windowTree()).join(" ")).toContain("Sidebar quota");
      } finally {
        await tui.dispose();
      }
    });

    it("hides the status line while a sidebar panel shows quota, except on its own tab", async () => {
      const path = join(mocks.root, "config", "opencode-quota", "settings.jsonc");
      const file = parseJsonc(await readFile(path, "utf8"));
      file.statusLine = { detail: "one" };
      await writeFile(path, JSON.stringify(file));
      const tui = await startHosts();
      try {
        const footer = () => words(tui.render("prompt.footer", { sessionID: "ses_1" })).join(" ");
        // No sidebar on screen yet: the status line shows.
        await vi.waitFor(() => expect(footer()).toContain("81% left"));
        tui.render("sidebar.content", { sessionID: "ses_1" });
        expect(footer()).toBe("");

        // On the Status line tab it shows, so its changes can be seen.
        await tui.command("settings").run();
        const windowTree = () => tui.render("session.composer.top", { sessionID: "ses_1" });
        for (let step = 0; step < 12 && !clickable(windowTree(), "Status line"); step += 1) {
          tui
            .layer(10)
            .commands.find((command) => command.bind === "tab")
            ?.run();
        }
        clickable(windowTree(), "Status line").props.onMouseUp();
        await vi.waitFor(() => expect(words(windowTree())).not.toContain("Loading settings…"));
        expect(words(settingLine(windowTree(), "statusLine.withSidebar")).join(" ")).toContain(
          "Next to the sidebar ‹ hide the line ›",
        );
        expect(footer()).toContain("81% left");
        clickable(windowTree(), "esc").props.onMouseUp();
        expect(footer()).toBe("");

        // With the sidebar panel off, the sidebar shows no quota, so the status line does.
        file.sidebar = { show: false };
        await writeFile(path, JSON.stringify(file));
        await vi.waitFor(() => expect(footer()).toContain("81% left"));
      } finally {
        await tui.dispose();
      }
    });

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
        const { tui, windowTree } = await openSettings("Layout", page);
        try {
          await vi.waitFor(() => expect(textLines(windowTree())).toContain(heading));
          const lines = textLines(windowTree());
          if (toggle) expect(lines[lines.indexOf(toggle) - 1]).toBe(" Enable/disable");
          const at = lines.findIndex((text) => text.startsWith(`   ${line}`));
          expect(at).toBeGreaterThan(0);
          expect(lines[at - 1]).toBe(heading);
        } finally {
          await tui.dispose();
        }
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
      await tui.dispose();
    });

    it("gives the typed text's keys to its input, and the window its keys back on a tab change", async () => {
      const { tui, windowTree } = await openSettings("Colors");
      const press = () =>
        settingLine(windowTree(), "colors.good")[0]?.props.onMouseDown({ button: 0 });
      press();
      press();
      const input = findAll(windowTree(), (node) => node.type === "input")[0];
      input?.props.ref(input);
      expect([tui.layer(20).enabled?.(), tui.layer(20).target?.()]).toEqual([true, input]);
      expect(tui.layer(10).enabled?.()).toBe(false);

      // Each render makes new nodes, so the window box is "the focusable box".
      clickable(windowTree(), "Layout").props.onMouseUp();
      expect(tui.layer(10).enabled?.()).toBe(true);
      expect(tui.focused()).toMatchObject({ type: "box", props: { focusable: true } });
      await tui.dispose();
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
      tui.press(11, "down");
      expect(activeLabels(windowTree())).toContain("Sidebar");
      tui.press(11, "down");
      expect(activeLabels(windowTree())).toContain("Collapsed");
      tui.press(11, "up");
      expect(activeLabels(windowTree())).toContain("Sidebar");

      // → goes to the page's first line, its switch; ↑ there goes back to the list.
      tui.press(11, "right");
      expect(litSettingLines(windowTree())).toEqual(["surface"]);
      tui.press(11, "up");
      expect(litSettingLines(windowTree())).toEqual([]);
      tui.press(11, "up");
      expect(activeLabels(windowTree())).toContain("All places");
      tui.press(11, "up");
      expect(activeLabels(windowTree())).toContain("All places");

      // Enter goes to All places' first line, its first option; ←/→ there change its value.
      tui.press(11, "return");
      expect(litSettingLines(windowTree())).toEqual(["preset.layout"]);
      const preset = words(settingLine(windowTree(), "preset.layout"));
      tui.press(11, "right");
      expect(words(settingLine(windowTree(), "preset.layout"))).not.toEqual(preset);
      expect(activeLabels(windowTree())).toContain("All places");
      tui.press(11, "down");
      expect(litSettingLines(windowTree())).toEqual(["layout.bar"]);
      tui.press(11, "up");
      tui.press(11, "up");
      expect(litSettingLines(windowTree())).toEqual([]);

      // A click on a page shows it and gives the list the keyboard, even on the page shown.
      tui.press(11, "return");
      clickable(windowTree(), "All places").props.onMouseUp();
      expect(litSettingLines(windowTree())).toEqual([]);
      clickable(windowTree(), "Toast").props.onMouseUp();
      expect(activeLabels(windowTree())).toContain("Toast");
      tui.press(11, "up");
      expect(activeLabels(windowTree())).toContain("Status line");
      tui.press(11, "down");

      // Back on Layout from another tab: the page shown last.
      clickable(windowTree(), "Colors").props.onMouseUp();
      clickable(windowTree(), "Layout").props.onMouseUp();
      expect(activeLabels(windowTree())).toContain("Toast");
      expect(words(windowTree())).toContain("Reset page");
      await tui.dispose();
    });

    it("has no /quota form setting on the Layout tab", async () => {
      const { tui, windowTree } = await openSettings("Layout", "All places");
      expect(words(windowTree())).not.toContain("/quota shows");
      expect(tui.stored.has("settings")).toBe(false);
      await tui.dispose();
    });

    it("opens OpenCode's theme list from the theme line's ▸", async () => {
      const { tui, windowTree } = await openSettings("Colors");
      clickable(settingLine(windowTree(), "theme"), "▸").props.onMouseUp();
      expect(tui.dispatch).toHaveBeenCalledWith("theme.switch");
      await tui.dispose();
    });

    it("takes the keyboard back after Light or dark gives it to the message box", async () => {
      const { tui, windowTree } = await openSettings("Colors");
      const windowBox = { type: "box", props: { focusable: true } };
      await vi.waitFor(() => expect(tui.focused()).toMatchObject(windowBox));
      // OpenCode's switch closes its dialogs, which focuses the message box a moment later.
      tui.dispatch.mockImplementationOnce(() => setTimeout(tui.focusMessageBox, 1));
      clickable(settingLine(windowTree(), "themeMode"), "›").props.onMouseUp();
      expect(tui.dispatch).toHaveBeenCalledWith("theme.switch_mode");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(tui.focused()).toBe("message box");
      await vi.waitFor(() => expect(tui.focused()).toMatchObject(windowBox));
      await tui.dispose();
    });

    it("saves the words on All places and a custom provider switched on in Providers to settings.jsonc, then fetches it", async () => {
      writePluginTestSettings(mocks.root, {
        providers: {
          off: CONFIG_PROVIDER_IDS.filter((id) => !["copilot", "custom"].includes(id)),
          custom: [{ ...CUSTOM_SOURCES[0], enabled: false }],
          checking: { minIntervalMs: 1 },
        },
      });
      const teamUrl = CUSTOM_SOURCES[0]?.url;
      const fetchedTeam = () => vi.mocked(fetch).mock.calls.some(([url]) => url === teamUrl);
      const { tui, windowTree } = await openSettings("Layout", "All places");
      const sidebar = () => words(tui.render("sidebar.content", { sessionID: "ses_1" }));
      await vi.waitFor(() => expect(sidebar()).toContain("Plan ████████████████░░░░ 81%"));
      await vi.waitFor(() => expect(settingLine(windowTree(), "words.percent")).toHaveLength(1));

      // The sidebar shows the new words before they are saved.
      clickable(settingLine(windowTree(), "words.percent"), "‹").props.onMouseUp();
      expect(sidebar()).toEqual(
        expect.arrayContaining(["▼ Quota used", "Plan ████████████████░░░░ 19%"]),
      );

      clickable(windowTree(), "Providers").props.onMouseUp();
      const team = () => settingLine(windowTree(), "custom.team-accounting");
      await vi.waitFor(() => expect(team()).toHaveLength(1));
      expect(words(windowTree())).toEqual(
        expect.arrayContaining([
          "Custom providers (added in settings.jsonc)",
          "Team",
          "off",
          "https://team-gateway.example/accounting",
          "key: V6_TEAM_KEY, else OpenCode's team-gateway key",
        ]),
      );
      expect(fetchedTeam()).toBe(false);

      clickable(team(), "›").props.onMouseUp();
      clickable(windowTree(), "Save").props.onMouseUp();
      const settingsFile = join(mocks.root, "config", "opencode-quota", "settings.jsonc");
      await vi.waitFor(async () =>
        expect(parseJsonc(await readFile(settingsFile, "utf8"))).toMatchObject({
          words: { percent: "used" },
          providers: { custom: [{ id: "team-accounting", enabled: true }] },
        }),
      );
      // The window closes once the save's answer is back, a moment after the file changed.
      await vi.waitFor(() => expect(windowTree()).toBe(""), { timeout: 5_000 });

      // The plugin uses the saved settings at once: the next check asks the custom provider.
      await tui.command("settings").run();
      await vi.waitFor(() => expect(fetchedTeam()).toBe(true));
      await tui.dispose();
    });

    it("keeps a custom provider off when it changed after the Providers tab showed it", async () => {
      const settings = (url: string) =>
        writePluginTestSettings(mocks.root, {
          providers: {
            off: CONFIG_PROVIDER_IDS.filter((id) => !["copilot", "custom"].includes(id)),
            custom: [{ ...CUSTOM_SOURCES[0], url, enabled: false }],
            checking: { minIntervalMs: 1 },
          },
        });
      settings("https://team-gateway.example/accounting");
      const settingsFile = join(mocks.root, "config", "opencode-quota", "settings.jsonc");
      const custom = async () => parseJsonc(await readFile(settingsFile, "utf8")).providers.custom;
      const { tui, windowTree } = await openSettings("Providers");
      const team = () => settingLine(windowTree(), "custom.team-accounting");
      await vi.waitFor(() => expect(team()).toHaveLength(1));
      clickable(team(), "›").props.onMouseUp();

      // An agent points the provider somewhere else (saved switched off) before the user saves.
      settings("https://other.example/accounting");
      await vi.waitFor(() =>
        expect(words(team()).join(" ")).toContain("https://other.example/accounting"),
      );
      clickable(windowTree(), "Save").props.onMouseUp();

      // Too long to follow the value in 120 columns: the note goes on a line under it.
      await vi.waitFor(() =>
        expect(words(windowTree())).toContain(
          "changed since you reviewed it; look again · https://other.example/accounting",
        ),
      );
      expect(await custom()).toMatchObject([{ id: "team-accounting", enabled: false }]);
      expect(words(team())).toContain("off");
      expect(tui.toast).toHaveBeenLastCalledWith(
        expect.objectContaining({ variant: "error", title: "Quota settings not saved" }),
      );
      await tui.dispose();
    });
  });

  it("shows OpenCode's usage in the Usage tab, its model popup and Web /quota_usage", async () => {
    const now = Date.now();
    const M = 1_000_000;
    writeSessionDatabase(join(mocks.root, "data", "opencode.db"), {
      sessions: [{ id: "ses_1", created: now - 3_600_000 }],
      messages: [
        {
          id: "msg_1",
          sessionID: "ses_1",
          created: now - 60_000,
          completed: now - 59_000,
          providerID: "anthropic",
          modelID: "claude-sonnet-4-5",
          tokens: { input: M, cacheRead: 3 * M, output: M / 10 },
        },
        {
          id: "msg_2",
          sessionID: "ses_1",
          created: now - 30_000,
          completed: now - 29_000,
          providerID: "acme",
          modelID: "mystery-1",
          tokens: { output: M / 2 },
        },
      ],
    });
    const tui = await startHosts();

    // The palette's usage command opens the window on its Usage tab, on Today.
    await tui.command("usage").run();
    const usageTab = () => tui.render("session.composer.top", { sessionID: "ses_1" });
    await vi.waitFor(() => expect(activeLabels(usageTab())).toContain("Today"));
    clickable(usageTab(), "7 days").props.onMouseUp();
    await vi.waitFor(() => expect(words(usageTab()).join(" ")).toContain("Daily cost"));
    const tab = words(usageTab());
    expect(tab).toEqual(
      expect.arrayContaining([
        "Usage",
        // The daily chart sits beside the total when it gets 32 columns there.
        expect.stringMatching(/^\$\d+\.\d\d 1 session · API estimate Daily cost$/u),
        "Totals",
        "Cost by type",
        "# Model Cost Share Tokens Cache",
        // Cache: 3M of the 4M input tokens came from the cache; output alone has no cache hit.
        expect.stringMatching(/^1 ● claude-sonnet-4-5 ━+ \$\d+\.\d\d 100\.0% 4\.10M 75% ▸$/u),
        "2 ● mystery-1 no price 0% 500K — ▸",
      ]),
    );
    // A cache hit that is not low takes the theme's success color.
    const cacheHit = findAll(
      usageTab(),
      (node) => node.type === "span" && node.props.children === "    75%",
    );
    expect(cacheHit.map((node) => node.props.style.fg)).toEqual(["green"]);
    // The share without a price is the content's last line.
    expect(tab.at(-2)).toBe("Unpriced tokens excluded: 10.9% (mystery-1)");

    // A click on a model row opens its details in OpenCode's dialog.
    const modelRow = findAll(
      usageTab(),
      (node) => node.type === "text" && textLines(node)[0]?.includes("claude-sonnet-4-5") === true,
    ).find((node) => typeof node.props.onMouseUp === "function");
    modelRow?.props.onMouseUp();
    expect(tui.dialog.show).toHaveBeenCalledOnce();
    const popup = words(tui.dialog.show.mock.calls[0]?.[0]());
    expect(popup).toEqual(
      expect.arrayContaining([
        "● claude-sonnet-4-5",
        "Anthropic · 100.0% of cost",
        "Cost Tokens Per 1M tokens Cache hit",
        expect.stringMatching(/^\$\d+\.\d\d 4\.10M \$\d+\.\d\d 75\.0%$/u),
        "esc",
      ]),
    );

    // Web and Desktop: /quota_usage posts the same report as text, here for this session.
    await tui.serverCommand("quota_usage", "ses_1", "session");
    const message = tui.posted.mock.calls[0]?.[0].text ?? "";
    expect(message).toContain("Usage · This session\n$");
    expect(message).toContain("1 session · API estimate");
    expect(message).toMatch(/1 {2}● claude-sonnet-4-5 .+4\.10M/u);
    await tui.dispose();
  });

  it("starts the Usage tab on the range typed after /quota_usage, and says why one is wrong", async () => {
    writeUsageHistory();
    const tui = await startHosts();
    const usageTab = () => tui.render("session.composer.top", { sessionID: "ses_1" });

    tui.typed("/quota_usage 30d");
    await vi.waitFor(() => expect(words(usageTab())).toContain("Breakdown"));
    expect(activeLabels(usageTab())).toContain("30 days");
    expect(words(usageTab())).toContainEqual(expect.stringMatching(/ 2 sessions · API estimate/u));

    tui.typed(`/quota_usage between ${localDate(-12)} ${localDate(-8)}`);
    await vi.waitFor(() => expect(activeLabels(usageTab())).toContain("Between"));
    // d puts the typed dates in two boxes to change them.
    expect(findAll(usageTab(), (node) => node.type === "input")).toEqual([]);
    tui.press(11, "d");
    expect(
      findAll(usageTab(), (node) => node.type === "input").map((node) => node.props.value),
    ).toEqual([localDate(-12), localDate(-8)]);
    await vi.waitFor(() =>
      expect(words(usageTab())).toContainEqual(expect.stringMatching(/^1 ● mystery-old /u)),
    );

    // A wrong range leaves the tab as it was and says how to type one.
    tui.typed("/quota_usage session_tree");
    expect(tui.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: "warning",
        message: expect.stringMatching(
          /^Unknown range "session_tree"\.\nUsage: \/quota_usage \[today/u,
        ),
      }),
    );
    expect(activeLabels(usageTab())).toContain("Between");

    // All time counts the session from 10 days ago too.
    tui.typed("/quota_usage all");
    await vi.waitFor(() => expect(activeLabels(usageTab())).toContain("All time"));
    await vi.waitFor(() =>
      expect(words(usageTab())).toContainEqual(
        expect.stringMatching(/ 2 sessions · API estimate/u),
      ),
    );

    // A bare /quota_usage starts on Today again.
    tui.typed("/quota_usage");
    await vi.waitFor(() => expect(activeLabels(usageTab())).toContain("Today"));
    expect(activeLabels(usageTab())).not.toContain("All time");
    await tui.dispose();
  });

  it("runs the 4.x and 5.x /tokens_* names, on by default, names the new command while the Plugin switch is off, and runs them again once it is back on", async () => {
    writeUsageHistory();
    const tui = await startHosts();
    const windowTree = () => tui.render("session.composer.top", { sessionID: "ses_1" });

    // On by default: /tokens_monthly opens Usage on the last 30 days, /tokens_all on all time,
    // /tokens_between on its dates.
    tui.typed("/tokens_monthly");
    await vi.waitFor(() => expect(activeLabels(windowTree())).toContain("30 days"));
    tui.typed("/tokens_all");
    await vi.waitFor(() => expect(activeLabels(windowTree())).toContain("All time"));
    tui.typed(`/tokens_between ${localDate(-12)} ${localDate(-8)}`);
    await vi.waitFor(() => expect(activeLabels(windowTree())).toContain("Between"));
    tui.press(11, "d");
    expect(
      findAll(windowTree(), (node) => node.type === "input").map((node) => node.props.value),
    ).toEqual([localDate(-12), localDate(-8)]);

    // Plugin's switch saves it at once.
    tui.typed("/quota_status");
    const oldCommands = () => settingLine(windowTree(), "system.oldCommands");
    await vi.waitFor(() =>
      expect(words(oldCommands())).toEqual(expect.arrayContaining(["Old command names", "on"])),
    );
    clickable(oldCommands(), "›").props.onMouseUp();
    await vi.waitFor(() => expect(words(oldCommands())).toContain("off"), { timeout: 5_000 });

    // While off (an open TUI's "/" list can still name them until OpenCode restarts), an old name
    // says what to type now, and nothing reaches the chat.
    tui.typed("/tokens_monthly");
    expect(tui.toast).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: "Use /quota_usage 30d. The old /tokens_* names turn on in /quota_status.",
      }),
    );
    tui.typed("/tokens_between 2026-01-01 2026-01-31");
    expect(tui.toast).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message:
          "Use /quota_usage between YYYY-MM-DD YYYY-MM-DD. The old /tokens_* names turn on in /quota_status.",
      }),
    );
    expect(tui.posted).not.toHaveBeenCalled();

    // Switched back on, both names open Usage again.
    tui.typed("/quota_status");
    await vi.waitFor(() => expect(words(oldCommands())).toContain("off"));
    clickable(oldCommands(), "›").props.onMouseUp();
    await vi.waitFor(() => expect(words(oldCommands())).toContain("on"), { timeout: 5_000 });
    tui.typed("/tokens_monthly");
    await vi.waitFor(() => expect(activeLabels(windowTree())).toContain("30 days"));
    tui.typed(`/tokens_between ${localDate(-6)} ${localDate(-3)}`);
    await vi.waitFor(() => expect(activeLabels(windowTree())).toContain("Between"));
    tui.press(11, "d");
    expect(
      findAll(windowTree(), (node) => node.type === "input").map((node) => node.props.value),
    ).toEqual([localDate(-6), localDate(-3)]);
    await tui.dispose();
  });

  it("keeps the newest range when an older answer arrives last", async () => {
    writeUsageHistory();
    const tui = await startHosts();
    const usageTab = () => tui.render("session.composer.top", { sessionID: "ses_1" });
    const usage = tui.handlers.usage;
    let releaseFirst = () => {};
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    tui.handlers.usage = async (input, context) => {
      calls += 1;
      const answer = await usage(input, context);
      if (calls === 1) await firstHeld;
      return answer;
    };

    await tui.command("usage").run();
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
    await tui.dispose();
  });

  it("applies two Between dates typed in the tab, and warns about dates out of order", async () => {
    writeUsageHistory();
    const tui = await startHosts();
    const usageTab = () => tui.render("session.composer.top", { sessionID: "ses_1" });
    await tui.command("usage").run();
    await vi.waitFor(() => expect(words(usageTab())).toContain("Breakdown"));

    clickable(usageTab(), "Between").props.onMouseUp();
    const [from, to] = fakeInputs([localDate(-12), localDate(-14)]);
    for (const [index, node] of findAll(usageTab(), (item) => item.type === "input").entries()) {
      node.props.ref([from, to][index]);
    }
    await vi.waitFor(() => expect(from?.focused).toBe(true));
    // While a date has the keyboard, the window's bottom line names the keys there.
    expect(words(usageTab())).toContain("enter next date tab other date esc back");

    tui.press(11, "return");
    expect(to?.focused).toBe(true);
    expect(words(usageTab())).toContain("enter apply tab other date esc back");
    // A click on a date box stays with it: the window under it does not take the keyboard back.
    const click = { stopPropagation: vi.fn() };
    findAll(usageTab(), (item) => item.type === "input")[1]?.props.onMouseDown(click);
    expect(click.stopPropagation).toHaveBeenCalledOnce();
    expect(to?.focused).toBe(true);
    tui.press(11, "return");
    expect(tui.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: "warning",
        message: "Type two dates like 2026-09-01, the first one not after the second.",
      }),
    );

    if (to) to.value = localDate(-8);
    tui.press(11, "return");
    await vi.waitFor(() =>
      expect(words(usageTab())).toContainEqual(expect.stringMatching(/^1 ● mystery-old /u)),
    );
    expect(words(usageTab())).not.toContainEqual(expect.stringContaining("claude-sonnet-4-5"));
    // The boxes give way to the dates after the range's name.
    expect(findAll(usageTab(), (node) => node.type === "input")).toEqual([]);
    expect(words(usageTab())).toContainEqual(
      expect.stringMatching(/^\w{3} \d{1,2}(, \d{4})? – \w{3} \d{1,2}(, \d{4})?$/u),
    );
    await tui.dispose();
  });

  it("picks a range with ↑↓, walks the model rows after →, and switches what it shows with c, t and b", async () => {
    writeUsageHistory();
    const tui = await startHosts();
    const usageTab = () => tui.render("session.composer.top", { sessionID: "ses_1" });
    tui.typed("/quota_usage 30d");
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
    tui.press(11, "up");
    expect(activeLabels(usageTab())).toContain("7 days");
    tui.press(11, "down");
    expect(activeLabels(usageTab())).toContain("30 days");
    await vi.waitFor(() =>
      expect(words(usageTab())).toContainEqual(expect.stringMatching(/ 2 sessions · /u)),
    );

    // → gives the model rows the keyboard, each lit alone; past the last one ↓ scrolls the
    // window. Enter opens the lit one's details.
    tui.press(11, "right");
    expect(litUsageLines(usageTab())).toEqual(["quota-usage-model-0"]);
    tui.press(11, "down");
    expect(litUsageLines(usageTab())).toEqual(["quota-usage-model-1"]);
    expect(tui.press(11, "down")).toBe(false);
    tui.press(11, "return");
    expect(tui.dialog.show).toHaveBeenCalledOnce();
    expect(words(tui.dialog.show.mock.calls[0]?.[0]())).toContain("● mystery-old");

    // t shows tokens and c cost, from the first row again; b breaks down by day, which has no
    // model rows, then by model again.
    tui.press(11, "t");
    expect(activeLabels(usageTab())).toContain("Tokens");
    expect(litUsageLines(usageTab())).toEqual(["quota-usage-model-0"]);
    tui.press(11, "c");
    expect(activeLabels(usageTab())).toContain("Cost");
    tui.press(11, "b");
    expect(activeLabels(usageTab())).toContain("Day");
    expect(litUsageLines(usageTab())).toEqual([]);
    tui.press(11, "b");
    expect(activeLabels(usageTab())).toContain("Model");

    // ← gives the range list the keyboard back.
    tui.press(11, "left");
    expect(litUsageLines(usageTab())).toEqual([]);
    tui.press(11, "up");
    expect(activeLabels(usageTab())).toContain("7 days");
    await tui.dispose();
  });

  it("gives the range list the keyboard when the tab shows again, and keeps it there without model rows", async () => {
    writeUsageHistory();
    const tui = await startHosts();
    const usageTab = () => tui.render("session.composer.top", { sessionID: "ses_1" });
    tui.typed("/quota_usage 30d");
    await vi.waitFor(() => expect(words(usageTab())).toContain("Breakdown"));
    tui.press(11, "right");
    expect(litUsageLines(usageTab())).toEqual(["quota-usage-model-0"]);

    // Away to Limits and back: the reload fails, so there is no Breakdown line nor model rows.
    tui.handlers.usage = async () => {
      throw new Error("usage history unreadable");
    };
    tui.press(10, "tab");
    usageTab();
    tui.press(10, "shift+tab");
    await vi.waitFor(() =>
      expect(words(usageTab())).toContainEqual(expect.stringContaining("Couldn't load the usage")),
    );
    expect(litUsageLines(usageTab())).toEqual([]);
    expect(tui.press(11, "right")).toBe(false);
    tui.press(11, "down");
    expect(activeLabels(usageTab())).toContain(RANGE_AFTER_DEFAULT);
    await tui.dispose();
  });

  it("shows the default range whenever you switch to the Usage tab, and keeps Cost or Tokens and Model or Day", async () => {
    writeUsageHistory();
    const tui = await startHosts();
    const usageTab = () => tui.render("session.composer.top", { sessionID: "ses_1" });
    const defaultLabel = usageRangeLabel(DEFAULT_USAGE_RANGE);
    tui.typed("/quota_usage 30d");
    await vi.waitFor(() => expect(words(usageTab())).toContain("Breakdown"));
    expect(activeLabels(usageTab())).toContain("30 days");
    tui.press(11, "t");
    tui.press(11, "b");

    // tab and shift+tab: back on Usage, the default range, still Tokens by day.
    tui.press(10, "tab");
    usageTab();
    tui.press(10, "shift+tab");
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
    await tui.command("limits").run();
    await tui.command("usage").run();
    expect(activeLabels(usageTab())).toContain(defaultLabel);

    // A command that names a range still shows it.
    tui.typed("/quota_usage 30d");
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
    await tui.dispose();
  });

  it("keeps the model popup's esc whole on a 32 × 16 terminal", async () => {
    mocks.terminal = { width: 32, height: 16 };
    writeUsageHistory("claude-sonnet-4-5-with-a-very-long-model-name");
    const tui = await startHosts();
    const usageTab = () => tui.render("session.composer.top", { sessionID: "ses_1" });
    await tui.command("usage").run();
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
    await tui.dispose();
  });

  it("says why a price download failed", async () => {
    writeUsageHistory();
    const tui = await startHosts();
    const usageTab = () => tui.render("session.composer.top", { sessionID: "ses_1" });
    await tui.command("usage").run();
    await vi.waitFor(() => expect(words(usageTab())).toContain("Breakdown"));

    tui.press(11, "p");

    await vi.waitFor(() =>
      expect(tui.toast).toHaveBeenCalledWith({
        variant: "error",
        title: "Prices",
        message: "Couldn't download new prices: network down.",
        duration: 6_000,
      }),
    );
    await tui.dispose();
  });
});

const OLD_TEAM_KEY = "v6-replaced-team-key-canary";
const NEW_TEAM_KEY = "v6-replacement-team-key-canary";

/** A custom provider that is on (no `enabled`), as the user wrote it. */
const ACTIVE_SOURCE = {
  id: "team-quota",
  providerId: "team-gateway",
  label: "Team",
  mode: "remote-api",
  url: "https://old-gateway.example/quota",
  format: "quota-v1",
  apiKeyEnv: "V6_OLD_TEAM_KEY",
};

/** What an agent sends to replace it: another address and another key. */
const REPLACEMENT = {
  ...ACTIVE_SOURCE,
  url: "https://new-gateway.example/quota",
  apiKeyEnv: "V6_NEW_TEAM_KEY",
};

type AgentTool = { name: string; execute(input: unknown): Promise<{ content: string }> };
type ChangedEvent = { snapshot: { providers: Array<{ providerId: string }> } };

/** The real server plugin alone: its agent tools, a manual refresh, and its `changed` events. */
async function startServer() {
  const { default: serverPlugin } = await import("../src/plugin.js");
  const changed: ChangedEvent[] = [];
  const register = vi.fn(async () => ({
    dispose: async () => {},
    events: {
      emit: async (name: string, data: ChangedEvent) => {
        if (name === "changed") changed.push(structuredClone(data));
      },
    },
  }));
  const tools: AgentTool[] = [];
  const dispose = await serverPlugin.setup({
    location: { directory: process.cwd() },
    provider: { list: async () => ({ data: [{ id: "team-gateway" }] }) },
    session: { get: async () => ({}), hook: vi.fn() },
    command: { transform: vi.fn() },
    rpc: { register },
    integration: createFakeIntegration([]),
    event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
    tool: {
      transform: async (build: (editor: { add(tool: AgentTool): void }) => void) =>
        build({ add: (tool) => tools.push(tool) }),
    },
  } as never);
  const [, handlers] = register.mock.calls[0] as unknown as [
    unknown,
    { refresh(input: { reason: string }): Promise<unknown> },
  ];
  return {
    changed,
    // "manual" waits for no interval: every provider that is on is asked now.
    refresh: () => handlers.refresh({ reason: "manual" }),
    tool: (name: string) => {
      const tool = tools.find((item) => item.name === name);
      if (!tool) throw new Error(`tool not registered: ${name}`);
      return tool;
    },
    dispose: dispose as unknown as () => Promise<void>,
  };
}

describe("an agent tool replacing an active custom provider", () => {
  const savedEnv = {
    V6_OLD_TEAM_KEY: process.env.V6_OLD_TEAM_KEY,
    V6_NEW_TEAM_KEY: process.env.V6_NEW_TEAM_KEY,
  };
  let requests: Array<{ url: string; authorization: string | null }>;
  let server: Awaited<ReturnType<typeof startServer>> | undefined;

  beforeEach(async () => {
    mocks.root = await mkdtemp(join(tmpdir(), "opencode-quota-v6-tool-reload-"));
    process.env.V6_OLD_TEAM_KEY = OLD_TEAM_KEY;
    process.env.V6_NEW_TEAM_KEY = NEW_TEAM_KEY;
    seedDefaultPluginBootstrapMocks(mocks, { resetPluginState: true });
    writePluginTestSettings(mocks.root, {
      providers: {
        off: CONFIG_PROVIDER_IDS.filter((id) => !["custom"].includes(id)),
        custom: [ACTIVE_SOURCE],
        checking: { minIntervalMs: 3_600_000 },
      },
    });
    const { quotaProvidersProvider } = await import("../src/providers/quota-providers.js");
    mocks.getProviders.mockReturnValue([quotaProvidersProvider]);
    requests = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
        return new Response(JSON.stringify({ version: "quota-v1", entries: [] }), {
          headers: { "content-type": "application/json" },
        });
      }),
    );
  });

  afterEach(async () => {
    await server?.dispose();
    server = undefined;
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    vi.unstubAllGlobals();
    await rm(mocks.root, { recursive: true, force: true, maxRetries: 3 });
  });

  it("sends no further request with the old definition or key once the settings reload", async () => {
    server = await startServer();
    await server.refresh();
    expect(requests).toEqual([{ url: ACTIVE_SOURCE.url, authorization: `Bearer ${OLD_TEAM_KEY}` }]);

    const { content } = await server.tool("quota_provider_add").execute({
      definition: REPLACEMENT,
    });
    expect(JSON.parse(content)).toMatchObject({
      ok: true,
      replaced: ACTIVE_SOURCE.id,
      enabled: false,
    });
    expect(content).not.toContain(OLD_TEAM_KEY);
    expect(content).not.toContain(NEW_TEAM_KEY);
    const sentBefore = requests.length;
    const changedBefore = server.changed.length;

    // The same server, no restart: the settings watch reads the saved file, and the next
    // snapshot has no custom provider left to check.
    await vi.waitFor(
      () =>
        expect(
          server?.changed
            .slice(changedBefore)
            .some(({ snapshot }) => snapshot.providers.length === 0),
        ).toBe(true),
      { timeout: 10_000 },
    );
    await server.refresh();
    await server.refresh();

    // The replacement is switched off: neither the old address and key nor the new ones.
    expect(requests.slice(sentBefore)).toEqual([]);
  });
});
