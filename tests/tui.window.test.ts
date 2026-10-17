import { createRoot } from "solid-js";
import { describe, expect, it, vi } from "vite-plus/test";
import type { ProviderSnapshot, QuotaRow, QuotaSnapshot } from "../src/core/types.js";
import { USAGE_RANGES, type UsageReport } from "../src/core/usage.js";
import { defaultDisplaySettings } from "../src/tui/display.js";
import { limitsLines } from "../src/tui/window/limits.js";
import { RAIL_LABEL_WIDTH } from "../src/tui/window/rail.tsx";
import {
  lineColumns,
  type OptionLine,
  OptionRow,
  SETTINGS_GROUPS,
  SETTINGS_TABS,
} from "../src/tui/window/settings.tsx";
import { hintLines, keyHintLines, tabStrip } from "../src/tui/window/shell.tsx";
import { createUsageTab } from "../src/tui/window/usage.tsx";
import { noticeItems, statusLines } from "../src/tui/window/views.tsx";
import { columnsOf } from "../src/view/columns.js";
import { lineText } from "../src/view/text.js";
import { createFakeTuiHost, stubJsx } from "./helpers/fake-tui-host.js";
import { findAll, THEME, textLines } from "./helpers/jsx-tree.js";

const NOW = Date.parse("2026-10-10T12:00:00.000Z");
const MINUTE = 60_000;
const at = (minutes: number) => new Date(NOW + minutes * MINUTE).toISOString();
/** Wide enough for every column on one line. */
const WIDE = 110;
function row(id: string, fields: Partial<QuotaRow> = {}): QuotaRow {
  const [providerId = "", key = ""] = id.split(".");
  return {
    id,
    providerId,
    label: key,
    type: "quota",
    method: "remote_api",
    authority: "provider_reported",
    prominence: "primary",
    ...fields,
  };
}

function provider(providerId: string, label: string, rows: QuotaRow[], extra = {}) {
  return {
    providerId,
    label,
    rows,
    okAtMs: NOW,
    checkedAtMs: NOW,
    refreshing: false,
    debug: [],
    ...extra,
  } satisfies ProviderSnapshot;
}

/** Half of the 5-hour window has passed, so even use would leave 50%. */
const FIVE_HOUR = row("anthropic.five_hour", {
  label: "5h",
  window: "five_hour",
  percentRemaining: 30,
  resetsAt: at(150),
});
const CLAUDE = provider("anthropic", "Claude", [
  FIVE_HOUR,
  row("anthropic.weekly_fable", {
    label: "Fable",
    percentRemaining: 90,
    prominence: "supplementary",
  }),
]);

function limitLines(providers: ProviderSnapshot[], width = WIDE, hidden: string[] = []) {
  const display = defaultDisplaySettings();
  display.surfaces.sidebar.hidden = hidden;
  const snapshot: QuotaSnapshot = { version: 6, providers, resetNotices: [], generatedAtMs: NOW };
  return limitsLines({ snapshot, display, nowMs: NOW, width });
}

function limits(providers: ProviderSnapshot[], width = WIDE, hidden: string[] = []) {
  return limitLines(providers, width, hidden).map(lineText);
}

const ZEN = provider("opencode", "OpenCode Zen", [
  row("opencode.balance", {
    label: "Balance",
    type: "balance",
    amount: { decimal: "12.5", unit: { kind: "currency", code: "USD" } },
  }),
]);

/** Where the label column ends and the bar starts: 3 + the widest label ("Balance") + 2. */
const BAR_COLUMN = 3 + "Balance".length + 2;

describe("quota window: Limits", () => {
  it("shows every row, hidden and supplementary ones too, with reset and pace", () => {
    const lines = limits([CLAUDE], WIDE, ["anthropic.five_hour"]);
    // Like the window's other tabs: the provider one column in, its rows three.
    expect(lines[0]).toBe(" Claude");
    expect(lines[1]).toMatch(
      /^ {3}5h +[█░┃]+ {2}30% left {3}resets in 2h 30m {3}runs out in 1h 5m$/u,
    );
    expect(lines[2]).toMatch(/^ {3}Fable +[█░]+ {2}90% left$/u);
  });

  it("shows exact times and full row names whatever the words", () => {
    const weekly = row("anthropic.weekly", {
      label: "Weekly",
      window: "week",
      percentRemaining: 60,
      resetsAt: at(3 * 1440 + 23 * 60 + 58),
    });
    // The words default to smart times ("4.0d") and short row names ("7d").
    expect(limits([provider("anthropic", "Claude", [weekly])])[1]).toMatch(
      /^ {3}Weekly +[█░┃]+ {2}60% left {3}resets in 3d 23h 58m/u,
    );
  });

  it("lines every provider up in one grid that fills the window, under name-only provider lines", () => {
    const lines = limits([CLAUDE, ZEN]);
    const [claude, fiveHour, fable, gap, zen, balance] = lines;
    expect(gap).toBe("");
    // The bars start in one column, the percents and the balance end in one column.
    expect(fiveHour.indexOf("█")).toBe(BAR_COLUMN);
    expect(fable.indexOf("█")).toBe(BAR_COLUMN);
    const percentEnd = fiveHour.indexOf("30% left") + "30% left".length;
    expect(fable.length).toBe(percentEnd);
    expect(balance).toBe(
      `   Balance${" ".repeat(percentEnd - "   Balance".length - "$12.50 left".length)}$12.50 left`,
    );
    // The grid fills the window; a provider's line has only its name.
    expect(fiveHour.length).toBe(WIDE);
    expect(claude).toBe(" Claude");
    expect(zen).toBe(" OpenCode Zen");
  });

  it("draws the bar in the level color with the even-use marker where even use would be", () => {
    const fiveHour = limitLines([CLAUDE])[1];
    const bar = fiveHour.segments.filter((segment) => /^[█░┃]+$/u.test(segment.text));
    expect(bar.map((segment) => segment.role)).toEqual(["bar", "empty", "label", "empty"]);
    const cells = bar.map((segment) => segment.text).join("");
    // 30% left; half of the 5-hour window has passed, so even use would leave 50%.
    expect(cells.indexOf("┃")).toBe(Math.round(cells.length / 2));
    expect(bar[0].text).toHaveLength(Math.round(cells.length * 0.3));
  });

  it.each([
    { bar: "dots", cells: /^[●○]+┃[○]+$/u },
    { bar: "line", cells: /^[━─]+┃─+$/u },
    // With bars off elsewhere, Limits keeps the thin line: the even-use marker needs a bar.
    { bar: "none", cells: /^[━─]+┃─+$/u },
  ] as const)("draws the sidebar's bar shape: $bar", ({ bar, cells }) => {
    const display = defaultDisplaySettings();
    display.layout.bar = bar;
    const snapshot: QuotaSnapshot = {
      version: 6,
      providers: [CLAUDE],
      resetNotices: [],
      generatedAtMs: NOW,
    };
    const fiveHour = lineText(limitsLines({ snapshot, display, nowMs: NOW, width: WIDE })[1]);
    expect(fiveHour.match(/^ {3}5h +(\S+) {2}30% left/u)?.[1]).toMatch(cells);
  });

  it.each([
    { width: 90, cells: 31 },
    { width: 110, cells: 51 },
    { width: 300, cells: 80 },
  ])(
    "gives the bar the room the other columns leave, at most 80 cells ($width wide)",
    ({ width, cells }) => {
      const fable = limits([CLAUDE], width).find((line) => line.includes("Fable"));
      expect(fable?.match(/[█░]+/u)?.[0]).toHaveLength(cells);
    },
  );

  it("shortens the reset to its first unit before the bar gets too short (80 columns)", () => {
    // 80 columns leave 72 inside the window: the session's padding, the border and the padding.
    const lines = limits([CLAUDE], 72);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(72);
    expect(lines[1]).toMatch(/^ {3}5h +[█░┃]+ {2}30% left {3}2h {3}runs out in 1h 5m$/u);
  });

  it("puts the reset and the pace under the bar when they leave it no room", () => {
    const lines = limits([CLAUDE], 50);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(50);
    expect(lines.slice(1, 4)).toEqual([
      expect.stringMatching(/^ {3}5h +[█░┃]+ {2}30% left$/u),
      `${" ".repeat(3 + "Fable".length + 2)}resets in 2h 30m · runs out in 1h 5m`,
      expect.stringMatching(/^ {3}Fable +[█░]+ {2}90% left$/u),
    ]);
  });

  it("puts the pace on a line of its own when it doesn't fit after the reset", () => {
    const lines = limits([CLAUDE], 40);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(40);
    expect(lines.slice(2, 4)).toEqual([
      `${" ".repeat(10)}resets in 2h 30m`,
      `${" ".repeat(10)}runs out in 1h 5m`,
    ]);
  });

  it.each([24, 30, 36, 44, 56, 64, 72, 80, 96, 120, 160, 240])(
    "keeps every line inside a window %i wide",
    (width) => {
      const long = provider("copilot", "Copilot", [
        row("copilot.premium", {
          label: "Premium interactions",
          window: "month",
          percentRemaining: 80,
          resetsAt: at(30_000),
        }),
      ]);
      for (const line of limits([CLAUDE, ZEN, long], width)) {
        expect(line.length).toBeLessThanOrEqual(width);
      }
    },
  );

  it("puts a provider's error on its own line under its name", () => {
    const failed = provider("anthropic", "Claude", [], { error: { code: "login_expired" } });
    const lines = limitLines([failed]);
    expect(lines.map(lineText)).toEqual([" Claude", "   Sign in again"]);
    expect(lines[1].segments[0].role).toBe("error");
  });

  it("lines balances up at their right ends when no row has a bar", () => {
    const lines = limits([ZEN]);
    expect(lines).toEqual([" OpenCode Zen", "   Balance  $12.50 left"]);
  });

  it("says where to look when no provider is found", () => {
    expect(limits([])).toEqual(["   No quota providers found. The Plugin tab says why."]);
  });
});

describe("quota window: Notices", () => {
  it("says why there is no notice", () => {
    expect(noticeItems({ notices: [] }).empty).toBe("No notices right now.");
  });
});

describe("quota window: Status", () => {
  it("makes the title and section titles headings", () => {
    const text = "# Quota Status (opencode-quota)\n\nproviders:\n- copilot: ok\n  detail:";
    expect(
      statusLines(text)
        .filter((line) => line.heading)
        .map((line) => line.text),
    ).toEqual(["# Quota Status (opencode-quota)", "providers:"]);
  });

  it("breaks a long id list between ids, lined up after its key", () => {
    const text = "- providers.off: anthropic | xai | google-gemini-cli | kimi-code-plan-global";
    expect(statusLines(text, 44).map((line) => line.text)).toEqual([
      "- providers.off: anthropic | xai |",
      "                 google-gemini-cli |",
      "                 kimi-code-plan-global",
    ]);
    expect(statusLines(text, 200).map((line) => line.text)).toEqual([text]);
  });
});

describe("quota window: tab bar", () => {
  const TITLES = ["Usage", "Limits", "Notices", "Status", "Sidebar", "Collapsed", "Status line"];
  /** The view tabs, then the Settings tabs from "Sidebar" on. */
  const SETTINGS_FROM = 4;
  // 5+6+7+6+7+9+11 titles, 6 gaps of 2, "Settings" and its gap.
  const FULL = 51 + 12 + 10;

  it("shows every tab and the Settings label when they fit", () => {
    expect(tabStrip(TITLES, SETTINGS_FROM, 0, FULL)).toEqual({
      first: 0,
      last: 6,
      settingsLabel: true,
    });
  });

  it("drops the Settings label (a │ stays) before it hides a tab", () => {
    expect(tabStrip(TITLES, SETTINGS_FROM, 0, FULL - 1)).toEqual({
      first: 0,
      last: 6,
      settingsLabel: false,
    });
  });

  // In 40 columns: the active tab and as many neighbours as fit between ‹ and ›.
  it.each([
    { active: 0, first: 0, last: 3 },
    { active: 3, first: 2, last: 4 },
    { active: 4, first: 3, last: 5 },
    { active: 6, first: 4, last: 6 },
  ])(
    "shows tabs $first to $last around tab $active when they don't all fit",
    ({ active, first, last }) => {
      expect(tabStrip(TITLES, SETTINGS_FROM, active, 40)).toEqual({
        first,
        last,
        settingsLabel: false,
      });
    },
  );
});

describe("quota window: the lists left of the body", () => {
  it("fit every label of Usage's ranges and Layout's pages in their one width", () => {
    const pages = SETTINGS_GROUPS.flatMap((group) => group.pages).map(
      (page) => SETTINGS_TABS.find((item) => item.tab === page)?.title ?? page,
    );
    const labels = [...USAGE_RANGES.map((item) => item.label), ...pages];
    expect(Math.max(...labels.map((label) => label.length))).toBe(RAIL_LABEL_WIDTH);
  });
});

describe("quota window: Settings lines", () => {
  it("narrows the title first, then the value, so a line fits its room", () => {
    expect(lineColumns(undefined)).toEqual({ title: 26, value: 24 });
    expect(lineColumns(70)).toEqual({ title: 26, value: 24 });
    // 80 columns with Layout's page list: the title gives way.
    expect(lineColumns(53)).toEqual({ title: 21, value: 24 });
    // 60 columns: the title stops at 12, then the value narrows.
    expect(lineColumns(33)).toEqual({ title: 12, value: 13 });
    expect(lineColumns(10)).toEqual({ title: 12, value: 6 });
    // Plugin's short values keep their own width.
    expect(lineColumns(33, 3)).toEqual({ title: 22, value: 3 });
  });

  /** What an OptionRow draws for `line`, `width` columns wide. */
  function drawRow(line: OptionLine, width: number, active = false): unknown {
    stubJsx();
    // Show hands back a function; call it to get what it draws.
    const drawn = (node: unknown): unknown =>
      typeof node === "function"
        ? drawn(node())
        : Array.isArray(node)
          ? node.map(drawn)
          : node && typeof node === "object" && "props" in node
            ? {
                ...(node as { props: object }),
                props: {
                  ...(node as { props: { children?: unknown } }).props,
                  children: drawn((node as { props: { children?: unknown } }).props.children),
                },
              }
            : node;
    try {
      return createRoot(() =>
        drawn(
          OptionRow({
            line,
            theme: THEME as never,
            active,
            click: (run) => run,
            press: () => {},
            use: () => {},
            width,
          }),
        ),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it("keeps the value and its › inside a narrow line", () => {
    const tree = drawRow(
      {
        id: "spacing.providers",
        title: "Between providers",
        value: () => "1 empty line",
        cycle: () => {},
      },
      33,
    );
    const [row] = findAll(tree, (node) => node.props?.id === "quota-settings.spacing.providers");
    const text = textLines(row).join("");
    expect(columnsOf(text)).toBeLessThanOrEqual(33);
    expect(text).toContain("1 empty line");
    expect(text.trimEnd().endsWith("›")).toBe(true);
  });

  it("keeps a selected line's note in its own color once it goes under the line", () => {
    const url = "https://api.moonshot.ai/v1/users/me/balance";
    const moonshot: OptionLine = {
      id: "custom.moonshot",
      title: "Moonshot",
      value: () => "on",
      cycle: () => {},
      note: () => url,
    };
    const noteColor = (width: number) =>
      findAll(
        drawRow(moonshot, width, true),
        (node) => node.type === "text" && textLines(node)[0] === url,
      )[0]?.props.fg;
    // After the value it is on the highlight, in the highlight's text color.
    expect(noteColor(120)).toBe("action");
    // Under the line it is off the highlight, so it keeps the muted color.
    expect(noteColor(60)).toBe("muted");
  });
});

describe("quota window: keyboard hint", () => {
  it("breaks its lines between items, never inside one", () => {
    expect(hintLines("↑↓ select · tab next tab · esc close", 24)).toBe(
      "↑↓ select · tab next tab\nesc close",
    );
    expect(hintLines("↑↓ select · tab next tab · esc close", 23)).toBe(
      "↑↓ select\ntab next tab\nesc close",
    );
  });

  it("keeps one line when it fits", () => {
    expect(hintLines("tab next tab · esc close", 80)).toBe("tab next tab · esc close");
  });
});

describe("quota window: key hints", () => {
  const hints = [
    { key: "↑↓", label: "range" },
    { key: "c", label: "cost" },
    { label: "updating prices…" },
    { key: "esc", label: "close" },
  ];
  // "↑↓ range" 8, "c cost" 6, "updating prices…" 16, "esc close" 9, two columns between.
  it.each([
    { width: 45, lines: [["↑↓", "c", undefined, "esc"]] },
    { width: 44, lines: [["↑↓", "c", undefined], ["esc"]] },
    {
      width: 33,
      lines: [
        ["↑↓", "c"],
        [undefined, "esc"],
      ],
    },
    { width: 10, lines: [["↑↓"], ["c"], [undefined], ["esc"]] },
  ])("at $width columns breaks between hints, two spaces apart", ({ width, lines }) => {
    expect(keyHintLines(hints, width).map((line) => line.map((hint) => hint.key))).toEqual(lines);
  });
});

/** One provider with two models of $1 and 100 tokens each, all of it input. */
function twoModelReport(): UsageReport {
  const byType = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  const half = { costUsd: 1, costShare: 0.5, tokens: 100, tokenShare: 0.5, unpricedTokens: 0 };
  const whole = { costUsd: 2, costShare: 1, tokens: 200, tokenShare: 1, unpricedTokens: 0 };
  return {
    range: "session",
    sessionID: "ses_1",
    generatedAtMs: NOW,
    totals: {
      costUsd: 2,
      sessions: 1,
      tokens: { processed: 200, cachedInput: 0, uncachedInput: 200, output: 0 },
      tokensByType: { ...byType, input: 200 },
      costByType: { ...byType, input: 2 },
      cacheSavingsUsd: 0,
      unpricedTokens: 0,
      unpricedShare: 0,
    },
    providers: [{ providerID: "anthropic", sessions: 1, ...whole }],
    models: ["claude-a", "claude-b"].map((modelID) => ({
      providerID: "anthropic",
      modelID,
      priced: true,
      ...half,
      costByType: { ...byType, input: 1 },
      tokensByType: { ...byType, input: 100 },
      days: [],
    })),
    days: [{ date: "2026-10-10", ...whole }],
  };
}

describe("quota window: Usage keys", () => {
  it("names the keys for where the keyboard is, and says so while prices update", async () => {
    stubJsx();
    let answerPrices = (_answer: { ok: boolean; message: string }) => {};
    const tui = createFakeTuiHost({
      rpc: {
        usage: async () => ({ report: twoModelReport() }),
        downloadPrices: () =>
          new Promise((resolve) => {
            answerPrices = resolve;
          }),
      },
      theme: THEME,
    });
    const usage = createUsageTab(tui.context as never, () => undefined);
    createRoot(() => usage.View({ width: 100, keyTarget: () => undefined }));
    const press = (bind: string) => tui.press("tab", bind);
    const hints = () =>
      usage
        .hints()
        .map((hint) => (hint.key ? `${hint.key} ${hint.label}` : hint.label))
        .join("  ");
    const shared = "c cost  t tokens  b by model/day  p update prices  tab next tab  esc close";

    // The range list has the keyboard; once the report has model rows, → goes to them.
    usage.show("ses_1");
    expect(hints()).toBe(`↑↓ range  ${shared}`);
    await vi.waitFor(() => expect(hints()).toBe(`↑↓ range  → models  ${shared}`));
    press("right");
    expect(hints()).toBe(`↑↓ models  enter details  ← ranges  ${shared}`);
    // By day there are no model rows: ↑↓ scroll the window.
    press("b");
    expect(hints()).toBe(`↑↓ scroll  ← ranges  ${shared}`);
    press("left");
    expect(hints()).toBe(`↑↓ range  ${shared}`);

    // Between, the last range, adds d; p says it is updating until the answer comes.
    for (let step = 1; step < USAGE_RANGES.length; step++) press("down");
    expect(hints()).toBe(`↑↓ range  d type dates  ${shared}`);
    press("p");
    expect(hints()).toContain("b by model/day  updating prices…  tab next tab");
    answerPrices({ ok: false, message: "Couldn't download new prices: network down." });
    await vi.waitFor(() => expect(hints()).toContain("b by model/day  p update prices  tab"));
  });
});
