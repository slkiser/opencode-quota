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

function makeSessionRow(overrides?: Partial<AggregateResult["bySession"][number]>): AggregateResult["bySession"][number] {
  return {
    sessionID: "ses_default",
    title: "Default Session",
    tokens: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
    costUsd: 0,
    messageCount: 0,
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
    expect(out).toMatch(/^# Tokens used \(Last 24 Hours\) \(\/tokens_daily\) \d{2}:\d{2} \d{2}\/\d{2}\/\d{4}\n\n/);
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
    expect(out).toMatch(/^# Tokens used \(Current Session\) \(\/tokens_session\) \d{2}:\d{2} \d{2}\/\d{2}\/\d{4}\n\n/);

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

  it("session_tree mode renders a session breakdown and counts zero-usage descendants", () => {
    const r = makeEmptyResult({
      totals: {
        priced: { input: 100, output: 200, reasoning: 0, cache_read: 0, cache_write: 0 },
        unknown: { input: 5, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
        unpriced: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
        costUsd: 0.5,
        messageCount: 4,
        sessionCount: 2,
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
          sessionID: "ses_parent",
          title: "Parent Session",
          tokens: { input: 100, output: 200, reasoning: 0, cache_read: 0, cache_write: 0 },
          costUsd: 0.5,
          messageCount: 3,
        },
        {
          sessionID: "ses_child",
          title: "Child Session",
          tokens: { input: 5, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
          costUsd: 0,
          messageCount: 1,
        },
      ],
    });

    const out = formatQuotaStatsReport({
      title: "Tokens used (Current Session Tree) (/tokens_session_all)",
      result: r,
      reportKind: "session_tree",
      sessionTree: {
        rootSessionID: "ses_parent",
        nodes: [
          { sessionID: "ses_parent", title: "Parent Session", depth: 0 },
          {
            sessionID: "ses_child",
            parentID: "ses_parent",
            title: "Child Session",
            depth: 1,
          },
          {
            sessionID: "ses_grandchild",
            parentID: "ses_child",
            title: "Grandchild Session",
            depth: 2,
          },
        ],
      },
    });

    expect(out).toContain("| Messages");
    expect(out).toContain("| Sessions");
    expect(out).toContain("## Session Tree");
    expect(out).toContain("current");
    expect(out).toContain("child");
    expect(out).toContain("grandchild");
    expect(out).toContain("ses_parent");
    expect(out).toContain("ses_grandchild");
    expect(out).toContain("$0.00");
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

  it("does not render a concrete focus session id when the current session is outside the selected window", () => {
    const out = formatQuotaStatsReport({
      title: "Tokens used (Last 7 Days) (/tokens_weekly)",
      result: makeEmptyResult({
        bySession: [
          makeSessionRow({
            sessionID: "ses_visible",
            title: "Visible Session",
            tokens: { input: 100, output: 200, reasoning: 0, cache_read: 0, cache_write: 0 },
            costUsd: 0.75,
            messageCount: 4,
          }),
        ],
      }),
      focusSessionID: "ses_missing",
    });

    expect(out).toContain("(current session not in selected window)");
    expect(out).toContain("ses_visible");
    expect(out).not.toContain("ses_missing");
    expect(out).not.toContain("No current session");
  });

  it("does not render a concrete focus session id when it has no token usage in the selected window", () => {
    const out = formatQuotaStatsReport({
      title: "Tokens used (Last 7 Days) (/tokens_weekly)",
      result: makeEmptyResult({
        bySession: [
          makeSessionRow({
            sessionID: "ses_zero",
            title: "Zero Session",
            messageCount: 2,
          }),
          makeSessionRow({
            sessionID: "ses_visible",
            title: "Visible Session",
            tokens: { input: 50, output: 75, reasoning: 0, cache_read: 0, cache_write: 0 },
            costUsd: 0.25,
            messageCount: 3,
          }),
        ],
      }),
      focusSessionID: "ses_zero",
    });

    expect(out).toContain("(current session has no token usage in selected window)");
    expect(out).toContain("ses_visible");
    expect(out).not.toContain("ses_zero");
  });

  it("filters zero-token session rows from top sessions", () => {
    const out = formatQuotaStatsReport({
      title: "Tokens used (Last 7 Days) (/tokens_weekly)",
      result: makeEmptyResult({
        bySession: [
          makeSessionRow({
            sessionID: "ses_zero",
            title: "Zero Session",
            messageCount: 2,
          }),
          makeSessionRow({
            sessionID: "ses_visible",
            title: "Visible Session",
            tokens: { input: 10, output: 20, reasoning: 0, cache_read: 0, cache_write: 0 },
            costUsd: 0.05,
            messageCount: 1,
          }),
        ],
      }),
    });

    expect(out).toContain("ses_visible");
    expect(out).not.toContain("ses_zero");
  });

  it("shows provider candidates for ambiguous unknown pricing rows", () => {
    const r = makeEmptyResult({
      totals: {
        priced: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
        unknown: { input: 10, output: 20, reasoning: 0, cache_read: 0, cache_write: 0 },
        unpriced: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
        costUsd: 0,
        messageCount: 1,
        sessionCount: 1,
      },
      unknown: [
        {
          key: {
            sourceProviderID: "opencode",
            sourceModelID: "foo-model",
            mappedModel: "foo-model",
            providerCandidates: ["openai", "anthropic"],
          },
          tokens: { input: 10, output: 20, reasoning: 0, cache_read: 0, cache_write: 0 },
          messageCount: 1,
        },
      ],
    });

    const out = formatQuotaStatsReport({
      title: "Tokens used (Last 24 Hours) (/tokens_daily)",
      result: r,
    });

    expect(out).toContain("candidates: openai,anthropic");
  });

  it("locks the full markdown report layout for the shared report-document renderer", () => {
    const out = formatQuotaStatsReport({
      title: "Tokens used (Last 24 Hours) (/tokens_daily)",
      generatedAtMs: Date.UTC(2026, 0, 15, 12, 0, 0),
      result: makeEmptyResult({
        window: {},
        totals: {
          priced: { input: 1000, output: 2000, reasoning: 0, cache_read: 0, cache_write: 0 },
          unknown: { input: 10, output: 20, reasoning: 0, cache_read: 0, cache_write: 0 },
          unpriced: { input: 30, output: 40, reasoning: 0, cache_read: 0, cache_write: 0 },
          costUsd: 1.23,
          messageCount: 6,
          sessionCount: 2,
        },
        bySourceModel: [
          {
            sourceProviderID: "opencode",
            sourceModelID: "claude-opus-4-5-high",
            tokens: { input: 1000, output: 2000, reasoning: 0, cache_read: 0, cache_write: 0 },
            costUsd: 1.23,
            messageCount: 2,
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
        unpriced: [
          {
            key: {
              sourceProviderID: "cursor",
              sourceModelID: "foo-model",
              mappedProvider: "openai",
              mappedModel: "foo-model",
              reason: "snapshot missing model",
            },
            tokens: { input: 30, output: 40, reasoning: 0, cache_read: 0, cache_write: 0 },
            messageCount: 1,
          },
        ],
        unknown: [
          {
            key: {
              sourceProviderID: "opencode",
              sourceModelID: "bar-model",
              mappedProvider: "openai",
              mappedModel: "bar-model",
              providerCandidates: ["openai", "anthropic"],
            },
            tokens: { input: 10, output: 20, reasoning: 0, cache_read: 0, cache_write: 0 },
            messageCount: 1,
          },
        ],
      }),
    });

    const [heading, blank, ...body] = out.split("\n");
    expect(heading).toMatch(/^# Tokens used \(Last 24 Hours\) \(\/tokens_daily\) \d{2}:\d{2} \d{2}\/\d{2}\/\d{4}$/);
    expect(blank).toBe("");

    expect(body.join("\n")).toMatchInlineSnapshot(`
      "| Window   | Messages | Sessions | Tokens |  Cost |
      | -------- | -------: | -------: | -----: | ----: |
      | all time |        6 |        2 |   3.1K | $1.23 |

      ## Models

      | Source   | Model                | Input | Output | C.Read | C.Write | Total |  Cost |
      | -------- | -------------------- | ----: | -----: | -----: | ------: | ----: | ----: |
      | OpenCode | claude-opus-4-5-high |  1.0K |   2.0K |      0 |       0 |  3.0K | $1.23 |

      ## Top Sessions

      | Current | Session |  Cost | Tokens | Msgs | Title        |
      | ------- | ------- | ----: | -----: | ---: | ------------ |
      |         | ses_123 | $0.50 |    300 |    3 | Test Session |

      ## Unpriced Models

      | Source | Model     | Mapped           | Reason                 | Tokens | Msgs |
      | ------ | --------- | ---------------- | ---------------------- | -----: | ---: |
      | Cursor | foo-model | openai/foo-model | snapshot missing model |     70 |    1 |

      ## Unknown Pricing

      | Source   | Model     | Mapped                                          | Tokens | Msgs |
      | -------- | --------- | ----------------------------------------------- | -----: | ---: |
      | OpenCode | bar-model | openai/bar-model (candidates: openai,anthropic) |     30 |    1 |

      Run /quota_status to see the full pricing diagnostics report."
    `);
  });
});
