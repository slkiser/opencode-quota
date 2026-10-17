import { describe, expect, it } from "vite-plus/test";
import type { OpenCodeMessage } from "../src/lib/opencode-storage.js";
import {
  collectLocalQuotaProviderEstimate,
  countRequestWindows,
} from "../src/lib/quota-providers-local.js";
import type { LocalEstimateQuotaProviderDefinition } from "../src/lib/quota-providers.js";

const NOW = Date.UTC(2026, 6, 16, 12, 0, 0);

function definition(
  overrides: Partial<LocalEstimateQuotaProviderDefinition> = {},
): LocalEstimateQuotaProviderDefinition {
  return {
    id: "private-gateway",
    providerId: "private-gateway",
    label: "Private Gateway",
    mode: "local-estimate",
    windows: [
      { id: "daily", label: "Daily", type: "utc-day", requestLimit: 10, usdBudget: 5 },
      { id: "rolling", label: "Rolling", type: "rolling", durationMinutes: 60, requestLimit: 5 },
    ],
    ...overrides,
  };
}

function message(
  id: string,
  atMs: number,
  overrides: Partial<OpenCodeMessage> = {},
): OpenCodeMessage {
  return {
    id,
    sessionID: "ses_test",
    role: "assistant",
    providerID: "private-gateway",
    modelID: "private-model",
    time: { created: atMs, completed: atMs },
    tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
    ...overrides,
  };
}

/** The estimate at NOW from these completed requests. */
function estimate(
  def: LocalEstimateQuotaProviderDefinition,
  messages: Array<{ id: string; atMs: number; modelId: string; input: number; output: number }>,
) {
  return collectLocalQuotaProviderEstimate(def, {
    nowMs: NOW,
    readMessages: async () =>
      messages.map(({ id, atMs, modelId, input, output }) =>
        message(id, atMs, {
          providerID: def.providerId,
          modelID: modelId,
          tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
      ),
  });
}

/** Each window's id and counted request ids at NOW for these messages. */
async function counted(
  messages: OpenCodeMessage[],
  options: { providerIds?: string[]; modelIds?: string[] } = {},
) {
  const counts = await countRequestWindows({
    providerIds: options.providerIds ?? ["private-gateway"],
    modelIds: options.modelIds,
    windows: definition().windows,
    nowMs: NOW,
    readMessages: async () => messages,
  });
  return counts.map((count) => [count.window.id, count.requests.map((request) => request.id)]);
}

describe("request window counter", () => {
  it("counts each completed request once, only for these providers and models", async () => {
    expect(
      await counted(
        [
          message("duplicate", NOW - 1000),
          message("duplicate", NOW - 500),
          message("old", NOW - 2 * 24 * 60 * 60 * 1000),
          message("other-provider", NOW - 100, { providerID: "other" }),
          message("unfinished", NOW - 50, { time: { created: NOW - 50 } }),
          message("user", NOW - 50, { role: "user" }),
          message("plan", NOW - 40, { providerID: "alibaba" }),
          message("other-model", NOW - 30, { modelID: "other-model" }),
        ],
        { providerIds: ["private-gateway", "alibaba"], modelIds: ["private-model"] },
      ),
    ).toEqual([
      ["daily", ["duplicate", "plan"]],
      ["rolling", ["duplicate", "plan"]],
    ]);
  });

  it("uses completion time for UTC and rolling windows across creation cutoffs", async () => {
    const utcStart = Date.UTC(2026, 6, 16);
    let requestedSince = 0;
    const result = await collectLocalQuotaProviderEstimate(definition(), {
      nowMs: NOW,
      readMessages: async ({ completedSinceMs }) => {
        requestedSince = completedSinceMs;
        return [
          message("cross-cutoff", utcStart - 60_000, {
            time: { created: utcStart - 60_000, completed: NOW - 30_000 },
          }),
          message("completed-before-cutoff", NOW - 10_000, {
            time: { created: NOW - 10_000, completed: utcStart - 1 },
          }),
        ];
      },
    });

    expect(requestedSince).toBe(utcStart);
    const requests = (decimal: string) => ({ decimal, unit: { kind: "count", unit: "request" } });
    const dailyRow = result.rows.find((row) => row.key === "daily");
    const rollingRow = result.rows.find((row) => row.key === "rolling");
    expect(dailyRow).toMatchObject({
      label: "Daily",
      used: requests("1"),
      limit: requests("10"),
      resetsAt: "2026-07-17T00:00:00.000Z",
      windowStartedAt: "2026-07-16T00:00:00.000Z",
    });
    expect(rollingRow).toMatchObject({
      label: "Rolling",
      used: requests("1"),
      limit: requests("5"),
      resetsAt: new Date(NOW - 30_000 + 60 * 60 * 1000).toISOString(),
    });
    expect(rollingRow).not.toHaveProperty("windowStartedAt");
  });

  it("counts a request that names no model for Alibaba but not for a custom estimate", async () => {
    const noModel = message("no-model", NOW - 20, { modelID: undefined });
    expect(await counted([noModel])).toEqual([
      ["daily", ["no-model"]],
      ["rolling", ["no-model"]],
    ]);

    const result = await collectLocalQuotaProviderEstimate(definition(), {
      nowMs: NOW,
      readMessages: async () => [noModel],
    });
    expect(result.rows.find((row) => row.key === "daily")).toMatchObject({
      used: { decimal: "0" },
    });
    expect(result.rows.find((row) => row.key === "daily_budget")).toMatchObject({
      percentRemaining: 100,
    });
  });

  it("gives an empty rolling window no reset", async () => {
    const counts = await countRequestWindows({
      providerIds: ["private-gateway"],
      windows: definition().windows,
      nowMs: NOW,
      readMessages: async () => [],
    });
    expect(counts.map((count) => [count.requests.length, count.resetsAt ?? null])).toEqual([
      [0, "2026-07-17T00:00:00.000Z"],
      [0, null],
    ]);
  });

  it("prices automatic models.dev matches before manual fallbacks", async () => {
    const def = definition({
      id: "openai-local",
      providerId: "openai",
      pricingModelMap: { "gpt-4o": "anthropic/claude-sonnet-4-5" },
    });
    const result = await estimate(def, [
      { id: "priced", atMs: NOW - 1000, modelId: "gpt-4o", input: 1_000_000, output: 0 },
    ]);
    const budget = result.rows.find((row) => row.type === "budget");
    expect(budget?.percentRemaining).toBeTypeOf("number");
  });

  it("prices Cursor's Auto from Cursor's own table, as the Usage tab does", async () => {
    const def = definition({ id: "cursor-local", providerId: "cursor" });
    const result = await estimate(def, [
      { id: "auto", atMs: NOW - 1000, modelId: "auto", input: 1_000_000, output: 0 },
    ]);
    const budget = result.rows.find((row) => row.key === "daily_budget");
    expect(budget).toMatchObject({ used: { decimal: "1.25" }, percentRemaining: 75 });
  });

  it("keeps request counts but never emits a budget percentage for unpriced usage", async () => {
    const result = await estimate(definition(), [
      { id: "unpriced", atMs: NOW - 1000, modelId: "unknown-private-model", input: 10, output: 5 },
    ]);
    const request = result.rows.find((row) => row.type === "quota");
    const budget = result.rows.find((row) => row.type === "budget");
    expect(request).toMatchObject({ percentRemaining: 90, used: { decimal: "1" } });
    expect(budget).toEqual({
      key: "daily_budget",
      label: "Daily budget",
      type: "budget",
      method: "local_estimation",
      authority: "locally_derived",
      prominence: "primary",
      window: "day",
      text: "Unavailable (1 unpriced request)",
      resetsAt: expect.any(String),
    });
  });

  it("bounds over-limit request and budget percentages at zero", async () => {
    const def = definition({
      pricingModelMap: { "private-model": "openai/gpt-4o" },
      windows: [
        { id: "daily", label: "Daily", type: "utc-day", requestLimit: 1, usdBudget: 0.000001 },
      ],
    });
    const result = await estimate(
      def,
      ["one", "two"].map((id, index) => ({
        id,
        atMs: NOW - (2 - index) * 1_000,
        modelId: "private-model",
        input: 1_000,
        output: 1_000,
      })),
    );
    expect(result.rows).toEqual([
      expect.objectContaining({
        type: "quota",
        used: { decimal: "2", unit: { kind: "count", unit: "request" } },
        limit: { decimal: "1", unit: { kind: "count", unit: "request" } },
        percentRemaining: 0,
      }),
      expect.objectContaining({
        type: "budget",
        limit: { decimal: "0", unit: { kind: "currency", code: "USD" } },
        percentRemaining: 0,
      }),
    ]);
  });
});
