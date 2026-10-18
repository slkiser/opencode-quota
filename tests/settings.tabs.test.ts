import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { QuotaRow, QuotaSnapshot } from "../src/core/types.js";
import { quotaReportLines } from "../src/lib/quota-dialog-commands.js";
import {
  clientSettings,
  defaultSettings,
  loadSettings,
  type SettingsWatch,
  saveSettings,
  settingsPath,
  watchSettings,
} from "../src/settings/index.js";
import { checkSetting } from "../src/settings/schema.js";
import {
  createFileDisplay,
  displaySettings,
  renameRow,
  resetKeys,
  setIn,
} from "../src/tui/display.js";
import { createServerSettings, PROVIDERS_KEY } from "../src/tui/server-settings.js";
import { limitsLines } from "../src/tui/window/limits.js";
import { DEFAULT_WORDS } from "../src/view/format.js";
import { pickRow, visibleGroups } from "../src/view/select.js";
import { collapsedLines, lineText, statusLayout } from "../src/view/text.js";
import { providerSnapshot, quotaRow } from "./helpers/fake-answers.js";

const EXPECTED = {
  version: 6,
  sidebar: {
    show: true,
    sessionTokens: true,
    runsOut: true,
    hidden: [],
    providerOrder: [],
    rowOrder: {},
    names: {},
  },
  collapsed: {
    show: true,
    runsOut: false,
    hidden: [],
    providerOrder: [],
    rowOrder: {},
    window: {},
  },
  statusLine: {
    show: true,
    withSidebar: false,
    runsOut: false,
    hidden: [],
    providerOrder: [],
    rowOrder: {},
    window: {},
    detail: "auto",
    width: 0,
    autoScrollSeconds: 0,
    home: false,
  },
  toast: {
    show: true,
    runsOut: true,
    hidden: [],
    providerOrder: [],
    rowOrder: {},
    names: {},
    afterReply: "low",
    afterQuestion: false,
    afterCompaction: true,
    whenAllFail: true,
    resetNotice: "off",
    layout: "grouped",
    seconds: 9,
    sessionTokens: true,
  },
  colors: {
    good: undefined,
    warning: undefined,
    low: undefined,
    empty: undefined,
    title: undefined,
    provider: undefined,
    account: undefined,
    label: undefined,
    percent: undefined,
    reset: undefined,
    value: undefined,
    error: undefined,
    statusName: undefined,
    separator: undefined,
    arrows: undefined,
    levelBy: "left",
    warningBelow: 50,
    lowBelow: 20,
  },
  layout: {
    bar: "blocks",
    barWidth: "fill",
    evenUse: true,
    indent: 1,
    labelWidth: 8,
    providerGap: 1,
    separator: " · ",
  },
  words: {
    percent: "left",
    reset: "smart",
    resetDecimals: 1,
    rowNames: "short",
    detail: "summary",
    onlyCurrentModel: false,
    sessionTokens: "current",
  },
  providers: {
    off: [],
    custom: [],
    anthropic: { binaryPath: "claude" },
    cursor: { plan: "none", includedApiUsd: null, billingCycleStartDay: null },
    opencode: { monthlyLimitUsd: null },
    checking: { minIntervalMs: 300000, requestTimeoutMs: 5000, waitForQuotaReset: true },
    pricing: { source: "auto", autoRefreshDays: 7 },
  },
  system: {
    exportFile: false,
    exportPath: "",
    telemetry: false,
    oldCommands: true,
  },
};

// The independent default object fixes the complete key set, including empty maps and colors.
describe("one file section per Settings tab", () => {
  it("has exactly the requested sections and defaults", () => {
    expect(defaultSettings()).toEqual(EXPECTED);
    expect(Object.keys(defaultSettings())).toEqual(Object.keys(EXPECTED));
    // The words the view uses until the server sends its own.
    expect(DEFAULT_WORDS).toEqual(EXPECTED.words);
  });
  it.each([
    "checking.minIntervalMs",
    "pricing.source",
    "announcements.enabled",
    "export.enabled",
    "telemetry.enabled",
    "providers.enabled",
    "words.runsOut",
    "quickLook",
    "surfaces.sidebar.enabled",
    "labels",
    "window",
    "thresholds.warningBelow",
  ])("rejects the removed key %s", (key) => {
    expect(checkSetting(key, true)).toEqual({ issues: [{ key, message: "unknown setting" }] });
  });
});

function quotaSnapshot(
  providers: QuotaSnapshot["providers"],
  extra: Partial<QuotaSnapshot> = {},
): QuotaSnapshot {
  return {
    version: 6,
    providers,
    resetNotices: [],
    generatedAtMs: NOW,
    serverId: "settings-test",
    revision: 1,
    ...extra,
  };
}

const NOW = Date.parse("2026-10-10T12:00:00Z");
const rows: [QuotaRow, QuotaRow] = [
  quotaRow("anthropic.five_hour", { label: "5h", window: "five_hour", percentRemaining: 70 }),
  quotaRow("anthropic.weekly", { label: "Weekly", window: "week", percentRemaining: 20 }),
];
const snapshot = quotaSnapshot([providerSnapshot("anthropic", "Claude", rows)], {
  generatedAtMs: NOW,
});

it("uses Sidebar names on Sidebar, Collapsed, Status line and Limits, and Toast names on toasts", () => {
  let display = renameRow(displaySettings(defaultSettings()), "sidebar", rows[0].id, "Session");
  display = renameRow(display, "toast", rows[0].id, "Reply quota");
  for (const surface of ["sidebar", "collapsed", "statusLine"] as const)
    expect(visibleGroups(snapshot, display, surface, DEFAULT_WORDS)[0]?.rows[0]?.label).toBe(
      "Session",
    );
  expect(
    limitsLines({ snapshot, display, nowMs: NOW, width: 100 }).map(lineText).join("\n"),
  ).toContain("Session");
  expect(visibleGroups(snapshot, display, "toast", DEFAULT_WORDS)[0]?.rows[0]?.label).toBe(
    "Reply quota",
  );
});

it("picks separate windows in the collapsed sidebar and the status line", () => {
  const settings = defaultSettings();
  settings.collapsed.window.anthropic = "five_hour";
  settings.statusLine.window.anthropic = "week";
  const display = displaySettings(settings);
  const groups = visibleGroups(snapshot, display, "collapsed", DEFAULT_WORDS);
  expect(groups.map((group) => pickRow(group, display.collapsed.window.anthropic)?.row.id)).toEqual(
    [rows[0].id],
  );
  expect(
    groups.map((group) => pickRow(group, display.statusLine.window.anthropic)?.row.id),
  ).toEqual([rows[1].id]);
  const input = { groups, layout: display.layout, words: DEFAULT_WORDS, nowMs: NOW };
  expect(
    collapsedLines({ ...input, width: 100, window: display.collapsed.window })
      .map(lineText)
      .join("\n"),
  ).toContain("70%");
  expect(
    statusLayout({ ...input, window: display.statusLine.window }, 100, 0, "numbers")
      .shown.map(lineText)
      .join("\n"),
  ).toContain("20%");
});

it("CLI quota text shows pace without a words switch", () => {
  const row = quotaRow("anthropic.five_hour", {
    label: "5h",
    window: "five_hour",
    percentRemaining: 50,
    windowStartedAt: new Date(NOW - 60 * 60000).toISOString(),
    resetsAt: new Date(NOW + 3 * 60 * 60000).toISOString(),
  });
  expect(
    quotaReportLines(
      quotaSnapshot([providerSnapshot("anthropic", "Claude", [row])], {
        words: defaultSettings().words,
      }),
      NOW,
    ).join("\n"),
  ).toContain("runs out in 1h");
});

let root: string;
const watches: SettingsWatch[] = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "quota-tab-settings-"));
  vi.stubEnv("OPENCODE_CONFIG_DIR", join(root, "config"));
  vi.stubEnv("XDG_STATE_HOME", join(root, "state"));
});
afterEach(async () => {
  for (const watch of watches.splice(0)) watch.close();
  await rm(root, { recursive: true, force: true });
});

async function file(text: string) {
  await mkdir(dirname(settingsPath()), { recursive: true });
  await writeFile(settingsPath(), text);
}
async function connect() {
  const server = createServerSettings({
    settings: async () => clientSettings(await loadSettings()),
    saveSettings: async (input) =>
      saveSettings(input.patch, { customEnabled: input.customEnabled }),
  });
  await server.load();
  watches.push(
    await watchSettings((loaded) => server.receive(clientSettings(loaded)), {
      debounceMs: 20,
    }),
  );
  return { server, display: createFileDisplay(server) };
}

it("a hand edit reaches two TUI settings clients and leaves a draft on top", async () => {
  await file('{ "version": 6 }');
  const first = await connect();
  const second = await connect();
  first.display.edit((settings) => setIn(settings, ["layout", "barWidth"], 12));
  await file(
    JSON.stringify({
      sidebar: { show: false, names: { "anthropic.five_hour": "Session" } },
      collapsed: { window: { anthropic: "week" } },
      statusLine: { home: true },
      toast: { names: { "anthropic.five_hour": "Reply" } },
      colors: { good: "blue" },
      layout: { barWidth: 6 },
      words: { percent: "used" },
      providers: { off: ["copilot"] },
    }),
  );
  // The folder watch can miss a change; the stat poll that catches it runs every 2 s.
  await vi.waitFor(() => expect(second.display.shown().sidebar.show).toBe(false), {
    timeout: 5_000,
  });
  await vi.waitFor(() => expect(first.display.shown().statusLine.home).toBe(true), {
    timeout: 5_000,
  });
  expect(first.display.shown()).toMatchObject({
    sidebar: { names: { "anthropic.five_hour": "Session" } },
    collapsed: { window: { anthropic: "week" } },
    toast: { names: { "anthropic.five_hour": "Reply" } },
    colors: { good: "blue" },
    layout: { barWidth: 12 },
    words: { percent: "used" },
    providers: { off: ["copilot"] },
  });
  first.server.discard();
  expect(first.display.shown().layout.barWidth).toBe(6);
});

it("Save writes file settings with comments kept and reaches another TUI", async () => {
  await file(
    '// my settings\n{ "sidebar": { "names": { /* keep this name */ "anthropic.weekly": "Week" } }, "layout": { /* keep this width */ "barWidth": 8 } }',
  );
  const first = await connect();
  const second = await connect();
  first.display.edit((settings) =>
    renameRow(settings, "sidebar", "anthropic.five_hour", "Session"),
  );
  second.display.edit((settings) =>
    renameRow(settings, "sidebar", "anthropic.weekly", "Long window"),
  );
  await second.server.save();
  // The folder watch can miss a change; the stat poll that catches it runs every 2 s.
  await vi.waitFor(
    () => expect(first.display.shown().sidebar.names["anthropic.weekly"]).toBe("Long window"),
    { timeout: 5_000 },
  );
  first.display.edit((settings) => setIn(settings, ["layout", "barWidth"], 12));
  await first.server.save();
  await vi.waitFor(() => expect(second.display.shown().layout.barWidth).toBe(12), {
    timeout: 5_000,
  });
  expect((await loadSettings()).settings.sidebar.names).toEqual({
    "anthropic.weekly": "Long window",
    "anthropic.five_hour": "Session",
  });
  const text = await readFile(settingsPath(), "utf8");
  for (const comment of ["// my settings", "/* keep this name */", "/* keep this width */"])
    expect(text).toContain(comment);
  expect(first.server.dirty()).toBe(false);
});

it("Save writes the window for all providers next to a provider's own", async () => {
  await file('{ "collapsed": { "window": { "openai": "week" } } }');
  const { server, display } = await connect();
  display.edit((settings) => setIn(settings, ["collapsed", "window", "*"], "five_hour"));
  await server.save();
  expect((await loadSettings()).settings.collapsed.window).toEqual({
    openai: "week",
    "*": "five_hour",
  });
  display.edit((settings) => setIn(settings, ["collapsed", "window", "*"], undefined));
  await server.save();
  expect((await loadSettings()).settings.collapsed.window).toEqual({ openai: "week" });
});

it("Reset page removes the page's keys from the file, so they follow their defaults again", async () => {
  await file(
    '{ "version": 6, "collapsed": { "show": true, "runsOut": true }, "sidebar": { "runsOut": false } }',
  );
  const { server, display } = await connect();
  display.edit((settings) => setIn(settings, ["collapsed", "providerOrder"], ["openai"]));

  for (const key of resetKeys("collapsed")) server.reset(key);

  expect(display.shown().collapsed.runsOut).toBe(false);
  expect(display.shown().collapsed.providerOrder).toEqual([]);
  // collapsed.show already holds its default, but the file still sets it.
  expect(server.dirty()).toBe(true);
  await server.save();
  const loaded = await loadSettings();
  expect(loaded.fromFile.sort()).toEqual(["sidebar.runsOut", "version"]);
  expect(loaded.settings.collapsed).toEqual(defaultSettings().collapsed);
  expect(server.dirty()).toBe(false);
});

it("Reset page removes a record the file sets, and a later entry starts from the default", async () => {
  await file('{ "version": 6, "collapsed": { "window": { "anthropic": "weekly" } } }');
  const { server, display } = await connect();

  for (const key of resetKeys("collapsed")) server.reset(key);
  expect(display.shown().collapsed.window).toEqual({});
  display.edit((settings) => setIn(settings, ["collapsed", "window", "openai"], "five_hour"));
  await server.save();

  const loaded = await loadSettings();
  expect(loaded.settings.collapsed.window).toEqual({ openai: "five_hour" });
  expect(server.dirty()).toBe(false);
});

it("Reset tab on Providers removes the switched-off providers and the request timeout", async () => {
  await file(
    '{ "version": 6, "providers": { "off": ["copilot"], "checking": { "requestTimeoutMs": 5000 } } }',
  );
  const { server } = await connect();

  for (const key of resetKeys("providers")) server.reset(key);
  server.reset(PROVIDERS_KEY);
  await server.save();

  expect((await loadSettings()).fromFile).toEqual(["version"]);
  expect(server.dirty()).toBe(false);
});

it("Reset page removes a value the file sets wrong, with its problem", async () => {
  await file('{ "version": 6, "collapsed": { "show": "yes" } }');
  const { server } = await connect();
  expect((await loadSettings()).issues.map((issue) => issue.key)).toEqual(["collapsed.show"]);

  for (const key of resetKeys("collapsed")) server.reset(key);
  await server.save();

  const loaded = await loadSettings();
  expect([loaded.issues, loaded.fromFile]).toEqual([[], ["version"]]);
});

it("Reset page changes nothing for keys the file does not set", async () => {
  await file('{ "version": 6, "sidebar": { "runsOut": false } }');
  const { server, display } = await connect();
  display.edit((settings) => setIn(settings, ["collapsed", "runsOut"], true));

  for (const key of resetKeys("collapsed")) server.reset(key);

  expect(server.dirty()).toBe(false);
});

it("resets names and colors without writing undefined or losing literal dotted ids", async () => {
  await file(
    '{ "sidebar": { "names": { "anthropic.five_hour": "Session" } }, "colors": { "good": "blue" } }',
  );
  const { server, display } = await connect();
  display.edit((settings) => renameRow(settings, "sidebar", "anthropic.five_hour", ""));
  display.edit((settings) => setIn(settings, ["colors", "good"], undefined));
  await server.save();
  expect((await loadSettings()).settings.sidebar.names).toEqual({});
  expect((await loadSettings()).settings.colors.good).toBeUndefined();
  expect(await readFile(settingsPath(), "utf8")).not.toContain("undefined");
});

it.each([
  { checking: { minIntervalMs: 1 } },
  { announcements: { enabled: true } },
  { providers: { enabled: [] } },
  { words: { runsOut: true } },
])("Save refuses removed settings: %j", async (patch) => {
  await file('// keep me\n{ "version": 6 }');
  const before = await readFile(settingsPath(), "utf8");
  const result = await saveSettings(patch);
  expect(result.ok).toBe(false);
  expect(result.issues.some((issue) => issue.message.startsWith("unknown setting"))).toBe(true);
  expect(await readFile(settingsPath(), "utf8")).toBe(before);
});

it.each([
  {
    input: { layout: { barWidth: 99, bar: "dots" } },
    expected: { layout: { barWidth: "fill", bar: "dots" } },
  },
  { input: { layout: { barWidth: "wide" } }, expected: { layout: { barWidth: "fill" } } },
  { input: { layout: { bar: "zigzag" } }, expected: { layout: { bar: "blocks" } } },
  {
    input: { colors: { good: "#00ff00", low: "pink", reset: "accent" } },
    expected: { colors: { good: "#00ff00", low: undefined, reset: "accent" } },
  },
  {
    input: { sidebar: { hidden: "claude", rowOrder: { claude: ["a"], x: 3 } } },
    expected: { sidebar: { hidden: [], rowOrder: { claude: ["a"] } } },
  },
  {
    input: { collapsed: { window: { anthropic: "week", openai: "fortnight" } } },
    expected: { collapsed: { window: { anthropic: "week" } } },
  },
  {
    input: { statusLine: { window: { "*": "five_hour", openai: "lowest", copilot: 5 } } },
    expected: { statusLine: { window: { "*": "five_hour", openai: "lowest" } } },
  },
  {
    input: { collapsed: { window: { "*": "fortnight" } } },
    expected: { collapsed: { window: {} } },
  },
  {
    input: { toast: { afterReply: "sometimes", seconds: 0, afterQuestion: true } },
    expected: { toast: { afterReply: "low", seconds: 9, afterQuestion: true, layout: "grouped" } },
  },
  {
    input: { toast: { layout: "classic", seconds: 5 } },
    expected: { toast: { layout: "grouped", seconds: 5 } },
  },
])("keeps valid entries and defaults invalid moved values: $input", async ({ input, expected }) => {
  await file(JSON.stringify(input));
  const loaded = await loadSettings();
  expect(loaded.settings).toMatchObject(expected);
  expect(loaded.issues.length).toBeGreaterThan(0);
});

it("keeps the renderer's warning level at or above its low level", () => {
  const settings = defaultSettings();
  settings.colors.warningBelow = 10;
  settings.colors.lowBelow = 30;
  expect(displaySettings(settings).thresholds).toEqual({ warningBelow: 30, lowBelow: 30 });
});

it("a hand edit keeps the saved warning level at or above the low level", async () => {
  await file('{ "colors": { "warningBelow": 10, "lowBelow": 30 } }');
  const { server, display } = await connect();
  expect(server.value("colors.warningBelow")).toBe(30);
  expect(display.shown().thresholds).toEqual({ warningBelow: 30, lowBelow: 30 });
});
