import { QUOTA_PROVIDER_CATALOG } from "../src/lib/provider-metadata.js";

const CONFIG_PROVIDER_IDS = Object.keys(QUOTA_PROVIDER_CATALOG).map((id) =>
  id === "quota-providers" ? "custom" : id,
);

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
import { createFakeTuiHost, stubJsx } from "./helpers/fake-tui-host.js";
import {
  activeLabels,
  clickable,
  findAll,
  settingLine,
  THEME,
  textLines,
  words,
} from "./helpers/jsx-tree.js";
import {
  createAlibabaAuthModuleMock,
  createProvidersRegistryModuleMock,
  createSessionUsageModuleMock,
  seedDefaultPluginBootstrapMocks,
  writePluginTestSettings,
} from "./helpers/plugin-test-harness.js";
import { createQuotaRpcBridge, createQuotaRpcEvents } from "./helpers/quota-rpc-bridge.js";
import { writeSessionDatabase } from "./helpers/session-database.js";
import { localDate, writeUsageHistory } from "./helpers/usage-history.js";

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
  sessionUsage: vi.fn(),
}));

vi.mock("@opentui/solid", () => ({
  useTerminalDimensions: () => () => mocks.terminal,
}));
vi.mock("../src/providers/registry.js", () =>
  createProvidersRegistryModuleMock(mocks.getProviders),
);
vi.mock("../src/core/usage.js", async (importOriginal) =>
  createSessionUsageModuleMock(await importOriginal(), mocks.sessionUsage),
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

type ServerCommand = {
  name: string;
  execute(invocation: { sessionID: string; prompt: { text: string } }): Promise<void>;
};

function expectNoCanary(...outputs: unknown[]): void {
  const text = JSON.stringify(outputs);
  for (const canary of Object.values(CANARIES)) expect(text).not.toContain(canary);
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

  // Like OpenCode's prompt, the TUI client runs a server slash command in a session.
  const sessionCommand = vi.fn(async (input: { sessionID: string; name: string; text: string }) =>
    serverCommands
      .find((command) => command.name === input.name)
      ?.execute({ sessionID: input.sessionID, prompt: { text: input.text } }),
  );
  const tui = createFakeTuiHost({
    rpc: createQuotaRpcBridge(handlers, events),
    route: { type: "session", sessionID: "ses_1" },
    sessionCommand,
    theme: THEME,
  });
  stubJsx({ renderables: tui });
  const { default: tuiPlugin } = await import("../src/tui/index.tsx");
  const disposeTui = tuiPlugin.setup(tui.context as never);
  return {
    ...tui,
    /** The renderable that has the keyboard. */
    focused: () => tui.keyboard.current,
    /** The server's RPC handlers, looked up on each call: a test can wrap one. */
    handlers: handlers as Record<string, (input: unknown, context: unknown) => Promise<unknown>>,
    /** Runs a Web and Desktop slash command; `posted` gets its chat message. */
    serverCommand: (name: string, sessionID: string, text = "") =>
      serverCommands
        .find((command) => command.name === name)!
        .execute({ sessionID, prompt: { text } }),
    sessionCommand,
    posted,
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
      // Pinned, so a new default changes no expected text here.
      layout: {
        bar: "blocks",
        barWidth: "fill",
        evenUse: false,
        indent: 1,
        labelWidth: 8,
        providerGap: 1,
        separator: " · ",
      },
      sidebar: { runsOut: true },
      collapsed: { runsOut: false },
      toast: { afterReply: "always", layout: "grouped", runsOut: true },
      statusLine: { detail: "one", withSidebar: true, runsOut: false },
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
    mocks.sessionUsage.mockResolvedValue({
      input: 1200,
      cachedInput: 300,
      output: 45,
      models: [{ modelID: "gpt-5", input: 1200, cacheRead: 300, cacheWrite: 0 }],
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
        tui.press("window", "tab");
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
          tui.press("window", "tab");
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
          tui.press("window", "tab");
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
    writeUsageHistory(join(mocks.root, "data", "opencode.db"));
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
    tui.press("tab", "d");
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
    writeUsageHistory(join(mocks.root, "data", "opencode.db"));
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
    tui.press("tab", "d");
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
    tui.press("tab", "d");
    expect(
      findAll(windowTree(), (node) => node.type === "input").map((node) => node.props.value),
    ).toEqual([localDate(-6), localDate(-3)]);
    await tui.dispose();
  });

  it("says why a price download failed", async () => {
    writeUsageHistory(join(mocks.root, "data", "opencode.db"));
    const tui = await startHosts();
    const usageTab = () => tui.render("session.composer.top", { sessionID: "ses_1" });
    await tui.command("usage").run();
    await vi.waitFor(() => expect(words(usageTab())).toContain("Breakdown"));

    tui.press("tab", "p");

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

  it("sends no further request with the old definition or key once the agent tool answers", async () => {
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

    // The same server, no restart: it holds the saved settings once the tool answers, so the
    // next snapshot has no custom provider left to check.
    const { snapshot } = (await server.refresh()) as { snapshot: { providers: unknown[] } };
    expect(snapshot.providers).toEqual([]);
    await server.refresh();

    // The replacement is switched off: neither the old address and key nor the new ones.
    expect(requests.slice(sentBefore)).toEqual([]);
  });
});
