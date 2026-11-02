import { describe, expect, it } from "vite-plus/test";
import type { UsageByType, UsageModelRow, UsageReport } from "../src/core/usage.js";
import {
  breakdownRows,
  chartMax,
  modelDetail,
  niceMax,
  typeShares,
  usageProviders,
  usageQuery,
  usageView,
} from "../src/gui/usage-model.js";

const byType = (input: number, cacheRead: number, cacheWrite: number, output: number) =>
  ({ input, cacheRead, cacheWrite, output }) satisfies UsageByType;

function model(
  providerID: string,
  modelID: string,
  costUsd: number,
  tokensByType: UsageByType,
  days: Array<Omit<UsageModelRow["days"][number], "priced"> & { priced?: boolean }>,
  priced = true,
): UsageModelRow {
  const tokens =
    tokensByType.input + tokensByType.cacheRead + tokensByType.cacheWrite + tokensByType.output;
  return {
    providerID,
    modelID,
    priced,
    costUsd,
    costShare: 0,
    tokens,
    tokenShare: 0,
    unpricedTokens: priced ? 0 : tokens,
    costByType: priced ? byType(costUsd / 2, costUsd / 4, 0, costUsd / 4) : byType(0, 0, 0, 0),
    tokensByType,
    days: days.map((day) => ({ priced, ...day })),
  };
}

/** Anthropic: one model, $6, 1,000 tokens. OpenAI: a priced model ($2, 3,000 tokens) and an unpriced one (1,000). */
const MODELS = [
  model("anthropic", "opus", 6, byType(100, 800, 0, 100), [
    { date: "2026-10-25", costUsd: 2, tokens: 400 },
    { date: "2026-10-27", costUsd: 4, tokens: 600 },
  ]),
  model("openai", "sol", 2, byType(1_000, 500, 500, 1_000), [
    { date: "2026-10-26", costUsd: 2, tokens: 3_000 },
  ]),
  model(
    "openai",
    "free",
    0,
    byType(500, 0, 0, 500),
    [{ date: "2026-10-27", costUsd: 0, tokens: 1_000 }],
    false,
  ),
];

const REPORT: UsageReport = {
  range: "7d",
  sinceMs: new Date(2026, 9, 25).getTime(),
  untilMs: new Date(2026, 9, 27, 12).getTime(),
  generatedAtMs: new Date(2026, 9, 27, 12).getTime(),
  totals: {
    costUsd: 8,
    sessions: 5,
    tokens: { processed: 5_000, cachedInput: 1_300, uncachedInput: 2_100, output: 1_600 },
    tokensByType: byType(1_600, 1_300, 500, 1_600),
    costByType: byType(4, 2, 0, 2),
    cacheSavingsUsd: 1.5,
    unpricedTokens: 1_000,
    unpricedShare: 0.2,
  },
  providers: [
    {
      providerID: "anthropic",
      sessions: 2,
      costUsd: 6,
      costShare: 0.75,
      tokens: 1_000,
      tokenShare: 0.2,
      unpricedTokens: 0,
    },
    {
      providerID: "openai",
      sessions: 4,
      costUsd: 2,
      costShare: 0.25,
      tokens: 4_000,
      tokenShare: 0.8,
      unpricedTokens: 1_000,
    },
  ],
  models: MODELS,
  days: ["2026-10-25", "2026-10-26", "2026-10-27"].map((date) => ({
    date,
    costUsd: 0,
    costShare: 0,
    tokens: 0,
    tokenShare: 0,
    unpricedTokens: 0,
  })),
  providerNames: { anthropic: "Anthropic", openai: "OpenAI" },
};

describe("GUI usage question", () => {
  const base = { range: "7d", scope: "all", from: "2026-10-01", to: "2026-10-27" } as const;

  it("asks for the range, or the session with or without its subagents", () => {
    expect(usageQuery(base)).toEqual({ range: "7d" });
    expect(usageQuery({ ...base, scope: "tree", sessionID: "ses_1" })).toEqual({
      range: "session",
      sessionID: "ses_1",
    });
    expect(usageQuery({ ...base, scope: "session", sessionID: "ses_1" })).toEqual({
      range: "session",
      sessionID: "ses_1",
      subagents: false,
    });
    // No session on screen: nothing to ask.
    expect(usageQuery({ ...base, scope: "session" })).toBeUndefined();
  });

  it("asks for Between only with two dates in order", () => {
    expect(usageQuery({ ...base, range: "between" })).toEqual({
      range: "between",
      from: "2026-10-01",
      to: "2026-10-27",
    });
    expect(usageQuery({ ...base, range: "between", from: "2026-10-28" })).toBeUndefined();
    expect(usageQuery({ ...base, range: "between", to: "" })).toBeUndefined();
  });
});

describe("GUI usage view", () => {
  it("totals every provider in cost, with shares, token kinds and cache savings", () => {
    const view = usageView(REPORT, "cost", undefined);
    expect(view.total).toBe(8);
    expect(view.sessions).toBe(5);
    expect(view.providers.map((row) => [row.name, row.share, row.color])).toEqual([
      ["Anthropic", 0.75, 0],
      ["OpenAI", 0.25, 1],
    ]);
    expect(view.tokens).toEqual({
      processed: 5_000,
      cachedInput: 1_300,
      uncachedInput: 2_100,
      output: 1_600,
    });
    expect(view.byType).toEqual(byType(4, 2, 0, 2));
    expect(view.cacheSavingsUsd).toBe(1.5);
    expect(view.unpricedShare).toBe(0.2);
  });

  it("charts each provider's days over every day of the report", () => {
    const { chart } = usageView(REPORT, "tokens", undefined);
    expect(chart.dates).toEqual(["2026-10-25", "2026-10-26", "2026-10-27"]);
    expect(chart.series.map((series) => [series.providerID, series.values])).toEqual([
      ["anthropic", [400, 0, 600]],
      ["openai", [0, 3_000, 1_000]],
    ]);
    expect(chartMax(chart)).toBe(3_000);
  });

  it("lists providers by tokens in Tokens", () => {
    const view = usageView(REPORT, "tokens", undefined);
    expect(view.total).toBe(5_000);
    expect(view.providers.map((row) => [row.providerID, row.share])).toEqual([
      ["openai", 0.8],
      ["anthropic", 0.2],
    ]);
  });

  it("shows one provider's own numbers when it is picked, keeping its color", () => {
    const view = usageView(REPORT, "cost", "openai");
    expect(view.total).toBe(2);
    expect(view.sessions).toBe(4);
    expect(view.providers.map((row) => [row.providerID, row.share, row.color])).toEqual([
      ["openai", 1, 1],
    ]);
    expect(view.tokens.processed).toBe(4_000);
    // The report's cache savings cover every provider.
    expect(view.cacheSavingsUsd).toBeUndefined();
    expect(view.chart.series.map((series) => series.providerID)).toEqual(["openai"]);
  });

  it("lists the providers it can filter by, with OpenCode's names", () => {
    expect(usageProviders(REPORT)).toEqual([
      ["anthropic", "Anthropic"],
      ["openai", "OpenAI"],
    ]);
  });
});

describe("GUI usage breakdown", () => {
  it("lists models most first, with shares, cache hits and the unpriced ones", () => {
    const rows = breakdownRows(REPORT, "tokens", "model", undefined);
    expect(rows.map((row) => [row.name, row.value, row.priced])).toEqual([
      ["sol", 3_000, true],
      ["opus", 1_000, true],
      ["free", 1_000, false],
    ]);
    expect(rows[0]?.share).toBe(0.6);
    // opus read 800 of its 900 input tokens from the cache.
    expect(rows[1]?.cache?.text).toBe("88%");
    // free has no cache numbers.
    expect(rows[2]?.cache).toBeUndefined();
  });

  it("lists providers, marking one whose tokens all lack a price", () => {
    const rows = breakdownRows(REPORT, "cost", "provider", undefined);
    expect(rows.map((row) => [row.key, row.value, row.share, row.priced])).toEqual([
      ["anthropic", 6, 0.75, true],
      ["openai", 2, 0.25, true],
    ]);
  });

  it("lists days with tokens, newest first, for the picked provider", () => {
    const rows = breakdownRows(REPORT, "tokens", "day", "openai");
    expect(rows.map((row) => [row.name, row.tokens, row.costUsd])).toEqual([
      ["2026-10-27", 1_000, 0],
      ["2026-10-26", 3_000, 2],
    ]);
    expect(rows[1]?.share).toBeCloseTo(0.75);
  });

  it("marks a day priced only when a model with a price used tokens on it", () => {
    const priced = (providerID: string | undefined) =>
      breakdownRows(REPORT, "cost", "day", providerID).map((row) => [row.name, row.priced]);
    // On the 27th, OpenAI used only its model without a price.
    expect(priced("openai")).toEqual([
      ["2026-10-27", false],
      ["2026-10-26", true],
    ]);
    expect(priced(undefined)).toEqual([
      ["2026-10-27", true],
      ["2026-10-26", true],
      ["2026-10-25", true],
    ]);
  });

  it("marks each day of a model priced by its own prompts, when the price depends on prompt size", () => {
    // Cursor's grok: the 25th's prompt was over 200k tokens, without a price; the 26th's was priced.
    const grok = {
      ...model("cursor", "grok", 3, byType(301_000, 0, 0, 0), [
        { date: "2026-10-25", costUsd: 0, tokens: 300_000, priced: false },
        { date: "2026-10-26", costUsd: 3, tokens: 1_000, priced: true },
      ]),
      unpricedTokens: 300_000,
    };
    const report: UsageReport = { ...REPORT, models: [grok] };
    expect(
      breakdownRows(report, "cost", "day", "cursor").map((row) => [row.name, row.priced]),
    ).toEqual([
      ["2026-10-26", true],
      ["2026-10-25", false],
    ]);
  });

  it("gives a model's popup its share, cost per million tokens and own chart", () => {
    const detail = modelDetail(REPORT, "cost", "anthropic\nopus", undefined);
    expect(detail?.share).toBe(0.75);
    expect(detail?.perMillionUsd).toBe(6_000);
    expect(detail?.chart.series.map((series) => series.values)).toEqual([[2, 0, 4]]);
    expect(modelDetail(REPORT, "cost", "openai\nfree", undefined)?.perMillionUsd).toBeUndefined();
    expect(modelDetail(REPORT, "cost", "nobody\nnothing", undefined)).toBeUndefined();
  });
});

describe("GUI chart and by-type helpers", () => {
  it("rounds the axis up to 1, 2 or 5 times a power of ten", () => {
    expect([0, 0.3, 1, 1.2, 3_000, 7_100].map(niceMax)).toEqual([1, 0.5, 1, 2, 5_000, 10_000]);
  });

  it("splits the by-type values into shares", () => {
    expect(typeShares(byType(1, 2, 0, 1)).map((part) => [part.type, part.share])).toEqual([
      ["input", 0.25],
      ["cacheRead", 0.5],
      ["cacheWrite", 0],
      ["output", 0.25],
    ]);
    expect(typeShares(byType(0, 0, 0, 0)).every((part) => part.share === 0)).toBe(true);
  });
});
