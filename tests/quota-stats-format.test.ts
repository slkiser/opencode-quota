import { describe, expect, it } from "vitest";
import { formatQuotaStatsReport } from "../src/lib/quota-stats-format.js";
import type { AggregateResult } from "../src/lib/quota-stats.js";

function makeEmptyResult(overrides?: Partial<AggregateResult>): AggregateResult {
  return {
    window: { sinceMs: 0, untilMs: 1 },
    totals: {
      priced: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
      unknown: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
      unpriced: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
      costUsd: 0,
      messageCount: 0,
      sessionCount: 0,
    },
    bySourceProvider: [],
    bySourceModel: [],
    byModel: [],
    bySession: [],
    unknown: [],
    unpriced: [],
    ...overrides,
  };
}

describe("formatQuotaStatsReport (markdown)", () => {
  it("renders a markdown table for models with separator rows", () => {
    const r = makeEmptyResult({
      totals: {
        priced: { input: 1000, output: 2000, reasoning: 0, cache_read: 0, cache_write: 0 },
        unknown: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
        unpriced: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
        costUsd: 1.23,
        messageCount: 2,
        sessionCount: 1,
      },
      bySourceModel: [
        {
          sourceProviderID: "opencode",
          sourceModelID: "claude-opus-4-5-high",
          tokens: { input: 1000, output: 2000, reasoning: 0, cache_read: 0, cache_write: 0 },
          costUsd: 1.23,
          messageCount: 2,
        },
        {
          sourceProviderID: "cursor",
          sourceModelID: "gpt-5.2",
          tokens: { input: 10, output: 20, reasoning: 0, cache_read: 0, cache_write: 0 },
          costUsd: 0.01,
          messageCount: 1,
        },
      ],
    });

    const out = formatQuotaStatsReport({
      title: "Tokens used (Last 24 Hours) (/tokens_daily)",
      result: r,
      topModels: 99,
    });
    expect(out).toContain("# Tokens used (Last 24 Hours) (/tokens_daily)");
    expect(out).toContain("## Models");
    expect(out).toContain("| Source");
    // blank separator row between sources
    expect(out).toContain("|          |");
    expect(out).toContain("OpenCode");
    expect(out).toContain("Cursor");
  });

  it("omits Reasoning column when all reasoning is zero", () => {
    const r = makeEmptyResult({
      totals: {
        priced: { input: 1, output: 1, reasoning: 0, cache_read: 0, cache_write: 0 },
        unknown: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
        unpriced: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
        costUsd: 0,
        messageCount: 1,
        sessionCount: 1,
      },
      bySourceModel: [
        {
          sourceProviderID: "opencode",
          sourceModelID: "gpt-5.2",
          tokens: { input: 1, output: 1, reasoning: 0, cache_read: 0, cache_write: 0 },
          costUsd: 0,
          messageCount: 1,
        },
      ],
    });

    const out = formatQuotaStatsReport({
      title: "Tokens used (Last 24 Hours) (/tokens_daily)",
      result: r,
      topModels: 99,
    });
    expect(out).not.toContain("Reasoning");
  });

  it("sessionOnly mode hides Window/Sessions columns and Top Sessions section", () => {
    const r = makeEmptyResult({
      totals: {
        priced: { input: 100, output: 200, reasoning: 0, cache_read: 0, cache_write: 0 },
        unknown: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
        unpriced: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
        costUsd: 0.5,
        messageCount: 3,
        sessionCount: 1,
      },
      bySourceModel: [
        {
          sourceProviderID: "opencode",
          sourceModelID: "claude-opus-4-5-high",
          tokens: { input: 100, output: 200, reasoning: 0, cache_read: 0, cache_write: 0 },
          costUsd: 0.5,
          messageCount: 3,
        },
      ],
      bySession: [
        {
          sessionID: "ses_123",
          title: "Test Session",
          tokens: { input: 100, output: 200, reasoning: 0, cache_read: 0, cache_write: 0 },
          costUsd: 0.5,
          messageCount: 3,
        },
      ],
    });

    const out = formatQuotaStatsReport({
      title: "Tokens used (Current Session) (/tokens_session)",
      result: r,
      sessionOnly: true,
    });

    // Title should be present
    expect(out).toContain("# Tokens used (Current Session) (/tokens_session)");

    // Summary table should NOT have Window or Sessions columns
    expect(out).not.toContain("| Window");
    expect(out).not.toContain("| Sessions");

    // Summary table SHOULD have Messages, Tokens, Cost columns
    expect(out).toContain("Messages");
    expect(out).toContain("Tokens");
    expect(out).toContain("Cost");

    // Top Sessions section should NOT be present
    expect(out).not.toContain("## Top Sessions");
  });

  it("standard mode includes Window/Sessions columns and Top Sessions section", () => {
    const r = makeEmptyResult({
      totals: {
        priced: { input: 100, output: 200, reasoning: 0, cache_read: 0, cache_write: 0 },
        unknown: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
        unpriced: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
        costUsd: 0.5,
        messageCount: 3,
        sessionCount: 1,
      },
      bySourceModel: [
        {
          sourceProviderID: "opencode",
          sourceModelID: "claude-opus-4-5-high",
          tokens: { input: 100, output: 200, reasoning: 0, cache_read: 0, cache_write: 0 },
          costUsd: 0.5,
          messageCount: 3,
        },
      ],
      bySession: [
        {
          sessionID: "ses_123",
          title: "Test Session",
          tokens: { input: 100, output: 200, reasoning: 0, cache_read: 0, cache_write: 0 },
          costUsd: 0.5,
          messageCount: 3,
        },
      ],
    });

    const out = formatQuotaStatsReport({
      title: "Tokens used (Last 24 Hours) (/tokens_daily)",
      result: r,
      sessionOnly: false, // explicit false, same as omitting
    });

    // Summary table SHOULD have Window and Sessions columns
    expect(out).toContain("Window");
    expect(out).toContain("Sessions");

    // Top Sessions section SHOULD be present
    expect(out).toContain("## Top Sessions");
    // Marker column should be named and not render as an empty header
    expect(out).toContain("| Current");
    expect(out).toContain("| Session");
  });
});
