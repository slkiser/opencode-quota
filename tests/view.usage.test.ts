import { describe, expect, it } from "vite-plus/test";

import type {
  UsageDayRow,
  UsageModelRow,
  UsageProviderRow,
  UsageReport,
} from "../src/core/usage.js";
import { formatShare, formatTokens, formatUsd } from "../src/view/format.js";
import {
  breakdownModels,
  modelDetailView,
  rangeDates,
  type UsageLine,
  type UsageViewOptions,
  usageText,
  usageView,
} from "../src/view/usage.js";

const M = 1_000_000;
/** The report's "now": 3 pm on Saturday 2026-10-10, local time. */
const NOW = new Date(2026, 9, 10, 15).getTime();

/** [cost in USD, processed tokens, tokens without a price] */
type Amounts = [costUsd: number, tokens: number, unpricedTokens?: number];

type ReportSpec = {
  range?: UsageReport["range"];
  sessions: number;
  providers: [providerID: string, sessions: number, ...Amounts][];
  models: [providerID: string, modelID: string, ...Amounts][];
  /** One entry per day, oldest first, ending on `lastDay`. */
  days: Amounts[];
  lastDay?: Date;
  tokens: { cachedInput: number; uncachedInput: number; output: number };
  /** Default: cached input as cache reads, uncached input as input. */
  tokensByType?: UsageReport["totals"]["tokensByType"];
  costByType: UsageReport["totals"]["costByType"];
  cacheSavingsUsd: number;
};

/**
 * A hand-built report: totals and shares come from the provider rows. A model's cost and
 * tokens are all input, and its days are left out.
 */
function buildReport(spec: ReportSpec): UsageReport {
  const costUsd = spec.providers.reduce((sum, [, , cost]) => sum + cost, 0);
  const tokens = spec.providers.reduce((sum, [, , , count]) => sum + count, 0);
  const unpricedTokens = spec.providers.reduce((sum, [, , , , unpriced = 0]) => sum + unpriced, 0);
  const row = ([cost, count, unpriced = 0]: Amounts) => ({
    costUsd: cost,
    costShare: costUsd > 0 ? cost / costUsd : 0,
    tokens: count,
    tokenShare: tokens > 0 ? count / tokens : 0,
    unpricedTokens: unpriced,
  });
  const lastDay = spec.lastDay ?? new Date(2026, 9, 10);
  const days: UsageDayRow[] = spec.days.map((amounts, index) => {
    const day = new Date(
      lastDay.getFullYear(),
      lastDay.getMonth(),
      lastDay.getDate() - (spec.days.length - 1 - index),
    );
    const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    return { date, ...row(amounts) };
  });
  const providers: UsageProviderRow[] = spec.providers.map(
    ([providerID, sessions, ...amounts]) => ({
      providerID,
      sessions,
      ...row(amounts),
    }),
  );
  const models: UsageModelRow[] = spec.models.map(([providerID, modelID, ...amounts]) => ({
    providerID,
    modelID,
    priced: (amounts[2] ?? 0) === 0,
    ...row(amounts),
    costByType: { input: amounts[0], cacheRead: 0, cacheWrite: 0, output: 0 },
    tokensByType: { input: amounts[1], cacheRead: 0, cacheWrite: 0, output: 0 },
    days: [],
  }));
  return {
    range: spec.range ?? "30d",
    generatedAtMs: NOW,
    totals: {
      costUsd,
      sessions: spec.sessions,
      tokens: { processed: tokens, ...spec.tokens },
      tokensByType: spec.tokensByType ?? {
        input: spec.tokens.uncachedInput,
        cacheRead: spec.tokens.cachedInput,
        cacheWrite: 0,
        output: spec.tokens.output,
      },
      costByType: spec.costByType,
      cacheSavingsUsd: spec.cacheSavingsUsd,
      unpricedTokens,
      unpricedShare: tokens > 0 ? unpricedTokens / tokens : 0,
    },
    providers,
    models,
    days,
  };
}

/** 30 days of cost, Sep 11 to Oct 10: quiet at first, a spike on Sep 26, two days off. */
const DAILY_COST = [
  0, 0.4, 0.8, 1.2, 0, 9.5, 2.1, 7.4, 3.3, 0.9, 4.2, 30.5, 180.3, 210.7, 260.9, 1371.2, 170.1,
  175.6, 268.4, 250.2, 95.7, 230.4, 299.8, 120.5, 98.3, 415.2, 430.8, 260.3, 120.6, 1004.9,
];
const DAILY_TOTAL = DAILY_COST.reduce((sum, cost) => sum + cost, 0);

/** Close to the maintainer's screenshot of T3 Code: one provider has almost all the cost. */
function t3Report(): UsageReport {
  return buildReport({
    sessions: 636,
    providers: [
      ["anthropic", 248, 5011, 12_900 * M],
      ["cursor", 316, 353.05, 368 * M],
      ["openai", 63, 47.3, 119 * M],
      ["opencode", 9, 4.06, 8.97 * M, 0.97 * M],
    ],
    models: [
      ["anthropic", "claude-opus-5-5", 4410.41, 12_500 * M],
      ["cursor", "composer-2", 353.05, 368 * M],
      ["anthropic", "claude-fable-5-1", 330.3, 270 * M],
      ["anthropic", "claude-sonnet-5", 270.29, 130 * M],
      ["openai", "gpt-6.1", 47.3, 119 * M],
      ["opencode", "gpt-6.1", 4.06, 8 * M],
      ["opencode", "exo-free", 0, 0.97 * M, 0.97 * M],
    ],
    days: DAILY_COST.map((cost) => [
      (cost / DAILY_TOTAL) * 5415.41,
      cost === 0 ? 0 : Math.round(cost * 2.47 * M),
    ]),
    tokens: { cachedInput: 13_200 * M, uncachedInput: 146 * M, output: 49.97 * M },
    tokensByType: { input: 4 * M, cacheRead: 13_200 * M, cacheWrite: 142 * M, output: 49.97 * M },
    costByType: { input: 369.53, cacheRead: 2749.39, cacheWrite: 1716.2, output: 580.29 },
    cacheSavingsUsd: 49_636.93,
  });
}

function textOf(line: UsageLine): string {
  return line.map((part) => part.text).join("");
}

function render(report: UsageReport, options: UsageViewOptions): string[] {
  return usageView(report, options).lines.map(textOf);
}

/** The first line whose text holds `text`, and the lines after it. */
function from(lines: UsageLine[], text: string): UsageLine[] {
  const index = lines.findIndex((line) => textOf(line).includes(text));
  if (index < 0) throw new Error(`no line with ${JSON.stringify(text)}`);
  return lines.slice(index);
}

/** The first line whose text holds `text` and the lines after it, up to the next blank line. */
function section(lines: UsageLine[], text: string): UsageLine[] {
  const after = from(lines, text);
  const end = after.findIndex((line) => line.length === 0);
  return end < 0 ? after : after.slice(0, end);
}

/** The T3 report's view from the first line holding `text`; default: cost by model, 80 columns. */
function t3From(text: string, options: Partial<UsageViewOptions> = {}): UsageLine[] {
  const view = usageView(t3Report(), {
    mode: "cost",
    breakdown: "model",
    width: 80,
    ...options,
  }).lines;
  return from(view, text);
}

/** The T3 report's section from the first line holding `text`; default: cost by model, 80 columns. */
function t3Section(text: string, options: Partial<UsageViewOptions> = {}): UsageLine[] {
  const view = usageView(t3Report(), {
    mode: "cost",
    breakdown: "model",
    width: 80,
    ...options,
  }).lines;
  return section(view, text);
}

/** One provider with a price, one free model, one model without a price, over 7 days. */
function unpricedReport(): UsageReport {
  return buildReport({
    range: "7d",
    sessions: 3,
    providers: [
      ["anthropic", 2, 1.5, 3 * M],
      ["opencode", 1, 0, 2 * M, 1 * M],
    ],
    models: [
      ["anthropic", "claude-test", 1.5, 3 * M],
      ["opencode", "big-pickle", 0, 1 * M],
      ["opencode", "exo-free", 0, 1 * M, 1 * M],
    ],
    // Oct 4 to Oct 10: Oct 7 only used the free model, Oct 8 only the one without a price.
    days: [
      [0, 0],
      [0, 0],
      [1.5, 3 * M],
      [0, 1 * M],
      [0, 1 * M, 1 * M],
      [0, 0],
      [0, 0],
    ],
    tokens: { cachedInput: 2 * M, uncachedInput: 2.5 * M, output: 0.5 * M },
    costByType: { input: 0.5, cacheRead: 0, cacheWrite: 0, output: 1 },
    cacheSavingsUsd: 0,
  });
}

const EMPTY_REPORT = buildReport({
  range: "7d",
  sessions: 0,
  providers: [],
  models: [],
  days: Array.from({ length: 7 }, (): Amounts => [0, 0]),
  tokens: { cachedInput: 0, uncachedInput: 0, output: 0 },
  costByType: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
  cacheSavingsUsd: 0,
});

/** Names in CJK and emoji, which take two terminal columns per character. */
function wideNamesReport(): UsageReport {
  return buildReport({
    sessions: 2,
    providers: [["测试云", 2, 3, 3 * M]],
    models: [
      ["测试云", "模型-超长的名字-专业版-二零二六", 2, 2 * M],
      ["测试云", "👍🏽👍🏽👍🏽👍🏽👍🏽👍🏽👍🏽👍🏽👍🏽👍🏽👍🏽👍🏽👍🏽👍🏽👍🏽👍🏽👍🏽👍🏽👍🏽👍🏽👍🏽👍🏽", 1, 1 * M],
    ],
    days: [
      [1, 1 * M],
      [2, 2 * M],
    ],
    tokens: { cachedInput: 1 * M, uncachedInput: 1 * M, output: 1 * M },
    costByType: { input: 1, cacheRead: 1, cacheWrite: 0, output: 1 },
    cacheSavingsUsd: 0,
  });
}

/**
 * Models with and without cache numbers, most cost first: [provider, model, cost, tokens, and
 * the input tokens by kind: new input, cache reads, cache writes].
 */
function cacheReport(): UsageReport {
  const models: [string, string, number, number, number, number, number][] = [
    ["openai", "gpt-5.6-sol", 4.44, 1.71 * M, 135_000, 1_365_000, 0],
    ["anthropic", "claude-sonnet-5", 3.62, 4.48 * M, 2.6 * M, 1.4 * M, 0],
    ["zai", "glm-5.3", 1.1, 1.07 * M, 1 * M, 0, 0],
    ["openai", "gpt-5.6-mini", 1, 0.25 * M, 100_000, 20_000, 30_000],
    ["openai", "o5", 0.5, 0.65 * M, 300_000, 300_000, 0],
    ["openai", "o5-image", 0, 0.05 * M, 0, 0, 0],
  ];
  const report = buildReport({
    sessions: 3,
    providers: [
      ["openai", 2, 5.94, 2.66 * M],
      ["anthropic", 1, 3.62, 4.48 * M],
      ["zai", 1, 1.1, 1.07 * M],
    ],
    models: models.map(([providerID, modelID, cost, tokens]) => [
      providerID,
      modelID,
      cost,
      tokens,
    ]),
    days: [[10.66, 8.21 * M]],
    tokens: { cachedInput: 3.085 * M, uncachedInput: 4.165 * M, output: 0.96 * M },
    costByType: { input: 6, cacheRead: 1, cacheWrite: 0.66, output: 3 },
    cacheSavingsUsd: 0,
  });
  report.models.forEach((row, index) => {
    const [, , , , input, cacheRead, cacheWrite] = models[index];
    row.tokensByType = {
      input,
      cacheRead,
      cacheWrite,
      output: row.tokens - input - cacheRead - cacheWrite,
    };
  });
  return report;
}

/** One provider, one model and these days ([cost, tokens], oldest first). */
function daysReport(days: Amounts[], range?: UsageReport["range"], sessions = 1): UsageReport {
  const cost = days.reduce((sum, [dayCost]) => sum + dayCost, 0);
  const tokens = days.reduce((sum, [, dayTokens]) => sum + dayTokens, 0);
  return buildReport({
    range,
    sessions,
    providers: [["anthropic", sessions, cost, tokens]],
    models: [["anthropic", "claude-test", cost, tokens]],
    days,
    tokens: { cachedInput: 0, uncachedInput: tokens, output: 0 },
    costByType: { input: cost, cacheRead: 0, cacheWrite: 0, output: 0 },
    cacheSavingsUsd: 0,
  });
}

/** 400 days up to Oct 10, 2026, every one of them used: more days than a chart has columns. */
const longReport = () =>
  daysReport(
    Array.from({ length: 400 }, (_, index): Amounts => [index % 5, (index % 5) * M]),
    "between",
    40,
  );

const GRAPHEMES = new Intl.Segmenter("en", { granularity: "grapheme" });

/** Terminal columns of the strings in these tests: CJK and emoji take two. */
function columnsIn(text: string): number {
  let columns = 0;
  for (const { segment } of GRAPHEMES.segment(text)) {
    columns += /[\u4E00-\u9FFF]|\p{Emoji_Presentation}/u.test(segment) ? 2 : 1;
  }
  return columns;
}

describe("number formats", () => {
  it.each([
    [formatUsd, 0, "$0.00"],
    [formatUsd, 0.004, "<$0.01"],
    [formatUsd, 0.005, "$0.01"],
    [formatUsd, 1234.5, "$1,234.50"],
    [formatUsd, 49_636.93, "$49,636.93"],
    [formatTokens, 12, "12"],
    [formatTokens, 950, "950"],
    [formatTokens, 12_345, "12.3K"],
    [formatTokens, 8.97 * M, "8.97M"],
    [formatTokens, 146 * M, "146M"],
    [formatTokens, 13_396 * M, "13.4B"],
    [formatTokens, 8 * M, "8.00M"],
    [formatTokens, 49.97 * M, "50.0M"],
    [formatTokens, 999_950, "1.00M"],
    [formatShare, 0, "0%"],
    [formatShare, 0.0004, "<0.1%"],
    [formatShare, 0.009, "0.9%"],
    [formatShare, 0.925, "92.5%"],
    [formatShare, 0.05, "5.0%"],
    [formatShare, 1, "100.0%"],
  ])("%o(%d) is %s", (format, value, expected) => {
    expect(format(value)).toBe(expected);
  });
});

describe("usageView", () => {
  const reports = {
    t3: t3Report(),
    unpriced: unpricedReport(),
    long: longReport(),
    wideNames: wideNamesReport(),
  };
  const cases = Object.entries(reports).flatMap(([name, report]) =>
    [10, 32, 64, 80, 109, 110, 160, 240].flatMap((width) =>
      (["cost", "tokens"] as const).flatMap((mode) =>
        (["model", "day"] as const).map((breakdown) => ({ name, report, width, mode, breakdown })),
      ),
    ),
  );

  it.each(cases)("$name at $width columns, $mode by $breakdown: every line fits", (testCase) => {
    const lines = usageView(testCase.report, testCase).lines;
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines) {
      expect(columnsIn(textOf(line))).toBeLessThanOrEqual(testCase.width);
      // No empty span, no line break, no half of a surrogate pair.
      for (const part of line) {
        expect(part.text).not.toMatch(/^$|\n|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      }
    }
  });

  it("measures names in terminal columns and cuts them between characters", () => {
    const lines = from(
      usageView(wideNamesReport(), { mode: "cost", breakdown: "model", width: 67 }).lines,
      "Breakdown",
    );
    const rows = lines.slice(1).map(textOf);
    expect(rows.map(columnsIn)).toEqual([67, 67, 67]);
    expect(rows[1]).toMatch(/^1 {2}● 模型-超长的名字-专业版-二零二六 +\$2\.00 /u);
    const emojiName = lines[3].find((part) => part.role === "text")?.text ?? "";
    expect(emojiName).toMatch(/^(👍🏽)+… *$/u);
  });

  it.each([
    { width: 64, beside: false },
    { width: 80, beside: true },
    { width: 160, beside: true },
  ])(
    "puts the chart beside the total when it gets 32 columns there ($width: $beside)",
    ({ width, beside }) => {
      const totalLine = render(t3Report(), { mode: "cost", breakdown: "model", width })[0];
      expect(totalLine.startsWith("$5,415.41  636 sessions · API estimate")).toBe(true);
      expect(/Daily cost|Cost per \d+ days/.test(totalLine)).toBe(beside);
    },
  );

  it.each([
    {
      mode: "cost" as const,
      total: [
        [
          { text: "$5,415.41", role: "title" },
          { text: "  636 sessions · API estimate", role: "muted" },
        ],
      ],
      header: /^Provider +Cost {2}Share {2}Tokens$/,
      anthropic: /^● Anthropic +\$5,011\.00 {2}92\.5% {3}12\.9B$/,
    },
    {
      mode: "tokens" as const,
      // Too wide for the list's 48 columns on one line.
      total: [
        [{ text: "13.4B tokens", role: "title" }],
        [{ text: "636 sessions · $5,415.41 API estimate", role: "muted" }],
      ],
      header: /^Provider +Tokens {2}Share {7}Cost$/,
      anthropic: /^● Anthropic +12\.9B {2}96\.3% {2}\$5,011\.00$/,
    },
  ])(
    "$mode mode: the total, then the providers as a table, the mode's amount first",
    (expected) => {
      const lines = usageView(t3Report(), {
        mode: expected.mode,
        breakdown: "model",
        width: 64,
      }).lines;
      expect(lines.slice(0, expected.total.length)).toEqual(expected.total);
      const [header, anthropic] = from(lines, "Provider");
      expect(textOf(header)).toMatch(expected.header);
      expect(textOf(anthropic)).toMatch(expected.anthropic);
      expect(textOf(anthropic)).toHaveLength(textOf(header).length);
      expect(anthropic.map((part) => part.role)).toEqual([
        "provider:0",
        "text",
        "value",
        "muted",
        "text",
      ]);
      // Each provider keeps its place in the report as its color slot.
      expect(from(lines, "OpenCode Zen")[0][0]).toEqual({ text: "● ", role: "provider:3" });
    },
  );

  it("drops the other amount from a narrow provider table before names get short", () => {
    const header = (width: number) => {
      const lines = usageView(t3Report(), { mode: "cost", breakdown: "model", width }).lines;
      return textOf(from(lines, "Provider")[0]);
    };
    expect(header(64)).toMatch(/^Provider +Cost {2}Share {2}Tokens$/);
    expect(header(34)).toMatch(/^Provider +Cost {2}Share$/);
  });

  it("draws a daily chart: top value, 0, one column per day, first/middle/last dates", () => {
    const lines = t3From("Daily cost", { width: 64 });
    const rows = lines.slice(1, 7);
    const bars = (row: UsageLine) => textOf(row.slice(1));
    // The report's models have no days, so no provider claims a part: the blocks are plain bar.
    for (const part of rows.flatMap((row) => row.slice(1))) {
      expect(part.role === "bar" || (part.role === "muted" && !part.text.trim())).toBe(true);
    }
    expect(rows[0][0]).toEqual({ text: "$1,232.63 ", role: "muted" });
    expect(rows.slice(1).map((row) => row[0].text.trim())).toEqual(["", "", "", "", ""]);
    // Only the Sep 26 spike reaches the top row; Sep 11 and Sep 15 cost nothing, so no block.
    expect(bars(rows[0]).trim()).toMatch(/^█+$/);
    expect(bars(rows[5])).toMatch(/^ +▁+ +▁/);
    // 0 sits on its own baseline under the bars, as wide as the bars.
    expect(lines[7]).toEqual([
      { text: "        0 ", role: "muted" },
      { text: "─".repeat(bars(rows[5]).length), role: "muted" },
    ]);
    expect(textOf(lines[8]).trim()).toMatch(/^Sep 11 +Sep 26 +Oct 10$/);
  });

  it("leaves a gap after each day when a day gets 3 cells or more", () => {
    const report = daysReport([
      [1, 100],
      [1, 100],
      [1, 100],
      [1, 100],
    ]);
    const lines = from(
      usageView(report, { mode: "cost", breakdown: "model", width: 40 }).lines,
      "Daily",
    );
    const top = textOf(lines[1].slice(1));
    expect(top).toMatch(/^(█+ )+$/u);
    expect(top.split(" ").filter(Boolean)).toHaveLength(4);
  });

  it("stacks each day by provider in the providers' colors, the first at the bottom", () => {
    const report = buildReport({
      sessions: 1,
      providers: [
        ["anthropic", 1, 4, 400],
        ["openai", 1, 2, 200],
      ],
      models: [
        ["anthropic", "claude-test", 4, 400],
        ["openai", "gpt-test", 2, 200],
      ],
      days: [
        [4, 400],
        [2, 200],
      ],
      tokens: { cachedInput: 0, uncachedInput: 600, output: 0 },
      costByType: { input: 6, cacheRead: 0, cacheWrite: 0, output: 0 },
      cacheSavingsUsd: 0,
    });
    const [first, second] = report.days.map((day) => day.date);
    report.models[0].days = [
      { date: first, costUsd: 3, tokens: 300, priced: true },
      { date: second, costUsd: 1, tokens: 100, priced: true },
    ];
    report.models[1].days = [
      { date: first, costUsd: 1, tokens: 100, priced: true },
      { date: second, costUsd: 1, tokens: 100, priced: true },
    ];
    // 6 rows of 8 eighths: Anthropic fills 36 of the first day's 48 and 12 of the second's 24.
    const lines = from(
      usageView(report, { mode: "cost", breakdown: "model", width: 40 }).lines,
      "Daily",
    );
    const blocks = (line: UsageLine) =>
      line
        .slice(1)
        .filter((part) => part.text.trim())
        .map((part) => ({ ...part, text: part.text.trim() }));
    const full = "█".repeat(15);
    expect(blocks(lines[1])).toEqual([{ text: full, role: "provider:1" }]);
    // A cell that both share: Anthropic's block, OpenAI's color above it.
    expect(blocks(lines[2])).toEqual([
      { text: "▄".repeat(15), role: "provider:0", back: "provider:1" },
    ]);
    expect(blocks(lines[5])).toEqual([
      { text: full, role: "provider:0" },
      { text: "▄".repeat(15), role: "provider:0", back: "provider:1" },
    ]);
    expect(blocks(lines[6])).toEqual([
      { text: full, role: "provider:0" },
      { text: full, role: "provider:0" },
    ]);
  });

  it("colors a shared cell's upper part with the provider that has the most of it", () => {
    const report = buildReport({
      sessions: 1,
      providers: [
        ["anthropic", 1, 63, 630],
        ["openai", 1, 4, 40],
        ["google", 1, 3, 30],
      ],
      models: [
        ["anthropic", "claude-test", 63, 630],
        ["openai", "gpt-test", 4, 40],
        ["google", "gemini-test", 3, 30],
      ],
      days: [
        [60, 600],
        [10, 100],
      ],
      tokens: { cachedInput: 0, uncachedInput: 700, output: 0 },
      costByType: { input: 70, cacheRead: 0, cacheWrite: 0, output: 0 },
      cacheSavingsUsd: 0,
    });
    const [first, second] = report.days.map((day) => day.date);
    report.models[0].days = [
      { date: first, costUsd: 60, tokens: 600, priced: true },
      { date: second, costUsd: 3, tokens: 30, priced: true },
    ];
    report.models[1].days = [{ date: second, costUsd: 4, tokens: 40, priced: true }];
    report.models[2].days = [{ date: second, costUsd: 3, tokens: 30, priced: true }];
    // The second day is one cell: Anthropic 2 eighths, OpenAI 4, Google 2.
    const lines = from(
      usageView(report, { mode: "cost", breakdown: "model", width: 40 }).lines,
      "Daily",
    );
    const bottom = lines[6]
      .slice(1)
      .filter((part) => part.text.trim())
      .map((part) => ({ ...part, text: part.text.trim() }));
    expect(bottom).toEqual([
      { text: "█".repeat(15), role: "provider:0" },
      { text: "▂".repeat(15), role: "provider:0", back: "provider:1" },
    ]);
  });

  it("puts the chart beside the list as tall as the list, at least 6 rows", () => {
    const lines = usageView(t3Report(), { mode: "cost", breakdown: "model", width: 110 }).lines;
    const rows = lines.filter((line) => line.some((part) => part.role === "bar"));
    expect(rows).toHaveLength(6);
    const tall = { ...t3Report(), providers: [...t3Report().providers, ...t3Report().providers] };
    const tallLines = usageView(tall, { mode: "cost", breakdown: "model", width: 110 }).lines;
    const tallRows = tallLines.filter((line) => line.some((part) => part.role === "bar"));
    // 2 + 1 + 8 list lines, less the chart's title, baseline and dates.
    expect(tallRows).toHaveLength(8);
  });

  it("charts many days a few to a column, with the year on dates outside this year", () => {
    const lines = from(
      usageView(longReport(), { mode: "cost", breakdown: "day", width: 64 }).lines,
      "per",
    );
    expect(lines[0]).toEqual([{ text: "Cost per 8 days", role: "heading" }]);
    expect(textOf(lines[8]).trim()).toMatch(/^Sep 6, 2025 +.+ +Oct 10$/);
  });

  it.each([
    {
      name: "the top label is wider than the total's (900 vs 1K tokens)",
      mode: "tokens" as const,
      days: Array.from({ length: 57 }, (_, index): Amounts => {
        return [0, index === 0 ? 900 : index === 56 ? 100 : 0];
      }),
    },
    {
      name: "the top label is wider than the total's (<$0.01 vs $0.01)",
      mode: "cost" as const,
      days: Array.from({ length: 54 }, (_, index): Amounts => [index === 0 ? 0.004 : 0.0001, 1000]),
    },
  ])("keeps every day on the chart when $name", ({ mode, days }) => {
    const lines = usageView(daysReport(days), { mode, breakdown: "model", width: 60 }).lines;
    const heading = lines.findIndex((line) => /^(Daily|Cost per|Tokens per) /.test(textOf(line)));
    // The first day is the highest, so its column is the one that reaches the top row.
    expect(lines[heading + 1][1].text).toMatch(/^█/);
  });

  it.each([
    {
      name: "a range of one day",
      report: { ...t3Report(), range: "today" as const, days: t3Report().days.slice(-1) },
    },
    {
      name: "nothing priced",
      report: {
        ...unpricedReport(),
        days: unpricedReport().days.map((day) => ({ ...day, costUsd: 0 })),
      },
    },
  ])("draws no chart for $name", ({ report }) => {
    expect(render(report, { mode: "cost", breakdown: "model", width: 120 }).join("\n")).not.toMatch(
      /Daily cost|[▁▂▃▄▅▆▇]/,
    );
  });

  it("shows the totals as label-over-value cells", () => {
    const lines = t3From("Totals", { width: 110 });
    expect(textOf(lines[1]).split(/ {2,}/).filter(Boolean)).toEqual([
      "Processed tokens",
      "Cached input",
      "Uncached input",
      "Output",
      "Cache savings",
    ]);
    expect(lines[2].map((part) => [part.text.trim(), part.role])).toEqual([
      ["13.4B", "value"],
      ["13.2B", "value"],
      ["146M", "value"],
      ["50.0M", "value"],
      ["$49,636.93", "value"],
    ]);
  });

  it.each([
    {
      mode: "cost" as const,
      title: "Cost by type",
      parts: {
        "part:input": 369.53,
        "part:cacheRead": 2749.39,
        "part:cacheWrite": 1716.2,
        "part:output": 580.29,
      },
      legend:
        "━━ Input $369.53   ━━ Cache read $2,749.39   ━━ Cache write $1,716.20   ━━ Output $580.29",
    },
    {
      mode: "tokens" as const,
      title: "Tokens by type",
      parts: {
        "part:input": 4,
        "part:cacheRead": 13_200,
        "part:cacheWrite": 142,
        "part:output": 49.97,
      },
      legend: "━━ Input 4.00M   ━━ Cache read 13.2B   ━━ Cache write 142M   ━━ Output 50.0M",
    },
  ])(
    "$title: one thin bar across the view in proportion, a space between parts, then a legend",
    ({ mode, title, parts, legend }) => {
      const lines = t3From(title, { mode, width: 110 });
      const bar = lines[1];
      expect(textOf(bar)).toHaveLength(110);
      const shown = bar.filter((part) => part.role !== "muted");
      expect(shown.map((part) => part.role)).toEqual(Object.keys(parts));
      expect(bar.filter((part) => part.role === "muted").map((part) => part.text)).toEqual([
        " ",
        " ",
        " ",
      ]);
      const total = Object.values(parts).reduce((sum, amount) => sum + amount, 0);
      for (const part of shown) {
        expect(part.text).toMatch(/^━+$/u);
        const exact = (parts[part.role as keyof typeof parts] / total) * 107;
        // A part above 0 always shows, even when it would round to nothing: the widest part
        // gives up a cell for each such part.
        const givenUp = shown.length - 1;
        expect(part.text.length).toBeGreaterThanOrEqual(Math.max(1, Math.floor(exact) - givenUp));
        expect(part.text.length).toBeLessThanOrEqual(Math.ceil(exact) + 1);
      }
      expect(textOf(lines[2])).toBe(legend);
      expect(lines[3]).toEqual([]);
      expect(lines[2][0]).toEqual({ text: "━━", role: "part:input" });
    },
  );

  it.each([
    {
      name: "cost by model",
      options: { mode: "cost" as const, breakdown: "model" as const },
      // These models have no cache numbers: "—" under Cache.
      header: /^# {2}Model +Cost {2}Share {2}Tokens {2}Cache {2}$/,
      rows: [
        /^1 {2}● claude-opus-5-5 {3}━+ {2}\$4,410\.41 {2}81\.4% {3}12\.5B {6}— ▸$/u,
        /^2 {2}● composer-2 {8}━+ +\$353\.05 {3}6\.5% {4}368M {6}— ▸$/u,
      ],
    },
    {
      name: "tokens by model",
      options: { mode: "tokens" as const, breakdown: "model" as const },
      header: /^# {2}Model +Tokens {2}Share {7}Cost {2}Cache {2}$/,
      rows: [
        /^1 {2}● claude-opus-5-5 {3}━+ {3}12\.5B {2}93\.3% {2}\$4,410\.41 {6}— ▸$/u,
        /^2 {2}● composer-2 {8}━+ +368M/u,
      ],
    },
    {
      name: "cost by day",
      options: { mode: "cost" as const, breakdown: "day" as const },
      header: /^ # {2}Day +Cost {2}Share {2}Tokens$/,
      rows: [/^ 1 {2}Sat, Oct 10 {2}━+ +\$903\.35 {2}16\.7% {3}2\.48B$/u, /^ 2 {2}Fri, Oct 9 /],
    },
  ])(
    "breakdown, $name: a bar of each amount, right-aligned numbers, the mode's amount first",
    ({ options, header, rows }) => {
      const lines = t3Section("Breakdown", options);
      const texts = lines.map(textOf);
      expect(texts[1]).toMatch(header);
      for (const [index, row] of rows.entries()) expect(texts[index + 2]).toMatch(row);
      for (const text of texts.slice(1)) expect(text).toHaveLength(80);
    },
  );

  it("breakdown bars: the biggest amount's bar is full, the others in proportion", () => {
    const lines = t3Section("Breakdown").slice(2);
    const bars = lines.map(
      (line) => line.find((part) => part.text.startsWith("━"))?.text.length ?? 0,
    );
    const full = bars[0];
    expect(full).toBeGreaterThan(20);
    // composer-2: $353.05 of the top model's $4,410.41.
    expect(bars[1]).toBe(Math.round((353.05 / 4410.41) * full));
    // exo-free has no price, so no cost and no bar.
    expect(bars.at(-1)).toBe(0);
    const opus = lines[0].find((part) => part.text.startsWith("━"));
    expect(opus?.role).toBe("provider:0");
  });

  it("text has no breakdown bars", () => {
    expect(usageText(t3Report(), { mode: "cost", breakdown: "model" })).not.toContain("━");
  });

  it("breakdown by model: provider colors, no price, and the provider for a shared model id", () => {
    const lines = t3From("Breakdown");
    expect(from(lines, "composer-2")[0][1]).toEqual({ text: "● ", role: "provider:1" });
    expect(from(lines, "openai/gpt-6.1")[0][1]).toEqual({ text: "● ", role: "provider:2" });
    expect(from(lines, "opencode/gpt-6.1")[0][1]).toEqual({ text: "● ", role: "provider:3" });
    expect(from(lines, "exo-free")[0]).toContainEqual({ text: "   no price", role: "muted" });
  });

  it("breakdown by day: newest first, used days only, $0.00 for free models, no price for unpriced", () => {
    const lines = section(
      usageView(unpricedReport(), { mode: "cost", breakdown: "day", width: 64 }).lines,
      "Breakdown",
    );
    const cells = (line: UsageLine) => textOf(line).replace(/━+/g, "").replace(/ {2,}/g, " | ");
    expect(lines.slice(2).map(cells)).toEqual([
      "1 | Thu, Oct 8 | no price | 0% | 1.00M",
      "2 | Wed, Oct 7 | $0.00 | 0% | 1.00M",
      "3 | Tue, Oct 6 | $1.50 | 100.0% | 3.00M",
    ]);
  });

  it.each([
    { name: "no unpriced tokens", report: longReport(), width: 80, note: null },
    {
      name: "a fifth unpriced",
      report: unpricedReport(),
      width: 64,
      note: [
        { text: "Unpriced tokens excluded: ", role: "muted" },
        { text: "20.0%", role: "warning" },
        { text: " (exo-free)", role: "muted" },
      ],
    },
    {
      name: "many unpriced models, cut to the width",
      report: {
        ...unpricedReport(),
        models: ["a-1", "b-2", "c-3", "d-4", "e-5"].map((modelID) => ({
          ...unpricedReport().models[2],
          modelID,
        })),
      },
      width: 40,
      note: [
        { text: "Unpriced tokens excluded: ", role: "muted" },
        { text: "20.0%", role: "warning" },
        { text: " (a-1, …)", role: "muted" },
      ],
    },
    {
      name: "a model priced for only some of its messages",
      report: {
        ...unpricedReport(),
        models: [{ ...unpricedReport().models[0], unpricedTokens: M }],
      },
      width: 64,
      note: [
        { text: "Unpriced tokens excluded: ", role: "muted" },
        { text: "20.0%", role: "warning" },
        { text: " (claude-test)", role: "muted" },
      ],
    },
  ])("one unpriced note line at the bottom: $name", ({ report, width, note }) => {
    const lines = usageView(report, { mode: "cost", breakdown: "model", width }).lines;
    const notes = lines.filter((line) => line.some((part) => part.role === "warning"));
    expect(notes).toEqual(note ? [note] : []);
    if (note) expect(lines.at(-1)).toBe(notes[0]);
  });

  it("breakdown by model: each model's cache hit under Cache, a low one in the warning color with ⚠", () => {
    const lines = section(
      usageView(cacheReport(), { mode: "cost", breakdown: "model", width: 80 }).lines,
      "Breakdown",
    );
    const texts = lines.map(textOf);
    // The ⚠ hangs after the percents, so they stay right-aligned under "Cache".
    expect(texts[1]).toMatch(/ {2}Tokens {2}Cache {4}$/);
    for (const text of texts.slice(1)) expect(text).toHaveLength(80);
    const cacheCells = lines.slice(2).map((line) => line.slice(-3, -1));
    expect(cacheCells).toEqual([
      [
        { text: "  91.0%", role: "good" },
        { text: "  ", role: "muted" },
      ],
      [
        { text: "  35.0%", role: "warning" },
        { text: " ⚠", role: "warning" },
      ],
      // No cache numbers.
      [
        { text: "      —", role: "muted" },
        { text: "  ", role: "muted" },
      ],
      // Under 200K input tokens: too few to call it good or low.
      [
        { text: "  13.3%", role: "muted" },
        { text: "  ", role: "muted" },
      ],
      // Half of the input cached.
      [
        { text: "  50.0%", role: "good" },
        { text: "  ", role: "muted" },
      ],
      // No input tokens.
      [
        { text: "      —", role: "muted" },
        { text: "  ", role: "muted" },
      ],
    ]);
  });

  it("writes a model's cache hit the same in the Cache column and in its details", () => {
    const report = cacheReport();
    const sonnet = report.models[1] as UsageModelRow;
    sonnet.tokensByType = { ...sonnet.tokensByType, input: 501_000, cacheRead: 499_000 };
    const column = section(
      usageView(report, { mode: "cost", breakdown: "model", width: 80 }).lines,
      "Breakdown",
    ).map(textOf);
    const detail = modelDetailView(report, sonnet, { mode: "cost", width: 80 }).map(textOf);

    expect(column.find((text) => text.includes("claude-sonnet-5"))).toMatch(/ {2}49\.9% ⚠ ▸$/);
    const grid = detail.findIndex((text) => text.includes("Cache hit"));
    expect(detail[grid + 1]?.trim()).toMatch(/ 49\.9%$/);
  });

  it("rounds a low cache hit down, so it never reads 50.0%", () => {
    const report = cacheReport();
    const sonnet = report.models[1] as UsageModelRow;
    // 49.96% of 1M input tokens read from the cache.
    sonnet.tokensByType = { ...sonnet.tokensByType, input: 500_400, cacheRead: 499_600 };
    const column = section(
      usageView(report, { mode: "cost", breakdown: "model", width: 80 }).lines,
      "Breakdown",
    ).map(textOf);
    const detail = modelDetailView(report, sonnet, { mode: "cost", width: 80 }).map(textOf);

    expect(column.find((text) => text.includes("claude-sonnet-5"))).toMatch(/ {2}49\.9% ⚠ ▸$/);
    const grid = detail.findIndex((text) => text.includes("Cache hit"));
    expect(detail[grid + 1]?.trim()).toMatch(/ 49\.9%$/);
  });

  it.each([
    { width: 80, cache: true, sonnet: "claude-sonnet-5" },
    // The names still get 8 columns.
    { width: 46, cache: true, sonnet: "claude-…" },
    { width: 45, cache: false, sonnet: "claude-sonnet-5" },
    { width: 40, cache: false, sonnet: "claude-son…" },
  ])(
    "drops the Cache column before names get shorter than 8 columns, and before Cost, Share and Tokens: $width",
    ({ width, cache, sonnet }) => {
      const lines = section(
        usageView(cacheReport(), { mode: "cost", breakdown: "model", width }).lines,
        "Breakdown",
      ).map(textOf);
      expect(lines[1]).toMatch(
        cache ? /Cost {2}Share {2}Tokens {2}Cache {4}$/ : /Share {2}Tokens {2}$/,
      );
      expect(lines[3]).toContain(` ${sonnet} `);
      for (const line of lines) expect(columnsIn(line)).toBeLessThanOrEqual(width);
    },
  );

  it("says so in one line when the range has no usage", () => {
    expect(usageView(EMPTY_REPORT, { mode: "cost", breakdown: "model", width: 80 }).lines).toEqual([
      [{ text: "No usage in this range.", role: "muted" }],
    ]);
  });
});

describe("provider names", () => {
  /**
   * Copilot under two ids (OpenCode lists only "github-copilot"), two providers only OpenCode
   * names, and one nobody names.
   */
  function namedReport(): UsageReport {
    const report = buildReport({
      range: "7d",
      sessions: 5,
      providers: [
        ["github-copilot", 1, 4, 4 * M],
        ["moonshotai", 1, 3, 3 * M],
        ["zai-coding-plan", 1, 2, 2 * M],
        ["copilot", 1, 1, 1 * M],
        ["ollama", 1, 0, 1 * M, 1 * M],
      ],
      models: [
        ["github-copilot", "claude-sonnet-5", 4, 4 * M],
        ["moonshotai", "kimi-k3", 3, 3 * M],
        ["zai-coding-plan", "glm-5.3", 2, 2 * M],
        ["copilot", "gpt-5", 1, 1 * M],
        ["ollama", "qwen3-coder:30b", 0, 1 * M, 1 * M],
      ],
      days: [[10, 11 * M, 1 * M]],
      tokens: { cachedInput: 0, uncachedInput: 11 * M, output: 0 },
      costByType: { input: 10, cacheRead: 0, cacheWrite: 0, output: 0 },
      cacheSavingsUsd: 0,
    });
    return {
      ...report,
      providerNames: {
        "github-copilot": "GitHub Copilot",
        moonshotai: "Moonshot AI",
        "zai-coding-plan": "Z.AI Coding Plan",
      },
    };
  }

  /** The provider table's names, top to bottom. */
  const names = (lines: string[]) =>
    lines
      .slice(lines.findIndex((line) => line.startsWith("Provider")) + 1)
      .slice(0, 5)
      .map((line) => line.slice(2).split(/ {2,}/)[0]);

  it("names a provider as OpenCode does, else by the plugin's label, else by its id", () => {
    const expected = ["GitHub Copilot", "Moonshot AI", "Z.AI Coding Plan", "Copilot", "ollama"];
    const view = render(namedReport(), { mode: "cost", breakdown: "model", width: 80 });
    const text = usageText(namedReport(), { mode: "cost", breakdown: "model" }).split("\n");

    expect(names(view)).toEqual(expected);
    expect(names(text)).toEqual(expected);
  });

  it("names the provider in a model's details", () => {
    const report = namedReport();
    const detail = (index: number) =>
      textOf(modelDetailView(report, report.models[index], { mode: "cost", width: 80 })[1]);

    expect(detail(0)).toMatch(/^GitHub Copilot · /);
    expect(detail(1)).toMatch(/^Moonshot AI · /);
    expect(detail(3)).toMatch(/^Copilot · /);
    expect(detail(4)).toMatch(/^ollama · /);
  });
});

describe("usageText", () => {
  it("is plain text of at most 64 columns, with a range title, no chart and 10 breakdown rows", () => {
    const text = usageText(t3Report(), { mode: "cost", breakdown: "day", width: 200 });
    const lines = text.split("\n");
    expect(lines.slice(0, 2)).toEqual([
      "Usage · 30 days",
      "$5,415.41  636 sessions · API estimate",
    ]);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(64);
    expect(text).not.toMatch(/Daily cost|[▁▂▃▄▅▆▇]/);
    expect(text).toContain("▒ Input $369.53   ░ Cache read $2,749.39");
    expect(lines.filter((line) => /^ ?\d+ {2}\w{3}, /.test(line))).toHaveLength(10);
    expect(lines.slice(-3)).toEqual([
      "and 18 more",
      "",
      "Unpriced tokens excluded: <0.1% (exo-free)",
    ]);
  });

  it.each([
    { report: { ...EMPTY_REPORT, range: "session" as const }, title: "Usage · This session" },
    {
      report: {
        ...EMPTY_REPORT,
        range: "between" as const,
        sinceMs: new Date(2025, 11, 20).getTime(),
        untilMs: new Date(2026, 0, 5, 23, 59).getTime(),
      },
      title: "Usage · Dec 20, 2025 to Jan 5",
    },
  ])("titles the range: $title", ({ report, title }) => {
    expect(usageText(report, { mode: "tokens", breakdown: "model" })).toBe(
      `${title}\nNo usage in this range.`,
    );
  });
});

describe("rangeDates", () => {
  it.each([
    { name: "seven days", since: new Date(2026, 9, 4), until: NOW, dates: "Oct 4 – Oct 10" },
    { name: "one day", since: new Date(2026, 9, 10), until: NOW, dates: "Oct 10" },
    {
      name: "days that start last year",
      since: new Date(2025, 11, 20),
      until: new Date(2026, 0, 5, 23, 59),
      dates: "Dec 20, 2025 – Jan 5",
    },
    { name: "this session", since: undefined, until: undefined, dates: undefined },
  ])("names the days of $name", ({ since, until, dates }) => {
    const report = { ...EMPTY_REPORT, sinceMs: since?.valueOf(), untilMs: until?.valueOf() };
    expect(rangeDates(report)).toBe(dates);
  });
});

describe("modelDetailView", () => {
  /** The T3 report with claude-opus-5-5 split by type and spread over its days, like T3's. */
  function opusReport(): UsageReport {
    const report = t3Report();
    const [opus] = report.models;
    report.models[0] = {
      ...opus,
      costByType: { input: 0.52, cacheRead: 2436, cacheWrite: 1450, output: 523.89 },
      tokensByType: {
        input: 0.146 * M,
        cacheRead: 12_180 * M,
        cacheWrite: 290 * M,
        output: 29.854 * M,
      },
      days: report.days
        .filter((day) => day.costUsd > 0)
        .map((day) => ({ date: day.date, costUsd: day.costUsd * 0.8, tokens: day.tokens * 0.9 })),
    };
    return report;
  }

  const cells = (line: UsageLine) => textOf(line).split(/ {2,}/).filter(Boolean);

  it("shows the name, provider and share, four numbers, the model's chart and both by-type bars", () => {
    const report = opusReport();
    const lines = modelDetailView(report, report.models[0], { mode: "cost", width: 83 });

    expect(lines[0]).toEqual([
      { text: "● ", role: "provider:0" },
      { text: "claude-opus-5-5", role: "title" },
    ]);
    expect(lines[1]).toEqual([{ text: "Anthropic · 81.4% of cost", role: "muted" }]);
    expect(cells(lines[3])).toEqual(["Cost", "Tokens", "Per 1M tokens", "Cache hit"]);
    // Cache hit: cache reads ÷ all input tokens (input, cache reads and cache writes), 97.67%
    // rounded down.
    expect(cells(lines[4])).toEqual(["$4,410.41", "12.5B", "$0.35", "97.6%"]);
    const chart = from(lines, "Daily cost");
    // The model's days are its provider's part, so its chart is in its provider's color.
    const blocks = chart
      .slice(1, 6)
      .flatMap((row) => row.slice(1).filter((part) => part.text.trim()));
    expect(new Set(blocks.map((part) => part.role))).toEqual(new Set(["provider:0"]));
    expect(textOf(chart[7]).trim()).toMatch(/^Sep 11 +Sep 26 +Oct 10$/);
    const byType = from(lines, "Cost by type");
    expect(textOf(byType[0])).toMatch(/^Cost by type +Tokens by type$/);
    expect(textOf(byType[2])).toMatch(
      /^━━ Input \$0\.52 {3}━━ Cache read \$2,436\.00 +━━ Input 146K/u,
    );
  });

  it.each([
    {
      name: "without a price: no cost numbers, no cost by type",
      model: "exo-free",
      mode: "cost" as const,
      share: "OpenCode Zen · 0% of cost",
      numbers: ["no price", "970K", "no price", "—"],
      headings: ["Tokens by type"],
    },
    {
      name: "in tokens mode: the share of tokens and a token chart",
      model: "claude-opus-5-5",
      mode: "tokens" as const,
      share: "Anthropic · 93.3% of tokens",
      numbers: ["$4,410.41", "12.5B", "$0.35", "97.6%"],
      headings: ["Daily tokens", "Cost by type   Tokens by type"],
    },
  ])("model $name", ({ model, mode, share, numbers, headings }) => {
    const report = opusReport();
    const row = report.models.find((item) => item.modelID === model)!;
    const lines = modelDetailView(report, row, { mode, width: 83 });

    expect(textOf(lines[1])).toBe(share);
    expect(cells(lines[4])).toEqual(numbers);
    const headingTexts = lines
      .filter((line) => line[0]?.role === "heading")
      .map((line) => textOf(line).replace(/ {3,}/g, "   "));
    expect(headingTexts).toEqual(headings);
  });

  it("stacks cost by type over tokens by type when both don't fit side by side", () => {
    const report = opusReport();
    const lines = modelDetailView(report, report.models[0], { mode: "cost", width: 50 });
    const headings = lines.filter((line) => line[0]?.role === "heading").map(textOf);
    expect(headings).toEqual(["Daily cost", "Cost by type", "Tokens by type"]);
  });

  it.each([10, 32, 50, 83, 120])("fits every line in %i columns", (width) => {
    const report = opusReport();
    for (const model of report.models) {
      for (const mode of ["cost", "tokens"] as const) {
        for (const line of modelDetailView(report, model, { mode, width })) {
          expect(columnsIn(textOf(line))).toBeLessThanOrEqual(width);
        }
      }
    }
  });
});

describe("breakdownModels and usageView's line ids", () => {
  it.each(["cost", "tokens"] as const)(
    "puts the Breakdown heading at breakdownAt and each %s model at its modelLines line, in order",
    (mode) => {
      const report = t3Report();
      const models = breakdownModels(report, mode);
      const { lines, breakdownAt, modelLines } = usageView(report, {
        mode,
        breakdown: "model",
        width: 80,
      });

      expect(textOf(lines[breakdownAt as number])).toBe("Breakdown");
      expect(modelLines).toHaveLength(models.length);
      for (const [index, line] of modelLines.entries()) {
        const model = models[index];
        const provider = report.providers.findIndex((item) => item.providerID === model.providerID);
        expect(textOf(lines[line])).toContain(model.modelID);
        expect(lines[line]).toContainEqual({ text: "● ", role: `provider:${provider}` });
      }
    },
  );

  it("has no model lines by day, and no breakdown without usage", () => {
    const byDay = usageView(t3Report(), { mode: "cost", breakdown: "day", width: 80 });
    expect([textOf(byDay.lines[byDay.breakdownAt as number]), byDay.modelLines]).toEqual([
      "Breakdown",
      [],
    ]);
    const empty = usageView(daysReport([]), { mode: "cost", breakdown: "model", width: 80 });
    expect([empty.breakdownAt, empty.modelLines]).toEqual([undefined, []]);
  });
});
