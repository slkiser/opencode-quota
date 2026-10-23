/**
 * Cursor as one module: its month of spend estimated from Cursor messages in a temp
 * `opencode.db`, priced as the Usage tab prices them (cursor/gpt-5 input $1.25 per million
 * tokens for the API pool, Cursor's `auto` input $1.25 per million for Auto+Composer), and its
 * plugin or provider found in a temp `opencode.json`.
 */

import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { cursorProvider } from "../src/providers/cursor.js";
import { fetchRows, rowSummary, useProviderWorld } from "./helpers/provider-fetch.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";
import { type SessionDatabaseMessage, writeSessionDatabase } from "./helpers/session-database.js";

const world = useProviderWorld();

// The cycle is the local calendar month, or the month from the configured start day.
const NOW = new Date(2026, 1, 15, 12);
const CYCLE_START = new Date(2026, 1, 1).toISOString();
const RESET = new Date(2026, 2, 1).toISOString();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Input tokens that cost `usd` at $1.25 per million. */
function tokensFor(usd: number): number {
  return Math.round((usd / 1.25) * 1_000_000);
}

/**
 * This month's Cursor messages: API spend, Auto+Composer spend, unknown models, and GPT-5.4
 * requests over 200k tokens (Cursor's long-context rate).
 */
function storeHistory(spend: {
  api?: number;
  auto?: number;
  unknownModels?: number;
  longRequests?: number;
}): void {
  const created = new Date(2026, 1, 10).getTime();
  const message = (index: number, modelID: string, input: number): SessionDatabaseMessage => ({
    id: `msg_${index}`,
    sessionID: "ses_1",
    created: created + index,
    completed: created + index + 1,
    providerID: "cursor",
    modelID,
    tokens: { input },
  });
  const messages = [
    ...(spend.api === undefined ? [] : [message(1, "cursor/gpt-5", tokensFor(spend.api))]),
    ...(spend.auto === undefined ? [] : [message(2, "auto", tokensFor(spend.auto))]),
    ...Array.from({ length: spend.unknownModels ?? 0 }, (_, index) =>
      message(10 + index, "cursor/future-model", 10),
    ),
    ...Array.from({ length: spend.longRequests ?? 0 }, (_, index) =>
      message(20 + index, "cursor/gpt-5.4", 250_000),
    ),
  ];
  writeSessionDatabase(join(world.configDir, "..", "..", "data", "opencode", "opencode.db"), {
    sessions: [{ id: "ses_1", created }],
    messages,
  });
}

describe("cursor provider", () => {
  it.each([
    [
      "nothing without usage or an included budget",
      { cursorPlan: "none" },
      {},
      [],
      { code: "not_configured" },
    ],
    [
      "the plan's API budget and Auto+Composer spend",
      { cursorPlan: "pro" },
      { api: 5, auto: 1.25 },
      [
        ["cursor.api", "Pro", "API", "month", "75 (5 USD of 20 USD)", RESET],
        ["cursor.auto_composer", "Pro", "Auto+Composer", "month", "1.25 USD", RESET],
      ],
      undefined,
    ],
    [
      "an overspent configured budget below zero",
      { cursorPlan: "pro", cursorIncludedApiUsd: 8 },
      { api: 10 },
      [
        ["cursor.api", "Pro", "API", "month", "-25 (10 USD of 8 USD)", RESET],
        ["cursor.auto_composer", "Pro", "Auto+Composer", "month", "0 USD", RESET],
      ],
      undefined,
    ],
    [
      "spend without a plan",
      { cursorPlan: "none" },
      { api: 0.5, auto: 1.25 },
      [
        ["cursor.api", null, "API", "month", "0.5 USD", RESET],
        ["cursor.auto_composer", null, "Auto+Composer", "month", "1.25 USD", RESET],
      ],
      undefined,
    ],
    [
      "spend for a zero allowance",
      { cursorPlan: "pro", cursorIncludedApiUsd: 0 },
      { api: 0 },
      [
        ["cursor.api", "Pro", "API", "month", "0 USD", RESET],
        ["cursor.auto_composer", "Pro", "Auto+Composer", "month", "0 USD", RESET],
      ],
      undefined,
    ],
    [
      "only known API spend, and an error, when some models are unknown",
      { cursorPlan: "pro" },
      { api: 2, unknownModels: 1 },
      [
        ["cursor.api", "Pro", "Known API", "month", "2 USD", RESET],
        ["cursor.auto_composer", "Pro", "Auto+Composer", "month", "0 USD", RESET],
      ],
      { detail: "Unknown Cursor model ids present in local history (see /quota_status)" },
    ],
    [
      "only known API spend, and an error, when long requests have no price",
      { cursorPlan: "pro" },
      { api: 2, longRequests: 1 },
      [
        ["cursor.api", "Pro", "Known API", "month", "2 USD", RESET],
        ["cursor.auto_composer", "Pro", "Auto+Composer", "month", "0 USD", RESET],
      ],
      {
        detail: "Cursor requests over 200k tokens on models with a long-context rate have no price",
      },
    ],
  ])("shows %s", async (_name, config, spend, rows, error) => {
    storeHistory(spend);

    const fetched = await fetchRows(cursorProvider, config);

    expect(rowSummary(fetched.rows)).toEqual(rows);
    if (error) expect(fetched.error).toMatchObject(error);
    else expect(fetched.error).toBeUndefined();
  });

  it.each([
    ["a configured start day", 1, CYCLE_START],
    ["the calendar month", undefined, undefined],
  ])("dates the cycle from %s only when it is fixed", async (_name, startDay, startedAt) => {
    storeHistory({ api: 5 });

    const fetched = await fetchRows(cursorProvider, {
      cursorPlan: "pro",
      ...(startDay === undefined ? {} : { cursorBillingCycleStartDay: startDay }),
    });

    expect(fetched.rows[0]?.windowStartedAt).toBe(startedAt);
  });

  it.each([
    ["provider metadata", ["cursor"], { currentModel: "openai/gpt-5" }, undefined, true],
    [
      "the current provider id",
      [],
      { currentModel: "auto", currentProviderID: "cursor" },
      undefined,
      true,
    ],
    ["a Cursor model", [], { currentModel: "cursor-acp/auto" }, undefined, true],
    [
      "the plugin in a config file",
      [],
      { currentModel: "openai/gpt-5" },
      { plugin: ["cursor-opencode-provider@0.7.3/plugin/opencode2"] },
      true,
    ],
    [
      "a provider in a config file",
      [],
      { currentModel: "openai/gpt-5" },
      { provider: { cursor: {} } },
      true,
    ],
    ["no signal", [], { currentModel: "openai/gpt-5" }, { plugin: ["other-plugin"] }, false],
  ])("isAvailable via %s -> %s", async (_label, providerIds, config, opencodeJson, expected) => {
    if (opencodeJson) world.writeConfigFile("opencode.json", JSON.stringify(opencodeJson));

    await expect(
      cursorProvider.isAvailable(
        createProviderAvailabilityContext({
          providerIds,
          configOverrides: { ...config, cursorPlan: "none" },
        }),
      ),
    ).resolves.toBe(expected);
  });
});
