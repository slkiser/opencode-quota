import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
} from "./helpers/provider-assertions.js";

const mocks = vi.hoisted(() => ({
  fetchWithTimeout: vi.fn(),
  isCanonicalProviderAvailable: vi.fn(),
  resolveMiniMaxAuthCached: vi.fn(),
}));

vi.mock("../src/lib/minimax-auth.js", () => ({
  resolveMiniMaxAuthCached: mocks.resolveMiniMaxAuthCached,
  DEFAULT_MINIMAX_AUTH_CACHE_MAX_AGE_MS: 5_000,
}));

vi.mock("../src/lib/http.js", () => ({
  fetchWithTimeout: mocks.fetchWithTimeout,
}));

vi.mock("../src/lib/provider-availability.js", () => ({
  isCanonicalProviderAvailable: mocks.isCanonicalProviderAvailable,
}));

import { minimaxCodingPlanProvider } from "../src/providers/minimax-coding-plan.js";

function createCodingPlanModel(
  overrides: Partial<{
    model_name: string;
    current_interval_total_count: number;
    current_interval_usage_count: number;
    remains_time: number;
    current_weekly_total_count: number;
    current_weekly_usage_count: number;
    weekly_remains_time: number;
  }> = {},
) {
  return {
    model_name: "MiniMax-M*",
    current_interval_total_count: 4500,
    current_interval_usage_count: 4430,
    remains_time: 13_987_604,
    current_weekly_total_count: 45_000,
    current_weekly_usage_count: 44_895,
    weekly_remains_time: 564_787_604,
    ...overrides,
  };
}

function mockMiniMaxAuthNone() {
  mocks.resolveMiniMaxAuthCached.mockResolvedValueOnce({ state: "none" });
}

function mockMiniMaxAuthInvalid(error = "Invalid API key") {
  mocks.resolveMiniMaxAuthCached.mockResolvedValueOnce({ state: "invalid", error });
}

function mockMiniMaxAuthConfigured(apiKey = "test-key") {
  mocks.resolveMiniMaxAuthCached.mockResolvedValueOnce({ state: "configured", apiKey });
}

function mockMiniMaxHttpSuccess(models: unknown[]) {
  mocks.fetchWithTimeout.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      model_remains: models,
      base_resp: { status_code: 0, status_msg: "success" },
    }),
  });
}

function mockMiniMaxHttpFailure(status: number, text: string) {
  mocks.fetchWithTimeout.mockResolvedValueOnce({
    ok: false,
    status,
    text: async () => text,
  });
}

async function runProviderFetch(formatStyle: "grouped" | "classic" = "grouped") {
  return minimaxCodingPlanProvider.fetch({ config: { formatStyle } } as any);
}

describe("minimax-coding-plan provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns attempted:false when no minimax coding plan is configured", async () => {
    mockMiniMaxAuthNone();

    const out = await minimaxCodingPlanProvider.fetch({ config: {} } as any);
    expectNotAttempted(out);
  });

  it("returns error when minimax auth is invalid", async () => {
    mockMiniMaxAuthInvalid();

    const out = await minimaxCodingPlanProvider.fetch({ config: {} } as any);
    expectAttemptedWithErrorLabel(out, "MiniMax Coding Plan");
    expect(out.errors[0]?.message).toBe("Invalid API key");
  });

  it("maps MiniMax-M* model to rolling 5h and weekly entries", async () => {
    mockMiniMaxAuthConfigured();
    mockMiniMaxHttpSuccess([createCodingPlanModel({ model_name: "MiniMax-M2.7" })]);

    const out = await runProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(2);
    expect(out.entries[0]).toMatchObject({
      window: "five_hour",
      name: "MiniMax Coding Plan 5h",
      group: "MiniMax Coding Plan",
      label: "5h:",
      right: "70/4500",
      percentRemaining: 98,
    });
    expect(out.entries[1]).toMatchObject({
      window: "weekly",
      name: "MiniMax Coding Plan Weekly",
      group: "MiniMax Coding Plan",
      label: "Weekly:",
      right: "105/45000",
      percentRemaining: 100,
    });
  });

  it.each([
    {
      name: "returns empty entries when MiniMax coding-plan windows have zero totals",
      models: [
        createCodingPlanModel({
          current_interval_total_count: 0,
          current_interval_usage_count: 0,
          current_weekly_total_count: 0,
          current_weekly_usage_count: 0,
          remains_time: 46_387_604,
        }),
      ],
    },
    {
      name: "returns empty entries when API returns no models",
      models: [],
    },
    {
      name: "ignores non-coding MiniMax families",
      models: [createCodingPlanModel({ model_name: "MiniMax-Hailuo-2.3-Fast-6s-768p" })],
    },
    {
      name: "ignores non-finite quota values from the API",
      models: [createCodingPlanModel({ current_interval_total_count: Infinity })],
    },
  ])("$name", async ({ models }) => {
    mockMiniMaxAuthConfigured();
    mockMiniMaxHttpSuccess(models);

    const out = await runProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(0);
  });

  it("collapses multiple coding-plan models to one canonical quota record", async () => {
    mockMiniMaxAuthConfigured();
    mockMiniMaxHttpSuccess([
      createCodingPlanModel({
        model_name: "MiniMax-M2.7",
        current_interval_usage_count: 4400,
        current_weekly_usage_count: 44000,
      }),
      createCodingPlanModel({
        model_name: "MiniMax-M2.7-highspeed",
        current_interval_usage_count: 4300,
        current_weekly_usage_count: 44500,
      }),
    ]);

    const out = await runProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(2);
    expect(out.entries[0]).toMatchObject({
      window: "five_hour",
      right: "200/4500",
      percentRemaining: 96,
    });
    expect(out.entries[1]).toMatchObject({
      window: "weekly",
      right: "500/45000",
      percentRemaining: 99,
    });
  });

  it("falls back to a concrete coding model when the wildcard row has no quota", async () => {
    mockMiniMaxAuthConfigured();
    mockMiniMaxHttpSuccess([
      createCodingPlanModel({
        current_interval_total_count: 0,
        current_interval_usage_count: 0,
        current_weekly_total_count: 0,
        current_weekly_usage_count: 0,
        remains_time: 46_387_604,
      }),
      createCodingPlanModel({
        model_name: "MiniMax-M2.7",
        current_interval_usage_count: 4400,
      }),
    ]);

    const out = await runProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(2);
    expect(out.entries[0]).toMatchObject({
      window: "five_hour",
      right: "100/4500",
      percentRemaining: 98,
    });
    expect(out.entries[1]).toMatchObject({
      window: "weekly",
      right: "105/45000",
      percentRemaining: 100,
    });
  });

  it("returns error on API failure", async () => {
    mockMiniMaxAuthConfigured();
    mockMiniMaxHttpFailure(401, "Unauthorized");

    const out = await minimaxCodingPlanProvider.fetch({ config: {} } as any);
    expectAttemptedWithErrorLabel(out, "MiniMax Coding Plan");
    expect(out.errors[0]?.message).toContain("401");
  });

  it("sanitizes remote response text in API errors", async () => {
    mockMiniMaxAuthConfigured();
    mockMiniMaxHttpFailure(401, "\u001b[31mUnauthorized\nretry later\u001b[0m");

    const out = await minimaxCodingPlanProvider.fetch({ config: {} } as any);
    expectAttemptedWithErrorLabel(out, "MiniMax Coding Plan");
    expect(out.errors[0]?.message).toBe("MiniMax API error 401: Unauthorized retry later");
  });

  it("returns error on non-zero status code", async () => {
    mockMiniMaxAuthConfigured();
    mocks.fetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        model_remains: [],
        base_resp: { status_code: 1001, status_msg: "invalid token" },
      }),
    });

    const out = await minimaxCodingPlanProvider.fetch({ config: {} } as any);
    expectAttemptedWithErrorLabel(out, "MiniMax Coding Plan");
    expect(out.errors[0]?.message).toContain("invalid token");
  });

  it("sanitizes status messages and thrown errors", async () => {
    mockMiniMaxAuthConfigured();
    mocks.fetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        model_remains: [],
        base_resp: {
          status_code: 1001,
          status_msg: `\u001b[31m${"x".repeat(140)}\nretry\u001b[0m`,
        },
      }),
    });

    const statusOut = await minimaxCodingPlanProvider.fetch({ config: {} } as any);
    expectAttemptedWithErrorLabel(statusOut, "MiniMax Coding Plan");
    expect(statusOut.errors[0]?.message).toBe(`MiniMax API error: ${`${"x".repeat(140)} retry`.slice(0, 120)}`);

    mockMiniMaxAuthConfigured();
    mocks.fetchWithTimeout.mockRejectedValueOnce(new Error("network\nfailed"));

    const thrownOut = await minimaxCodingPlanProvider.fetch({ config: {} } as any);
    expectAttemptedWithErrorLabel(thrownOut, "MiniMax Coding Plan");
    expect(thrownOut.errors[0]?.message).toBe("network failed");
  });

  it("uses worst remaining entry for classic style", async () => {
    mockMiniMaxAuthConfigured();
    mockMiniMaxHttpSuccess([
      createCodingPlanModel({
        current_interval_usage_count: 100,
        current_weekly_usage_count: 100,
      }),
    ]);

    const out = await runProviderFetch("classic");

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]).toMatchObject({
      name: "MiniMax Coding Plan Weekly",
      percentRemaining: 0,
    });
  });

  it.each([
    ["minimax/MiniMax-M2.7", true],
    ["minimax/MiniMax-M2.7-highspeed", true],
    ["MINIMAX/MiniMax-M2.7", true],
    ["minimax-coding-plan/MiniMax-M2.7", true],
    ["minimax/Hailuo-02", false],
    ["openai/gpt-4", false],
  ])("matchesCurrentModel(%s) -> %s", (model, expected) => {
    expect(minimaxCodingPlanProvider.matchesCurrentModel?.(model)).toBe(expected);
  });

  it.each([
    [{ state: "configured", apiKey: "test-key" }, true],
    [{ state: "invalid", error: "Invalid API key" }, true],
    [{ state: "none" }, false],
  ])("isAvailable returns %s for auth state %j", async (authState, expected) => {
    mocks.isCanonicalProviderAvailable.mockResolvedValueOnce(true);
    mocks.resolveMiniMaxAuthCached.mockResolvedValueOnce(authState);

    const available = await minimaxCodingPlanProvider.isAvailable({} as any);
    expect(available).toBe(expected);
  });

  it("returns false when auth exists but the minimax provider is not configured", async () => {
    mocks.isCanonicalProviderAvailable.mockResolvedValueOnce(false);
    mocks.resolveMiniMaxAuthCached.mockResolvedValueOnce({ state: "configured", apiKey: "test-key" });

    const available = await minimaxCodingPlanProvider.isAvailable({} as any);
    expect(available).toBe(false);
    expect(mocks.resolveMiniMaxAuthCached).not.toHaveBeenCalled();
  });
});
