import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { computeCursorCycleWindow, getCurrentCursorUsageSummary } from "../src/lib/cursor-usage.js";
import { useProviderWorld } from "./helpers/provider-fetch.js";
import { type SessionDatabaseMessage, writeSessionDatabase } from "./helpers/session-database.js";

const world = useProviderWorld();

const nowMs = new Date(2026, 2, 19, 10, 0, 0, 0).getTime();
/** Inside the cycle that starts on the 7th. */
const createdMs = new Date(2026, 2, 10).getTime();

function message(
  providerID: string,
  modelID: string,
  input: number,
  output: number,
): Omit<SessionDatabaseMessage, "id" | "sessionID" | "created"> {
  return { providerID, modelID, tokens: { input, output } };
}

/** These assistant messages in one session of a temp `opencode.db`. */
function storeMessages(
  messages: ReadonlyArray<Omit<SessionDatabaseMessage, "id" | "sessionID" | "created">>,
): void {
  writeSessionDatabase(join(world.configDir, "..", "..", "data", "opencode", "opencode.db"), {
    sessions: [{ id: "ses_1", created: createdMs }],
    messages: messages.map((fields, index) => ({
      ...fields,
      id: `msg_${index}`,
      sessionID: "ses_1",
      created: createdMs + index,
      completed: createdMs + index + 1,
    })),
  });
}

describe("computeCursorCycleWindow", () => {
  it.each([
    ["a start day already passed", 7, new Date(2026, 2, 7), new Date(2026, 3, 7), "configured_day"],
    ["a start day still ahead", 25, new Date(2026, 1, 25), new Date(2026, 2, 25), "configured_day"],
    ["no start day", undefined, new Date(2026, 2, 1), new Date(2026, 3, 1), "calendar_month"],
    ["an out-of-range start day", 31, new Date(2026, 2, 1), new Date(2026, 3, 1), "calendar_month"],
  ])("uses %s", (_label, billingCycleStartDay, since, until, source) => {
    expect(computeCursorCycleWindow({ nowMs, billingCycleStartDay })).toEqual({
      sinceMs: since.getTime(),
      untilMs: until.getTime(),
      resetTimeIso: until.toISOString(),
      source,
    });
  });
});

describe("getCurrentCursorUsageSummary", () => {
  it.each([
    [
      "api, auto/composer, unknown and non-Cursor history",
      [
        message("cursor", "auto", 1_000_000, 500_000),
        message("cursor", "gpt-5.4-high", 200_000, 1_000_000),
        message("cursor-acp", "cursor-acp/unknown-future-model", 10, 20),
        message("openai", "gpt-5", 1_000_000, 1_000_000),
      ],
      {
        auto: [1, 4.25],
        api: [1, 15.5],
        total: 3,
        unknown: ["cursor-acp/unknown-future-model"],
        unpriced: 0,
      },
    ],
    [
      "legacy cursor-acp history",
      [message("cursor-acp", "cursor-acp/composer-1", 1_000_000, 500_000)],
      { auto: [1, 6.25], api: [0, 0], total: 1, unknown: [], unpriced: 0 },
    ],
    [
      "cursor-opencode-provider fast and 1m entries",
      [
        message("cursor", "composer-2.5-fast", 1_000_000, 1_000_000),
        message("cursor", "grok-4.7", 100_000, 500_000),
        message("cursor", "claude-opus-4-8-1m", 1_000_000, 1_000_000),
        message("cursor", "gpt-5.5-1m", 10, 20),
      ],
      { auto: [2, 21.2], api: [1, 30], total: 4, unknown: ["gpt-5.5-1m"], unpriced: 0 },
    ],
    [
      // The last step of a turn, as cursor-opencode-provider's `shapeStepUsage` (billing.js)
      // shapes it: cache writes Cursor has no rate for, so OpenCode bills each the $0.001 Cursor did.
      "turns cursor-opencode-provider settled at what Cursor billed",
      [
        {
          providerID: "cursor",
          modelID: "gemini-4-argon",
          tokens: { output: 1, cacheRead: 9_900, cacheWrite: 90_100 },
        },
        {
          providerID: "cursor",
          modelID: "kimi-k3",
          tokens: { output: 1, cacheRead: 3_283, cacheWrite: 96_717 },
        },
        {
          providerID: "cursor",
          modelID: "grok-4.7",
          tokens: { output: 1, cacheRead: 1_988, cacheWrite: 98_012 },
        },
      ],
      { auto: [1, 0.001], api: [2, 0.002], total: 3, unknown: [], unpriced: 0 },
    ],
    [
      "prompts over 200k tokens on models Cursor bills at a long-context rate there, without a price",
      [
        message("cursor", "grok-4.7", 200_000, 0),
        {
          providerID: "cursor",
          modelID: "grok-4.7",
          tokens: { input: 50_000, cacheRead: 150_001 },
        },
        message("cursor", "grok-4.7-fast", 250_000, 0),
        message("cursor", "gpt-5.4", 200_000, 1),
        message("cursor", "gpt-5.4", 250_000, 1),
        message("cursor", "claude-sonnet-4-5", 250_000, 1),
      ],
      { auto: [1, 0.4], api: [2, 1.25003], total: 6, unknown: [], unpriced: 3 },
    ],
    [
      "models Cursor prices on its own, without models.dev's different price",
      [
        message("cursor", "gemini-3.6-flash", 100_000, 1),
        message("cursor", "glm-5.3-flash", 10, 20),
      ],
      {
        auto: [0, 0],
        api: [0, 0],
        total: 2,
        unknown: ["gemini-3.6-flash", "glm-5.3-flash"],
        unpriced: 0,
      },
    ],
    [
      "models outside Cursor's alias list at their models.dev price, as the Usage tab prices them",
      [
        message("cursor", "cursor/gpt-5", 1_000_000, 1_000_000),
        message("cursor", "constructor", 10, 20),
        message("cursor", "cursor/__proto__", 10, 20),
      ],
      {
        auto: [0, 0],
        api: [1, 11.25],
        total: 3,
        unknown: ["constructor", "cursor/__proto__"],
        unpriced: 0,
      },
    ],
    [
      "a Cursor official fallback alias",
      [message("cursor", "cursor/gpt-5.3-codex-spark-preview", 1_000_000, 1_000_000)],
      { auto: [0, 0], api: [1, 15.75], total: 1, unknown: [], unpriced: 0 },
    ],
  ])("buckets %s by Cursor pool", async (_label, messages, expected) => {
    storeMessages(messages);

    const summary = await getCurrentCursorUsageSummary({ nowMs, billingCycleStartDay: 7 });

    expect({
      auto: [summary.autoComposer.messageCount, summary.autoComposer.costUsd],
      api: [summary.api.messageCount, summary.api.costUsd],
      total: summary.total.messageCount,
      unknown: summary.unknownModels.map((model) => model.sourceModelID),
      unpriced: summary.unpricedRequestCount,
    }).toEqual({
      auto: [expected.auto[0], expect.closeTo(expected.auto[1], 6)],
      api: [expected.api[0], expect.closeTo(expected.api[1], 6)],
      total: expected.total,
      unknown: expected.unknown,
      unpriced: expected.unpriced,
    });
  });
});
