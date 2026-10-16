import { describe, expect, it } from "vite-plus/test";
import type {
  ProviderSnapshot,
  QuotaRow,
  QuotaSnapshot,
  SessionModelInput,
  Words,
} from "../src/core/types.js";
import { ALL_PROVIDERS } from "../src/core/windows.js";
import { defaultDisplaySettings } from "../src/tui/display.js";
import { columnsOf } from "../src/view/columns.js";
import {
  amountText,
  barParts,
  DEFAULT_WORDS,
  fit as fitToWidth,
  formatDuration,
  levelOf,
  paceLevel,
  rowValueText,
} from "../src/view/format.js";
import {
  pickRow,
  type RowSettings,
  type Surface,
  visibleGroups,
  type WindowChoice,
} from "../src/view/select.js";
import {
  barSegments,
  bigStatusLine,
  collapsedLines,
  collapsedTitle,
  lineText,
  plainLines,
  type StatusInput,
  sidebarLines,
  sidebarTitle,
  statusLayout,
  type ToastInput,
  type ToastLayout,
  toastLines,
} from "../src/view/text.js";
import { providerSnapshot, quotaRow as row } from "./helpers/fake-answers.js";

const NOW = Date.parse("2026-10-10T12:00:00.000Z");
const MINUTE = 60_000;
const at = (ms: number) => new Date(NOW + ms).toISOString();

/** A provider whose rows were fetched and checked at NOW. */
const provider = (
  providerId: string,
  label: string,
  rows: QuotaRow[],
  extra: Partial<ProviderSnapshot> = {},
) => providerSnapshot(providerId, label, rows, { okAtMs: NOW, checkedAtMs: NOW, ...extra });

const CLAUDE = provider("anthropic", "Claude", [
  row("anthropic.five_hour", {
    label: "5h",
    window: "five_hour",
    percentRemaining: 58,
    resetsAt: at(134 * MINUTE),
  }),
  row("anthropic.weekly", {
    label: "Weekly",
    window: "week",
    percentRemaining: 12,
    resetsAt: at((3 * 24 * 60 + 4 * 60) * MINUTE),
  }),
  row("anthropic.weekly_fable", {
    label: "Fable",
    window: "week",
    percentRemaining: 90,
    prominence: "supplementary",
  }),
]);
const ZEN = provider("opencode", "OpenCode Zen", [
  row("opencode.balance", {
    label: "Balance",
    type: "balance",
    amount: { decimal: "1240.5", unit: { kind: "currency", code: "USD" } },
  }),
]);
const ROUTER = provider("openrouter", "OpenRouter", [], { error: { code: "login_expired" } });
/** Two accounts whose last check timed out, so both keep their rows from before. */
const TWO_ACCOUNTS = provider(
  "copilot",
  "Copilot",
  [
    row("copilot.allowance", {
      account: "work",
      label: "Plan",
      window: "month",
      percentRemaining: 40,
    }),
    row("copilot.allowance", {
      account: "home",
      label: "Plan",
      window: "month",
      percentRemaining: 90,
    }),
  ],
  { error: { code: "timeout" } },
);

function snapshot(providers: ProviderSnapshot[], extra: Partial<QuotaSnapshot> = {}) {
  return { version: 6, providers, resetNotices: [], generatedAtMs: NOW, ...extra } as const;
}

function settings(change: (settings: RowSettings) => void = () => {}): RowSettings {
  const display = defaultDisplaySettings();
  change(display);
  return display;
}

const words = (change: Partial<Words> = {}): Words => ({ ...DEFAULT_WORDS, ...change });

describe("view format", () => {
  it.each([
    { ms: 134 * MINUTE, style: "exact", expected: "2h 14m" },
    { ms: 134 * MINUTE, style: "compact", expected: "2h14m" },
    { ms: 134 * MINUTE, style: "short", expected: "2h" },
    { ms: 134 * MINUTE, style: "decimal", expected: "2.2h" },
    { ms: (2 * 1440 + 5) * MINUTE, style: "exact", expected: "2d 5m" },
    { ms: (2 * 1440 + 65) * MINUTE, style: "short", expected: "2d 1h" },
    { ms: 3 * 1440 * MINUTE, style: "decimal", expected: "3.0d" },
    { ms: 30_000, style: "exact", expected: "1m" },
    { ms: 0, style: "exact", expected: "now" },
    { ms: -MINUTE, style: "compact", expected: "now" },
    // Smart: days with one decimal, then whole hours from 12 hours, each to the nearest.
    { ms: (17 * 1440 + 4 * 60 + 6) * MINUTE, style: "smart", expected: "17.2d" },
    { ms: (4 * 1440 + 11 * 60 + 58) * MINUTE, style: "smart", expected: "4.5d" },
    { ms: (3 * 1440 + 23 * 60 + 58) * MINUTE, style: "smart", expected: "4.0d" },
    { ms: (1440 + 2 * 60) * MINUTE, style: "smart", expected: "1.1d" },
    { ms: (23 * 60 + 58) * MINUTE, style: "smart", expected: "1.0d" },
    { ms: (23 * 60 + 10) * MINUTE, style: "smart", expected: "23h" },
    { ms: (12 * 60 + 40) * MINUTE, style: "smart", expected: "13h" },
    { ms: 12 * 60 * MINUTE, style: "smart", expected: "12h" },
    { ms: (11 * 60 + 59) * MINUTE, style: "smart", expected: "11h 59m" },
    { ms: 2 * 60 * MINUTE, style: "smart", expected: "2h" },
    { ms: 25 * MINUTE, style: "smart", expected: "25m" },
    { ms: 0, style: "smart", expected: "now" },
  ] as const)("$ms ms in the $style style is $expected", ({ ms, style, expected }) => {
    expect(formatDuration(ms, style, 1)).toBe(expected);
  });

  it.each([
    { shape: "blocks", percent: 50, width: 8, expected: ["████", "░░░░"] },
    { shape: "dots", percent: 81, width: 5, expected: ["●●●●", "○"] },
    { shape: "line", percent: -5, width: 4, expected: ["", "────"] },
    { shape: "none", percent: 50, width: 8, expected: ["", ""] },
  ] as const)("a $shape bar at $percent%", ({ shape, percent, width, expected }) => {
    expect(barParts(shape, percent, width)).toEqual(expected);
  });

  it.each([
    { percent: 50, expected: "good" },
    { percent: 49, expected: "warning" },
    { percent: 19.6, expected: "warning" },
    { percent: 19, expected: "low" },
    { percent: -3, expected: "low" },
  ] as const)("$percent% left is $expected", ({ percent, expected }) => {
    expect(levelOf(percent, { warningBelow: 50, lowBelow: 20 })).toBe(expected);
  });

  it.each([
    { kind: "spare", evenLeft: 50, left: 80, expected: "good" },
    { kind: "on_track", evenLeft: 50, left: 54, expected: "good" },
    { kind: "on_track", evenLeft: 50, left: 50, expected: "good" },
    { kind: "on_track", evenLeft: 50, left: 46, expected: "warning" },
    // Untouched at the window's start, when even use still leaves about 100%.
    { kind: "on_track", evenLeft: 98, left: 100, expected: "good" },
    { kind: "fast", evenLeft: 50, left: 30, expected: "low" },
    // Under a tenth of the window passed: no level, so the share left decides.
    { kind: "fast", evenLeft: 95, left: 50, expected: undefined },
    { kind: "fast", evenLeft: 95, left: 0, expected: undefined },
    { kind: "fast", evenLeft: 90, left: 50, expected: "low" },
  ] as const)("$kind with $left% left and $evenLeft% of the window to come is $expected", ({
    kind,
    evenLeft,
    left,
    expected,
  }) => {
    expect(paceLevel({ evenLeft, kind }, left)).toBe(expected);
  });

  it.each([
    {
      name: "dollars",
      value: row("x.a", {
        amount: { decimal: "1240.5", unit: { kind: "currency", code: "USD" } },
        type: "balance",
      }),
      expected: "$1,240.50 left",
    },
    {
      name: "euros used",
      value: row("x.a", {
        amount: { decimal: "-3", unit: { kind: "currency", code: "EUR" } },
        type: "usage",
      }),
      expected: "-3.00 EUR used",
    },
    {
      name: "a count",
      value: row("x.a", {
        remaining: { decimal: "1200", unit: { kind: "count", unit: "request" } },
      }),
      expected: "1,200 requests left",
    },
    {
      name: "used of a limit",
      value: row("x.a", {
        used: { decimal: "26", unit: { kind: "count", unit: "unit" } },
        limit: { decimal: "100", unit: { kind: "count", unit: "unit" } },
      }),
      expected: "26/100",
    },
    {
      name: "a custom unit",
      value: row("x.a", { amount: { decimal: "30.25", unit: { kind: "custom", symbol: "nano" } } }),
      expected: "30.25 nano",
    },
    { name: "a flag", value: row("x.a", { type: "status", flag: false }), expected: "Disabled" },
    { name: "a text", value: row("x.a", { text: "Unlimited" }), expected: "Unlimited" },
  ])("the value of $name", ({ value, expected }) => {
    expect(rowValueText(value)).toBe(expected);
  });

  it.each([
    { text: "Claude", width: 9, expected: "Claude   " },
    { text: "OpenRouter", width: 9, expected: "OpenRout…" },
    { text: "Copilot (pro)", width: 9, expected: "Copilot… " },
    // Wide characters take two columns; a letter with its accent is never split.
    { text: "日本語プロバイダ", width: 9, expected: "日本語プ…" },
    { text: "日本語", width: 7, expected: "日本語 " },
    { text: "e\u0301e\u0301e\u0301e\u0301", width: 3, expected: "e\u0301e\u0301…" },
  ])("fits $text in $width columns", ({ text, width, expected }) => {
    expect(fitToWidth(text, width)).toBe(expected);
  });

  it("shows exact amounts without float noise", () => {
    expect(amountText({ decimal: "0.1", unit: { kind: "count", unit: "unit" } })).toBe("0.1");
  });

  it.each([
    { decimal: "0", expected: "0 tokens used" },
    { decimal: "1", expected: "1 token used" },
    { decimal: "1.5", expected: "1.5 tokens used" },
    { decimal: "12345", expected: "12,345 tokens used" },
    { decimal: "-1", expected: "-1 token used" },
  ])("names a count of $decimal in the plural unless it is one", ({ decimal, expected }) => {
    const used = row("x.a", {
      type: "usage",
      amount: { decimal, unit: { kind: "count", unit: "token" } },
    });
    expect(rowValueText(used)).toBe(expected);
  });
});

describe("view select", () => {
  const all = snapshot([CLAUDE, ZEN, ROUTER]);
  const ids = (groups: ReturnType<typeof visibleGroups>) =>
    groups.map((group) => [group.title, group.rows.map((item) => item.label)]);

  it.each([
    {
      name: "the snapshot's order, primary rows only",
      settings: settings(),
      words: words(),
      expected: [
        ["Claude", ["5h", "Weekly"]],
        ["OpenCode Zen", ["Balance"]],
        ["OpenRouter", []],
      ],
    },
    {
      name: "supplementary rows in the detailed words",
      settings: settings(),
      words: words({ detail: "detailed" }),
      expected: [
        ["Claude", ["5h", "Weekly", "Fable"]],
        ["OpenCode Zen", ["Balance"]],
        ["OpenRouter", []],
      ],
    },
    {
      name: "your order, names and hidden ids",
      settings: settings((value) => {
        value.surfaces.sidebar.providerOrder = ["openrouter"];
        value.surfaces.sidebar.rowOrder = { anthropic: ["anthropic.weekly"] };
        value.surfaces.sidebar.hidden = ["opencode", "anthropic.five_hour"];
        value.surfaces.sidebar.names = { "anthropic.weekly": "Week" };
      }),
      words: words(),
      expected: [
        ["OpenRouter", []],
        ["Claude", ["Week"]],
      ],
    },
    {
      name: "a provider whose every row is hidden, unless it has an error",
      settings: settings((value) => {
        value.surfaces.sidebar.hidden = [
          "opencode.balance",
          "anthropic.five_hour",
          "anthropic.weekly",
        ];
      }),
      words: words(),
      expected: [["OpenRouter", []]],
    },
  ])("$name", ({ settings: rowSettings, words: rowWords, expected }) => {
    expect(ids(visibleGroups(all, rowSettings, "sidebar", rowWords))).toEqual(expected);
  });

  it("shows only the providers of the current model when the words say so", () => {
    const current = snapshot([CLAUDE, ZEN], { currentModelProviderIds: ["opencode"] });
    expect(
      ids(visibleGroups(current, settings(), "toast", words({ onlyCurrentModel: true }))),
    ).toEqual([["OpenCode Zen", ["Balance"]]]);
  });

  it("makes one group per account, in the order the accounts appear", () => {
    const copilot = provider("copilot", "Copilot", [
      row("copilot.allowance", { account: "work", label: "Plan", percentRemaining: 40 }),
      row("copilot.allowance", { account: "home", label: "Plan", percentRemaining: 90 }),
    ]);
    const groups = visibleGroups(snapshot([copilot]), settings(), "sidebar", words());
    expect(groups.map((group) => [group.id, group.title])).toEqual([
      ["copilot (work)", "Copilot (work)"],
      ["copilot (home)", "Copilot (home)"],
    ]);
  });

  it("shows the error of a provider with several accounts once, on its first account", () => {
    const groups = visibleGroups(snapshot([TWO_ACCOUNTS]), settings(), "sidebar", words());
    expect(groups.map((group) => [group.title, group.rows.length, group.error?.code])).toEqual([
      ["Copilot (work)", 1, "timeout"],
      ["Copilot (home)", 1, undefined],
    ]);
    expect(collapsedTitle(groups)).toBe("▶ Quota (1 provider, 1 error)");
  });

  it.each([
    { choice: undefined, expected: "Weekly" },
    { choice: "five_hour", expected: "5h" },
    { choice: "month", expected: "Weekly" },
  ] as const)("picks $expected for the $choice window", ({ choice, expected }) => {
    const [claude] = visibleGroups(all, settings(), "collapsed", words());
    expect(pickRow(claude!, choice)?.label).toBe(expected);
  });
});

describe("view text", () => {
  const display = defaultDisplaySettings();
  const groups = (
    surface: "sidebar" | "collapsed" | "statusLine" | "toast",
    providers = [CLAUDE, ZEN, ROUTER],
  ) => visibleGroups(snapshot(providers), display, surface, DEFAULT_WORDS);
  /** What every drawing takes besides its groups. */
  const drawn = { layout: display.layout, words: DEFAULT_WORDS, nowMs: NOW };
  const statusInput = (providers = [CLAUDE, ZEN, ROUTER]): StatusInput => ({
    groups: groups("statusLine", providers),
    ...drawn,
    window: {},
  });

  it("draws the expanded sidebar with bars, percents, reset times and session tokens", () => {
    const lines = sidebarLines({
      groups: groups("sidebar"),
      ...drawn,
      width: 40,
      sessionTokens: { input: 12_300, cachedInput: 0, output: 2_100 },
    });
    // One empty line between providers, and before the session tokens, by default.
    expect(lines.map(lineText)).toEqual([
      "Claude",
      " 5h ████████████░░░░░░░░  58% 2h 14m",
      " 7d ██░░░░░░░░░░░░░░░░░░  12%   3.2d",
      "",
      "OpenCode Zen",
      " Balance  $1,240.50 left",
      "",
      "OpenRouter  Sign in again",
      "",
      "Session  12.3K in · 2.10K out",
    ]);
    // The bar of the row with 12% left is drawn in the "low" level color.
    const weekly = lines.find((line) => line.id === "anthropic.weekly");
    expect(weekly?.segments.find((segment) => segment.role === "bar")).toMatchObject({
      percent: 12,
    });
  });

  describe("low cache line under Session", () => {
    const K = 1_000;
    /** A model's input tokens: new input, cache reads, cache writes. */
    const model = (modelID: string, input: number, cacheRead: number, cacheWrite = 0) => ({
      modelID,
      input,
      cacheRead,
      cacheWrite,
    });
    const SONNET = model("claude-sonnet-5", 2_600 * K, 1_400 * K);
    const linesAfterSession = (models: SessionModelInput[], width = 40) => {
      const lines = sidebarLines({
        groups: groups("sidebar", [CLAUDE]),
        ...drawn,
        width,
        sessionTokens: { input: 1_420 * K, cachedInput: 0, output: 38 * K, models },
      });
      return lines.slice(lines.findIndex((line) => lineText(line).startsWith("Session")));
    };

    it.each([
      {
        name: "a model with 200K input tokens or more and under half of them cached",
        models: [SONNET],
        warning: "⚠ low cache: 35% (claude-sonnet-5)",
      },
      {
        name: "exactly 200K input tokens, a quarter cached (cache writes count as input)",
        models: [model("glm-5.3", 100 * K, 50 * K, 50 * K)],
        warning: "⚠ low cache: 25% (glm-5.3)",
      },
      {
        name: "the worst of several low models",
        models: [model("gpt-5.6-sol", 150 * K, 1_350 * K), SONNET, model("o5", 800 * K, 200 * K)],
        warning: "⚠ low cache: 20% (o5)",
      },
      { name: "under 200K input tokens", models: [model("haiku", 150 * K, 49 * K)] },
      { name: "half the input cached", models: [model("haiku", 300 * K, 300 * K)] },
      { name: "no cache numbers", models: [model("glm-5.3", 4_000 * K, 0)] },
      { name: "no models", models: [] },
    ])("$name", ({ models, warning }) => {
      const lines = linesAfterSession(models);
      expect(lines.map(lineText)).toEqual([
        "Session  1.42M in · 38.0K out",
        ...(warning ? [warning] : []),
      ]);
      if (warning) expect(lines[1]?.segments.map((segment) => segment.role)).toEqual(["warning"]);
    });

    it.each([
      { width: 40, text: "⚠ low cache: 35% (claude-sonnet-5)" },
      { width: 30, text: "⚠ low cache: 35% (claude-son…)" },
      { width: 21, text: "⚠ low cache: 35% (c…)" },
      { width: 20, text: "⚠ low cache: 35%" },
      { width: 12, text: "⚠ low cache…" },
    ])("cuts the model's name to fit $width columns", ({ width, text }) => {
      const warning = linesAfterSession([SONNET], width)[1];
      expect(lineText(warning!)).toBe(text);
      expect(columnsOf(lineText(warning!))).toBeLessThanOrEqual(width);
    });

    it("cuts a wide-character name without a space before the closing parenthesis", () => {
      const warning = linesAfterSession([model("模型名字", 2_600 * K, 1_400 * K)], 25)[1];
      expect(lineText(warning!)).toBe("⚠ low cache: 35% (模型…)");
    });
  });

  it("fills the sidebar's room with the bar, at most 20 cells, then drops it when narrow", () => {
    const line = (width: number, layout = display.layout) =>
      lineText(sidebarLines({ groups: groups("sidebar", [CLAUDE]), ...drawn, layout, width })[1]!);
    expect([line(40), line(20), line(16), line(40, { ...display.layout, barWidth: 8 })]).toEqual([
      " 5h ████████████░░░░░░░░  58% 2h 14m",
      " 5h ██░░  58% 2h 14m",
      " 5h   58% 2h 14m",
      // A number fixes the bar.
      " 5h █████░░░  58% 2h 14m",
    ]);
  });

  it.each([
    { percent: "left", title: "▼ Quota left" },
    { percent: "remaining", title: "▼ Quota remaining" },
    { percent: "used", title: "▼ Quota used" },
    { percent: "bare", title: "▼ Quota" },
  ] as const)(
    "titles the expanded panel $title, so its rows show only the number",
    ({ percent, title }) => {
      expect(sidebarTitle({ ...DEFAULT_WORDS, percent })).toBe(title);
    },
  );

  it.each([
    { providers: [CLAUDE], expected: "▶ Quota (1 provider)" },
    { providers: [CLAUDE, ZEN, ROUTER], expected: "▶ Quota (3 providers, 1 error)" },
  ])("titles the collapsed panel $expected", ({ providers, expected }) => {
    expect(collapsedTitle(groups("collapsed", providers))).toBe(expected);
  });

  it("draws one collapsed line per provider with its preferred window", () => {
    const lines = collapsedLines({
      groups: groups("collapsed"),
      ...drawn,
      width: 40,
      window: { anthropic: "five_hour" },
    });
    expect(lines.map(lineText)).toEqual([
      "Claude    5h   ██████░░░░  58%  2h 14m",
      "OpenCode… $1,240.50 left",
      "OpenRout… Sign in again",
    ]);
  });

  describe("one window for all providers", () => {
    const OPENAI = provider("openai", "OpenAI", [
      row("openai.five_hour", { label: "5h", window: "five_hour", percentRemaining: 65 }),
      row("openai.weekly", { label: "Weekly", window: "week", percentRemaining: 26 }),
    ]);
    const COPILOT = provider("copilot", "Copilot", [
      row("copilot.allowance", { label: "Plan", window: "month", percentRemaining: 70 }),
    ]);
    const providers = [OPENAI, CLAUDE, COPILOT];
    /** Each provider's shown row on the collapsed panel and the status line, for `window`. */
    const shown = (window: Record<string, WindowChoice>) => ({
      collapsed: collapsedLines({
        groups: groups("collapsed", providers),
        ...drawn,
        width: 40,
        window,
      }).map((line) => lineText(line).slice(0, 14).trimEnd()),
      statusLine: statusLayout({ ...statusInput(providers), window }, 200, 0, "numbers").shown.map(
        lineText,
      ),
    });

    it.each([
      {
        name: "without a pick, each provider's lowest",
        window: {},
        rows: ["OpenAI    7d", "Claude    7d", "Copilot   30d"],
        percents: ["OpenAI 26%", "Claude 12%", "Copilot 70%"],
      },
      {
        name: "the window for all providers where a provider has it, else its lowest",
        window: { [ALL_PROVIDERS]: "five_hour" },
        rows: ["OpenAI    5h", "Claude    5h", "Copilot   30d"],
        percents: ["OpenAI 65%", "Claude 58%", "Copilot 70%"],
      },
      {
        name: "a provider's own pick over the one for all providers",
        window: { [ALL_PROVIDERS]: "five_hour", anthropic: "week" },
        rows: ["OpenAI    5h", "Claude    7d", "Copilot   30d"],
        percents: ["OpenAI 65%", "Claude 12%", "Copilot 70%"],
      },
      {
        name: "a provider's own lowest over the one for all providers",
        window: { [ALL_PROVIDERS]: "five_hour", openai: "lowest" },
        rows: ["OpenAI    7d", "Claude    5h", "Copilot   30d"],
        percents: ["OpenAI 26%", "Claude 58%", "Copilot 70%"],
      },
    ] as const)("shows $name", ({ window, rows, percents }) => {
      expect(shown(window)).toEqual({ collapsed: rows, statusLine: percents });
    });

    it("gives the big bar the window for all providers too", () => {
      const input = { ...statusInput([OPENAI]), window: { [ALL_PROVIDERS]: "five_hour" } };
      expect(lineText(bigStatusLine(input)!)).toBe("OpenAI 5h ███████░░░ 65% left");
    });
  });

  describe("even-use mark", () => {
    /** Half of the 5-hour window has passed with 70% left: even use would leave 50%. */
    const PACED = provider("openai", "OpenAI", [
      row("openai.five_hour", {
        label: "5h",
        window: "five_hour",
        percentRemaining: 70,
        resetsAt: at(150 * MINUTE),
      }),
      // Without a reset time the pace is unknown: no mark.
      row("openai.weekly", { label: "Weekly", window: "week", percentRemaining: 40 }),
    ]);
    const on = { ...display.layout, evenUse: true };
    const sidebar = (layout: typeof on) =>
      sidebarLines({ groups: groups("sidebar", [PACED, ZEN]), ...drawn, layout, width: 40 }).map(
        lineText,
      );

    it("is off by default", () => {
      expect(display.layout.evenUse).toBe(false);
      expect(sidebar(display.layout).join("\n")).not.toContain("┃");
    });

    it("takes the place of the cell where even use would be in the sidebar's bars", () => {
      expect(sidebar(on)).toEqual([
        "OpenAI",
        " 5h ██████████┃███░░░░░░  70% 2h 30m",
        // No reset time, so no mark; a balance has no bar.
        " 7d ████████░░░░░░░░░░░░  40%       ",
        "",
        "OpenCode Zen",
        " Balance  $1,240.50 left",
      ]);
      // The bar keeps its width.
      expect(sidebar(on).map(columnsOf)).toEqual(sidebar(display.layout).map(columnsOf));
    });

    it("is in the bars of the collapsed panel, the status line, the big bar and both toasts", () => {
      const status: StatusInput = { ...statusInput([PACED]), layout: on };
      const toastOn = (toastLayout: ToastLayout) =>
        toast(toastLayout, 40, [PACED], { layout: on, runsOut: false });
      expect({
        collapsed: collapsedLines({
          groups: groups("collapsed", [PACED]),
          ...drawn,
          layout: on,
          width: 40,
          window: { openai: "five_hour" },
        }).map(lineText),
        status: lineText(
          statusLayout({ ...status, window: { openai: "five_hour" } }, 200, 0, "full").shown[0]!,
        ),
        big: lineText(bigStatusLine({ ...status, window: { openai: "five_hour" } })!),
        grouped: toastOn("grouped"),
        detailed: toastOn("detailed"),
      }).toEqual({
        collapsed: ["OpenAI    5h   █████┃█░░░  70%  2h 30m"],
        status: "OpenAI ███┃░ 70% 2h 30m",
        big: "OpenAI 5h █████┃█░░░ 70% left · 2h 30m",
        grouped: [
          "OpenAI",
          "  5h █████████┃██░░░░░  70% left  2h 30m",
          "  7d ███████░░░░░░░░░░  40% left",
        ],
        detailed: [
          "OpenAI",
          "5h                                2h 30m",
          "███████████████┃█████░░░░░░░░░  70% left",
          "7d",
          "████████████░░░░░░░░░░░░░░░░░░  40% left",
        ],
      });
    });

    it.each(["blocks", "shades", "line", "squares", "dots"] as const)(
      "draws the mark in a %s bar, which keeps its width",
      (shape) => {
        const [full] = barParts(shape, 100, 1);
        const [, empty] = barParts(shape, 0, 1);
        expect(barSegments(shape, 70, 20, 50)).toEqual([
          { text: full.repeat(10), role: "bar", percent: 70 },
          { text: "┃", role: "label" },
          { text: full.repeat(3), role: "bar", percent: 70 },
          { text: empty.repeat(6), role: "empty", percent: 70 },
        ]);
      },
    );

    it.each([
      { name: "no bar", shape: "none", width: 20, text: "" },
      { name: "a bar under 3 cells", shape: "blocks", width: 2, text: "█░" },
      { name: "the narrowest bar with a mark", shape: "blocks", width: 3, text: "██┃" },
      {
        name: "a mark past the bar's end",
        shape: "blocks",
        width: 10,
        evenLeft: 100,
        text: "███████░░┃",
      },
    ] as const)("draws $name", ({ shape, width, text, ...rest }) => {
      const evenLeft = "evenLeft" in rest ? rest.evenLeft : 50;
      expect(lineText({ id: "bar", segments: barSegments(shape, 70, width, evenLeft) })).toBe(text);
    });
  });

  it("keeps a space before a long reset time on a collapsed line", () => {
    const line = (width: number) =>
      collapsedLines({
        groups: groups("collapsed", [CLAUDE]),
        ...drawn,
        words: words({ reset: "exact" }),
        nowMs: NOW + 7 * MINUTE,
        width,
        window: {},
      }).map(lineText);
    expect([...line(60), ...line(37)]).toEqual([
      "Claude    7d   █░░░░░░░░░  12% 3d 3h 53m",
      // Narrow: the bar gives way, so the whole time still shows.
      "Claude    7d   █░░░░░░  12% 3d 3h 53m",
    ]);
  });

  it("fits a collapsed line with used percents, a space before the percent", () => {
    const lines = collapsedLines({
      groups: groups("collapsed", [CLAUDE, TWO_ACCOUNTS]),
      ...drawn,
      words: words({ percent: "used" }),
      width: 37,
      window: {},
    }).map(lineText);
    expect(lines).toEqual([
      "Claude    7d   ░░░░  88% used    3.2d",
      // An error takes the reset's place, cut to the line.
      "Copilot…  30d  ██░░  60% used  Timed…",
      // A row without a reset time.
      "Copilot…  30d  ████  10% used        ",
    ]);
  });

  it("shows the error next to the rows kept from before, collapsed and on the status line", () => {
    const expired = { ...CLAUDE, error: { code: "login_expired" } } as const;
    const collapsed = collapsedLines({
      groups: groups("collapsed", [expired]),
      ...drawn,
      width: 50,
      window: {},
    });
    expect(collapsed.map(lineText)).toEqual(["Claude    7d   █░░░░░░░░░  12%  Sign in again"]);
    const status = statusInput([expired]);
    expect(
      ["full", "numbers"].map((level) =>
        lineText(statusLayout(status, 200, 0, level as "full").shown[0]!),
      ),
    ).toEqual(["Claude █░░░░ 12% Sign in again", "Claude 12% ⚠"]);
    expect(lineText(bigStatusLine(status)!)).toBe("Claude 7d █░░░░░░░░░ 12% left · Sign in again");
  });

  it("shows the error of a provider with several accounts on the big bar and the status line", () => {
    const input = statusInput([TWO_ACCOUNTS]);
    expect(lineText(bigStatusLine(input)!)).toBe(
      "Copilot (work) 30d ████░░░░░░ 40% left · Timed out",
    );
    expect(statusLayout(input, 30, 0, "auto").shown.map(lineText)).toEqual([
      "Copilot (work) 40% ⚠",
    ]);
    // Cut short, the line keeps the error's mark.
    expect(statusLayout(input, 9, 0, "auto").shown.map(lineText)).toEqual(["C… ⚠"]);
  });

  it("cuts the big bar to the status line's room, keeping the error's mark", () => {
    const expired = statusInput([{ ...CLAUDE, error: { code: "login_expired" } }]);
    expect([40, 30].map((width) => lineText(bigStatusLine(expired, width)!))).toEqual([
      "Claude 7d █░░░░░░░░░ 12% left · Sign in…",
      "Claude 7d █░░░░░░░░░ 12% le… ⚠",
    ]);
    expect(lineText(bigStatusLine(statusInput([ROUTER]), 8)!)).toBe("OpenR… ⚠");
  });

  it("cuts the first provider short when it does not fit, so the arrows stay", () => {
    const layout = statusLayout(statusInput(), 14, 0, "auto");
    expect([layout.shown.map(lineText), layout.hiddenAfter]).toEqual([["Clau… 12%"], 2]);
  });

  it("measures the status line in terminal columns", () => {
    const wide = provider("kimi", "月之暗面", [
      row("kimi.week", { window: "week", percentRemaining: 70 }),
    ]);
    const layout = statusLayout(statusInput([wide, CLAUDE]), 24, 0, "numbers");
    expect([layout.shown.map(lineText), layout.hiddenAfter]).toEqual([["月之暗面 70%"], 1]);
  });

  it.each([
    { room: 200, level: "full", first: "Claude █░░░░ 12% 3.2d", shown: 3 },
    { room: 75, level: "bar", first: "Claude █░░░░ 12%", shown: 3 },
    { room: 70, level: "numbers", first: "Claude 12%", shown: 3 },
    { room: 40, level: "numbers", first: "Claude 12%", shown: 1 },
  ])(
    "fits the status line in $room columns at the $level level",
    ({ room, level, first, shown }) => {
      const layout = statusLayout(statusInput(), room, 0, "auto");
      expect(layout.level).toBe(level);
      expect(layout.shown.map(lineText)[0]).toBe(first);
      // Every provider shows its least-left row; the rest wait behind "+N ›".
      expect([layout.shown.length, layout.hiddenAfter]).toEqual([shown, 3 - shown]);
    },
  );

  it("scrolls the status line, keeping room for the markers", () => {
    const layout = statusLayout(statusInput(), 40, 1, "auto");
    expect([layout.start, layout.shown.map(lineText), layout.hiddenAfter]).toEqual([
      1,
      ["OpenCode Zen $1,240.50 left"],
      1,
    ]);
  });

  it("names a provider's account on the status line only when it shows several", () => {
    const copilot = (account: string, percentRemaining: number) =>
      row("copilot.allowance", { account, label: "Plan", percentRemaining });
    const segments = (rows: QuotaRow[]) =>
      statusLayout(statusInput([provider("copilot", "Copilot", rows)]), 200, 0, "auto").shown.map(
        lineText,
      );
    expect(segments([copilot("work", 40)])).toEqual(["Copilot ██░░░ 40%"]);
    expect(segments([copilot("work", 40), copilot("home", 90)])).toEqual([
      "Copilot (work) ██░░░ 40%",
      "Copilot (home) █████ 90%",
    ]);
  });

  it("draws the one-provider status line with a big bar", () => {
    expect(lineText(bigStatusLine(statusInput())!)).toBe("Claude 7d █░░░░░░░░░ 12% left · 3.2d");
    // Without a percent row it shows the error (or value) instead of a bar.
    expect(lineText(bigStatusLine(statusInput([ROUTER]))!)).toBe("OpenRouter Sign in again");
    expect(bigStatusLine(statusInput([]))).toBeUndefined();
  });

  it("adds runs out in each place only where it is on, for a limit used faster than it refills", () => {
    // The weekly limit has 12% left with 45% of its week still to come; the 5h one has spare.
    const base = { layout: display.layout, words: DEFAULT_WORDS, nowMs: NOW, window: {} };
    const sidebar = (runsOut: boolean) =>
      sidebarLines({ ...base, groups: groups("sidebar", [CLAUDE]), width: 40, runsOut });
    const status = { ...statusInput([CLAUDE]), runsOut: true };
    expect({
      sidebar: sidebar(true).map(lineText),
      off: sidebar(false).length,
      collapsed: collapsedLines({
        ...base,
        groups: groups("collapsed", [CLAUDE]),
        width: 40,
        runsOut: true,
      }).map(lineText),
      status: lineText(statusLayout(status, 200, 0, "full").shown[0]!),
      big: lineText(bigStatusLine(status)!),
      plain: plainLines({ ...base, groups: groups("toast", [CLAUDE]), runsOut: true }),
    }).toEqual({
      sidebar: [
        "Claude",
        " 5h ████████████░░░░░░░░  58% 2h 14m",
        " 7d ██░░░░░░░░░░░░░░░░░░  12%   3.2d",
        "    runs out in 13h",
      ],
      off: 3,
      collapsed: ["Claude    7d   █░░░░░░░░░  12%    3.2d", "          runs out in 13h"],
      status: "Claude █░░░░ 12% 3.2d (runs out in 13h)",
      big: "Claude 7d █░░░░░░░░░ 12% left · 3.2d · runs out in 13h",
      plain: [
        "Claude 5h           58% left      2h 14m",
        "Claude Weekly       12% left      3.2d  runs out in 13h",
      ],
    });
  });

  /** A toast of `providers` `room` columns wide, with runs out in, as plain lines. */
  const toast = (
    toastLayout: ToastLayout,
    room: number,
    providers = [CLAUDE],
    change: Partial<ToastInput> = {},
  ) =>
    toastLines({
      groups: groups("toast", providers),
      words: DEFAULT_WORDS,
      nowMs: NOW,
      layout: display.layout,
      toastLayout,
      room,
      runsOut: true,
      ...change,
    }).map(lineText);
  const tokens = { sessionTokens: { input: 12_300, cachedInput: 0, output: 2_100 } };
  /** A row without a window and a long name. */
  const PREMIUM = provider("copilot", "Copilot", [
    row("copilot.premium", {
      label: "Premium requests",
      percentRemaining: 80,
      resetsAt: at((18 * 24 * 60 + 10 * 60 + 33) * MINUTE),
    }),
  ]);
  const widest = (lines: string[]) => Math.max(...lines.map(columnsOf));

  it("groups a toast's rows under each provider, by their short window names, with wide bars", () => {
    const lines = toast("grouped", 54, [CLAUDE, ZEN, ROUTER, TWO_ACCOUNTS], tokens);
    expect(lines).toEqual([
      "Claude",
      "  5h  ████████████░░░░░░░░  58% left  2h 14m",
      "  7d  ██░░░░░░░░░░░░░░░░░░  12% left  3.2d",
      "      runs out in 13h",
      "OpenCode Zen",
      // A row without a bar: its value 2 columns after a name longer than the name column.
      "  Balance  $1,240.50 left",
      "OpenRouter  Sign in again",
      "Copilot (work)  Timed out",
      "  30d ████████░░░░░░░░░░░░  40% left",
      "Copilot (home)",
      "  30d ██████████████████░░  90% left",
      "Session  12.3K in · 2.10K out",
    ]);
    expect(widest(lines)).toBeLessThanOrEqual(54);
  });

  it("lays a detailed toast out like v5: two lines per row and a bar as wide as the toast", () => {
    const lines = toast("detailed", 54, [CLAUDE, ZEN, ROUTER, TWO_ACCOUNTS], tokens);
    expect(lines).toEqual([
      "Claude",
      `5h${" ".repeat(46)}2h 14m`,
      `${"█".repeat(26)}${"░".repeat(18)}  58% left`,
      `7d${" ".repeat(48)}3.2d`,
      `${"█".repeat(5)}${"░".repeat(39)}  12% left`,
      "runs out in 13h",
      "",
      "OpenCode Zen",
      `Balance${" ".repeat(33)}$1,240.50 left`,
      "",
      "OpenRouter",
      "Sign in again",
      "",
      "Copilot (work)",
      "Timed out",
      "30d",
      `${"█".repeat(18)}${"░".repeat(26)}  40% left`,
      "",
      "Copilot (home)",
      "30d",
      `${"█".repeat(40)}${"░".repeat(4)}  90% left`,
      "",
      `Session${" ".repeat(27)}12.3K in · 2.10K out`,
    ]);
    expect(lines.map(columnsOf).filter((width) => width !== 54 && width > 20)).toEqual([]);
  });

  it("fits both toast layouts in a narrow toast, cutting long names with …", () => {
    const narrow = {
      grouped: toast("grouped", 38, [PREMIUM, CLAUDE]),
      detailed: toast("detailed", 38, [PREMIUM, CLAUDE]),
    };
    expect(narrow).toEqual({
      grouped: [
        "Copilot",
        "  Premium…  ██████░░  80% left  18.4d",
        "Claude",
        "  5h        █████░░░  58% left  2h 14m",
        "  7d        █░░░░░░░  12% left  3.2d",
        "            runs out in 13h",
      ],
      detailed: [
        "Copilot",
        `Premium requests${" ".repeat(17)}18.4d`,
        `${"█".repeat(22)}${"░".repeat(6)}  80% left`,
        "",
        "Claude",
        `5h${" ".repeat(30)}2h 14m`,
        `${"█".repeat(16)}${"░".repeat(12)}  58% left`,
        `7d${" ".repeat(32)}3.2d`,
        `${"█".repeat(3)}${"░".repeat(25)}  12% left`,
        "runs out in 13h",
      ],
    });
    for (const room of [38, 30, 22]) {
      for (const layout of ["grouped", "detailed"] as const) {
        const lines = toast(layout, room, [PREMIUM, CLAUDE, ROUTER]);
        expect(widest(lines), `${layout} ${room}`).toBeLessThanOrEqual(room);
        expect(lines.filter((line) => line !== line.trimEnd())).toEqual([]);
      }
    }
    // Without room for 3 cells, a grouped row has no bar.
    expect(toast("grouped", 24, [CLAUDE])).toEqual([
      "Claude",
      "  5h  58% left  2h 14m",
      "  7d  12% left  3.2d",
      "     runs out in 13h",
    ]);
  });

  it("shows no toast bar with bars off: the percent alone, at the right in a detailed toast", () => {
    const barsOff = { layout: { ...display.layout, bar: "none" as const }, runsOut: false };
    expect({
      grouped: toast("grouped", 54, [CLAUDE], barsOff),
      detailed: toast("detailed", 54, [CLAUDE], barsOff),
    }).toEqual({
      grouped: ["Claude", "  5h  58% left  2h 14m", "  7d  12% left  3.2d"],
      detailed: [
        "Claude",
        `5h${" ".repeat(46)}2h 14m`,
        "58% left".padStart(54),
        `7d${" ".repeat(48)}3.2d`,
        "12% left".padStart(54),
      ],
    });
  });

  it("lays full row names out in every place with rowNames full", () => {
    const full = { ...drawn, words: words({ rowNames: "full" }) };
    const of = (surface: Surface) => groups(surface, [CLAUDE]);
    const toastOf = (toastLayout: ToastLayout) =>
      toast(toastLayout, 30, [CLAUDE], { words: full.words, runsOut: false });
    expect({
      sidebar: sidebarLines({ ...full, groups: of("sidebar"), width: 40 }).map(lineText),
      collapsed: collapsedLines({ ...full, groups: of("collapsed"), width: 40, window: {} }).map(
        lineText,
      ),
      statusLine: lineText(bigStatusLine({ ...full, groups: of("statusLine"), window: {} })!),
      grouped: toastOf("grouped"),
      detailed: toastOf("detailed"),
    }).toEqual({
      sidebar: [
        "Claude",
        " 5h     ████████████░░░░░░░░  58% 2h 14m",
        " Weekly ██░░░░░░░░░░░░░░░░░░  12%   3.2d",
      ],
      collapsed: ["Claude    Wee… █░░░░░░░░░  12%    3.2d"],
      statusLine: "Claude Weekly █░░░░░░░░░ 12% left · 3.2d",
      grouped: ["Claude", "  5h     ██░  58% left  2h 14m", "  Weekly ░░░  12% left  3.2d"],
      detailed: [
        "Claude",
        `5h${" ".repeat(22)}2h 14m`,
        `${"█".repeat(12)}${"░".repeat(8)}  58% left`,
        `Weekly${" ".repeat(20)}3.2d`,
        `${"█".repeat(2)}${"░".repeat(18)}  12% left`,
      ],
    });
  });

  it("writes plain lines for the Web and terminal /quota text, errors and session tokens last", () => {
    expect(
      plainLines({
        groups: groups("toast"),
        words: DEFAULT_WORDS,
        nowMs: NOW,
        sessionTokens: { input: 12_300, cachedInput: 0, output: 2_100 },
      }),
    ).toEqual([
      "Claude 5h           58% left      2h 14m",
      "Claude Weekly       12% left      3.2d",
      "OpenCode Zen Balan… $1,240.50 left",
      "OpenRouter          Sign in again",
      "Session  12.3K in · 2.10K out",
    ]);
  });
});
