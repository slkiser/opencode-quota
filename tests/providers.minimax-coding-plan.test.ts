import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
} from "./helpers/provider-assertions.js";

const mocks = vi.hoisted(() => ({
  fetchWithTimeout: vi.fn(),
  isAnyProviderIdAvailable: vi.fn(),
  isCanonicalProviderAvailable: vi.fn(),
  resolveMiniMaxAuthCached: vi.fn(),
  resolveMiniMaxChinaAuthCached: vi.fn(),
}));

vi.mock("../src/lib/minimax-auth.js", () => ({
  resolveMiniMaxAuthCached: mocks.resolveMiniMaxAuthCached,
  resolveMiniMaxChinaAuthCached: mocks.resolveMiniMaxChinaAuthCached,
  DEFAULT_MINIMAX_AUTH_CACHE_MAX_AGE_MS: 5_000,
}));

vi.mock("../src/lib/http.js", () => ({
  fetchWithTimeout: mocks.fetchWithTimeout,
}));

vi.mock("../src/lib/provider-availability.js", () => ({
  isAnyProviderIdAvailable: mocks.isAnyProviderIdAvailable,
  isCanonicalProviderAvailable: mocks.isCanonicalProviderAvailable,
}));

import {
  minimaxChinaCodingPlanProvider,
  minimaxCodingPlanProvider,
  queryMiniMaxQuota,
} from "../src/providers/minimax-coding-plan.js";

function createCodingPlanModel(
  overrides: Partial<{
    model_name: string;
    current_interval_total_count: number;
    current_interval_usage_count: number;
    remains_time: number;
    current_weekly_total_count: number;
    current_weekly_usage_count: number;
    weekly_remains_time: number;
    current_interval_remaining_percent: number;
    current_interval_status: number;
    current_weekly_remaining_percent: number;
    current_weekly_status: number;
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

function mockMiniMaxChinaAuthNone() {
  mocks.resolveMiniMaxChinaAuthCached.mockResolvedValueOnce({ state: "none" });
}

function mockMiniMaxAuthInvalid(error = "Invalid API key") {
  mocks.resolveMiniMaxAuthCached.mockResolvedValueOnce({ state: "invalid", error });
}

function mockMiniMaxAuthConfigured(
  apiKey = "test-key",
  endpoint: "international" | "china" = "international",
) {
  mocks.resolveMiniMaxAuthCached.mockResolvedValueOnce({ state: "configured", apiKey, endpoint });
}

function mockMiniMaxChinaAuthConfigured(apiKey = "china-key") {
  mocks.resolveMiniMaxChinaAuthCached.mockResolvedValueOnce({
    state: "configured",
    apiKey,
    endpoint: "china",
  });
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

async function runProviderFetch() {
  return minimaxCodingPlanProvider.fetch({ config: {} } as any);
}

async function runChinaProviderFetch() {
  return minimaxChinaCodingPlanProvider.fetch({ config: {} } as any);
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

  it("uses the China Token Plan endpoint for the MiniMax China provider", async () => {
    mockMiniMaxChinaAuthConfigured("china-key");
    mockMiniMaxHttpSuccess([createCodingPlanModel({ model_name: "MiniMax-M2.7" })]);

    const out = await runChinaProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      "https://api.minimaxi.com/v1/token_plan/remains",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer china-key" }),
      }),
      undefined,
    );
  });

  it("maps China five-hour-only Token Plan responses without weekly fields", async () => {
    mockMiniMaxChinaAuthConfigured("china-key");
    mockMiniMaxHttpSuccess([
      createCodingPlanModel({
        model_name: "MiniMax-M2.7",
        current_interval_total_count: 1500,
        current_interval_usage_count: 1200,
        current_weekly_total_count: undefined,
        current_weekly_usage_count: undefined,
        weekly_remains_time: undefined,
      }),
    ]);

    const out = await runChinaProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]).toMatchObject({
      window: "five_hour",
      name: "MiniMax Coding Plan (CN) 5h",
      group: "MiniMax Coding Plan (CN)",
      right: "1200/1500",
      percentRemaining: 20,
    });
  });

  it.each([
    { rawUsed: 0, right: "0/1500", percentRemaining: 100 },
    { rawUsed: 1500, right: "1500/1500", percentRemaining: 0 },
    { rawUsed: 13, total: 15000, right: "13/15000", percentRemaining: 100 },
    { rawUsed: 1550, right: "1550/1500", percentRemaining: -3 },
  ])(
    "normalizes China Token Plan used count $rawUsed as $right",
    async ({ rawUsed, total = 1500, right, percentRemaining }) => {
      mockMiniMaxChinaAuthConfigured("china-key");
      mockMiniMaxHttpSuccess([
        createCodingPlanModel({
          model_name: "MiniMax-M2.7",
          current_interval_total_count: total,
          current_interval_usage_count: rawUsed,
          current_weekly_total_count: undefined,
          current_weekly_usage_count: undefined,
          weekly_remains_time: undefined,
        }),
      ]);

      const out = await runChinaProviderFetch();

      expectAttemptedWithNoErrors(out);
      expect(out.entries).toHaveLength(1);
      expect(out.entries[0]).toMatchObject({
        window: "five_hour",
        right,
        percentRemaining,
      });
    },
  );

  it("selects the lowest-remaining China model using used-count semantics", async () => {
    mockMiniMaxChinaAuthConfigured("china-key");
    mockMiniMaxHttpSuccess([
      createCodingPlanModel({
        model_name: "MiniMax-M2.7",
        current_interval_total_count: 1500,
        current_interval_usage_count: 100,
        current_weekly_total_count: undefined,
        current_weekly_usage_count: undefined,
        weekly_remains_time: undefined,
      }),
      createCodingPlanModel({
        model_name: "MiniMax-M2.7-highspeed",
        current_interval_total_count: 1500,
        current_interval_usage_count: 1400,
        current_weekly_total_count: undefined,
        current_weekly_usage_count: undefined,
        weekly_remains_time: undefined,
      }),
    ]);

    const out = await runChinaProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]).toMatchObject({
      window: "five_hour",
      right: "1400/1500",
      percentRemaining: 7,
    });
  });

  it("uses the international Coding Plan endpoint by default", async () => {
    mockMiniMaxHttpSuccess([createCodingPlanModel()]);

    await queryMiniMaxQuota("intl-key");

    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      "https://api.minimax.io/v1/api/openplatform/coding_plan/remains",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer intl-key" }),
      }),
      undefined,
    );
  });

  it("accepts international generic model_name rows", async () => {
    mockMiniMaxAuthConfigured();
    mockMiniMaxHttpSuccess([
      createCodingPlanModel({
        model_name: "general",
        current_interval_total_count: 0,
        current_interval_usage_count: 0,
        current_weekly_total_count: undefined,
        current_weekly_usage_count: undefined,
        weekly_remains_time: undefined,
      }),
      createCodingPlanModel({
        model_name: "video",
        current_interval_total_count: 3,
        current_interval_usage_count: 3,
        current_weekly_total_count: undefined,
        current_weekly_usage_count: undefined,
        weekly_remains_time: undefined,
      }),
    ]);

    const out = await runProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]).toMatchObject({
      window: "five_hour",
      right: "0/3",
      percentRemaining: 100,
    });
  });

  it("falls back to remaining_percent when international generic rows report zero counts", async () => {
    mockMiniMaxAuthConfigured();
    mockMiniMaxHttpSuccess([
      createCodingPlanModel({
        model_name: "general",
        current_interval_total_count: 0,
        current_interval_usage_count: 0,
        current_weekly_total_count: 0,
        current_weekly_usage_count: 0,
        weekly_remains_time: 27_563_753,
        current_interval_remaining_percent: 86,
        current_interval_status: 1,
        current_weekly_remaining_percent: 90,
        current_weekly_status: 1,
      }),
      createCodingPlanModel({
        model_name: "video",
        current_interval_total_count: 0,
        current_interval_usage_count: 0,
        current_weekly_total_count: 0,
        current_weekly_usage_count: 0,
        weekly_remains_time: 27_563_753,
        current_interval_remaining_percent: 100,
        current_interval_status: 3,
        current_weekly_remaining_percent: 100,
        current_weekly_status: 3,
      }),
    ]);

    const out = await runProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(2);
    expect(out.entries[0]).toMatchObject({
      window: "five_hour",
      name: "MiniMax Coding Plan 5h",
      group: "MiniMax Coding Plan",
      label: "5h:",
      right: "14%",
      percentRemaining: 86,
    });
    expect(out.entries[1]).toMatchObject({
      window: "weekly",
      name: "MiniMax Coding Plan Weekly",
      group: "MiniMax Coding Plan",
      label: "Weekly:",
      right: "10%",
      percentRemaining: 90,
    });
  });

  it("uses remaining_percent when count fields are missing entirely from the API response", async () => {
    mockMiniMaxAuthConfigured();
    mockMiniMaxHttpSuccess([
      {
        model_name: "general",
        remains_time: 13_163_753,
        current_interval_remaining_percent: 75,
        current_weekly_remaining_percent: 80,
        weekly_remains_time: 27_563_753,
      },
    ]);

    const out = await runProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(2);
    expect(out.entries[0]).toMatchObject({
      window: "five_hour",
      right: "25%",
      percentRemaining: 75,
    });
    expect(out.entries[1]).toMatchObject({
      window: "weekly",
      right: "20%",
      percentRemaining: 80,
    });
  });

  it("prefers the count path when both count and percent fields are populated", async () => {
    mockMiniMaxAuthConfigured();
    mockMiniMaxHttpSuccess([
      createCodingPlanModel({
        model_name: "MiniMax-M2.7",
        current_interval_total_count: 100,
        current_interval_usage_count: 25,
        current_weekly_total_count: 1000,
        current_weekly_usage_count: 250,
        current_interval_remaining_percent: 12,
        current_weekly_remaining_percent: 13,
      }),
    ]);

    const out = await runProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(out.entries[0]).toMatchObject({
      window: "five_hour",
      right: "75/100",
      percentRemaining: 25,
    });
    expect(out.entries[1]).toMatchObject({
      window: "weekly",
      right: "750/1000",
      percentRemaining: 25,
    });
  });

  it("selects the lowest-remaining international generic row", async () => {
    mockMiniMaxAuthConfigured();
    mockMiniMaxHttpSuccess([
      createCodingPlanModel({
        model_name: "general",
        current_interval_total_count: 10,
        current_interval_usage_count: 2,
        current_weekly_total_count: undefined,
        current_weekly_usage_count: undefined,
        weekly_remains_time: undefined,
      }),
      createCodingPlanModel({
        model_name: "video",
        current_interval_total_count: 10,
        current_interval_usage_count: 8,
        current_weekly_total_count: undefined,
        current_weekly_usage_count: undefined,
        weekly_remains_time: undefined,
      }),
    ]);

    const out = await runProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]).toMatchObject({
      window: "five_hour",
      right: "8/10",
      percentRemaining: 20,
    });
  });

  it("does not accept generic model_name rows for the China endpoint", async () => {
    mockMiniMaxHttpSuccess([
      createCodingPlanModel({
        model_name: "general",
        current_interval_total_count: 10,
        current_interval_usage_count: 8,
        current_weekly_total_count: undefined,
        current_weekly_usage_count: undefined,
        weekly_remains_time: undefined,
      }),
    ]);

    const out = await queryMiniMaxQuota("china-key", { endpoint: "china" });

    expect(out).toEqual({ success: true, entries: [] });
  });

  it("preserves negative remaining percentages when MiniMax reports negative remaining quota", async () => {
    mockMiniMaxAuthConfigured();
    mockMiniMaxHttpSuccess([
      createCodingPlanModel({
        current_interval_usage_count: -50,
        current_weekly_usage_count: -500,
      }),
    ]);

    const out = await runProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(2);
    expect(out.entries[0]).toMatchObject({
      window: "five_hour",
      right: "4550/4500",
      percentRemaining: -1,
    });
    expect(out.entries[1]).toMatchObject({
      window: "weekly",
      right: "45500/45000",
      percentRemaining: -1,
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
    expect(statusOut.errors[0]?.message).toBe(
      `MiniMax API error: ${`${"x".repeat(140)} retry`.slice(0, 120)}`,
    );

    mockMiniMaxAuthConfigured();
    mocks.fetchWithTimeout.mockRejectedValueOnce(new Error("network\nfailed"));

    const thrownOut = await minimaxCodingPlanProvider.fetch({ config: {} } as any);
    expectAttemptedWithErrorLabel(thrownOut, "MiniMax Coding Plan");
    expect(thrownOut.errors[0]?.message).toBe("network failed");
  });

  it("does not add provider-specific projection metadata", async () => {
    mockMiniMaxAuthConfigured();
    mockMiniMaxHttpSuccess([
      createCodingPlanModel({
        current_interval_usage_count: 100,
        current_weekly_usage_count: 100,
      }),
    ]);

    const out = await runProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(2);
    expect(out.presentation).toBeUndefined();
  });

  it.each([
    ["minimax/MiniMax-M2.7", true],
    ["minimax/MiniMax-M2.7-highspeed", true],
    ["MINIMAX/MiniMax-M2.7", true],
    ["minimax-coding-plan/MiniMax-M2.7", true],
    ["minimax-cn/MiniMax-M2.7", false],
    ["minimax-cn-coding-plan/MiniMax-M2.7", false],
    ["minimax-china-coding-plan/MiniMax-M2.7", false],
    ["minimax/Hailuo-02", false],
    ["openai/gpt-4", false],
  ])("international matchesCurrentModel(%s) -> %s", (model, expected) => {
    expect(minimaxCodingPlanProvider.matchesCurrentModel?.(model)).toBe(expected);
  });

  it.each([
    ["minimax/MiniMax-M2.7", false],
    ["minimax-cn/MiniMax-M2.7", true],
    ["minimax-cn-coding-plan/MiniMax-M2.7", true],
    ["minimax-china-coding-plan/MiniMax-M2.7", true],
    ["minimax-coding-plan/MiniMax-M2.7", false],
    ["minimax/Hailuo-02", false],
  ])("China matchesCurrentModel(%s) -> %s", (model, expected) => {
    expect(minimaxChinaCodingPlanProvider.matchesCurrentModel?.(model)).toBe(expected);
  });

  it("lets the China provider match ambiguous minimax models when explicitly enabled", () => {
    expect(
      minimaxChinaCodingPlanProvider.matchesCurrentModel?.("minimax/MiniMax-M2.7", {
        enabledProviders: ["minimax-china-coding-plan"],
      }),
    ).toBe(true);
  });

  it.each([
    [{ state: "configured", apiKey: "test-key" }, true],
    [{ state: "invalid", error: "Invalid API key" }, true],
    [{ state: "none" }, false],
  ])("isAvailable returns %s for auth state %j", async (authState, expected) => {
    mocks.isCanonicalProviderAvailable.mockResolvedValueOnce(true);
    mocks.resolveMiniMaxAuthCached.mockResolvedValueOnce(authState);

    const available = await minimaxCodingPlanProvider.isAvailable({
      config: { enabledProviders: "auto" },
    } as any);
    expect(available).toBe(expected);
  });

  it("returns false when auth exists but the minimax provider is not configured", async () => {
    mocks.isCanonicalProviderAvailable.mockResolvedValueOnce(false);
    mocks.resolveMiniMaxAuthCached.mockResolvedValueOnce({
      state: "configured",
      apiKey: "test-key",
    });

    const available = await minimaxCodingPlanProvider.isAvailable({
      config: { enabledProviders: "auto" },
    } as any);
    expect(available).toBe(false);
    expect(mocks.resolveMiniMaxAuthCached).not.toHaveBeenCalled();
  });

  it("allows the China provider to use ambiguous minimax runtime ids only when explicitly enabled", async () => {
    mocks.isCanonicalProviderAvailable.mockResolvedValueOnce(false);
    mocks.isAnyProviderIdAvailable.mockResolvedValueOnce(true);
    mockMiniMaxChinaAuthConfigured("china-key");

    const available = await minimaxChinaCodingPlanProvider.isAvailable({
      config: { enabledProviders: ["minimax-china-coding-plan"] },
    } as any);

    expect(available).toBe(true);
  });

  it("does not use ambiguous minimax runtime ids for the China provider in auto mode", async () => {
    mocks.isCanonicalProviderAvailable.mockResolvedValueOnce(false);
    mockMiniMaxChinaAuthNone();

    const available = await minimaxChinaCodingPlanProvider.isAvailable({
      config: { enabledProviders: "auto" },
    } as any);

    expect(available).toBe(false);
    expect(mocks.isAnyProviderIdAvailable).not.toHaveBeenCalled();
    expect(mocks.resolveMiniMaxChinaAuthCached).not.toHaveBeenCalled();
  });
});
