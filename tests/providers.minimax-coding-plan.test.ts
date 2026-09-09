import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
  visibleEntries,
} from "./helpers/provider-assertions.js";

const mocks = vi.hoisted(() => {
  const fetchResponse = vi.fn();
  return {
    fetchResponse,
    fetchWithTimeout: vi.fn(
      async (
        _url: string,
        options: {
          consume: (response: Response, signal: AbortSignal) => Promise<unknown> | unknown;
        },
      ) => {
        const response = await fetchResponse();
        return await options.consume(response, new AbortController().signal);
      },
    ),
    isAnyProviderIdAvailable: vi.fn(),
    isCanonicalProviderAvailable: vi.fn(),
    resolveMiniMaxAuthCached: vi.fn(),
    resolveMiniMaxChinaAuthCached: vi.fn(),
  };
});

vi.mock("../src/lib/minimax-auth.js", () => ({
  resolveMiniMaxAuth: vi.fn(),
  resolveMiniMaxChinaAuth: vi.fn(),
  resolveMiniMaxAuthCached: mocks.resolveMiniMaxAuthCached,
  resolveMiniMaxChinaAuthCached: mocks.resolveMiniMaxChinaAuthCached,
  getMiniMaxAuthDiagnostics: vi.fn(async () => ({
    state: "none",
    source: null,
    checkedPaths: [],
    credentialDatabasePaths: [],
  })),
  getMiniMaxChinaAuthDiagnostics: vi.fn(async () => ({
    state: "none",
    source: null,
    checkedPaths: [],
    credentialDatabasePaths: [],
  })),
  DEFAULT_MINIMAX_AUTH_CACHE_MAX_AGE_MS: 5_000,
}));

vi.mock("../src/lib/http.js", () => ({
  fetchWithTimeout: mocks.fetchWithTimeout,
}));

vi.mock("../src/lib/provider-availability.js", () => ({
  isAnyProviderIdAvailable: mocks.isAnyProviderIdAvailable,
  isCanonicalProviderAvailable: mocks.isCanonicalProviderAvailable,
}));

vi.mock("../src/lib/opencode-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-auth.js")>()),
  readCredentialRows: vi.fn().mockResolvedValue([]),
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
    current_interval_remaining_percent: unknown;
    current_weekly_remaining_percent: unknown;
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
  mocks.fetchResponse.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      model_remains: models,
      base_resp: { status_code: 0, status_msg: "success" },
    }),
  });
}

function mockMiniMaxHttpFailure(status: number, text: string) {
  mocks.fetchResponse.mockResolvedValueOnce({
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
    expectAttemptedWithErrorLabel(out, "MiniMax Token Plan");
    expect(out.errors[0]?.message).toBe("Invalid API key");
  });

  it("keeps a valid inactive duplicate-label database credential when the active row is invalid", async () => {
    const { getMiniMaxAuthDiagnostics, resolveMiniMaxAuth } = await import(
      "../src/lib/minimax-auth.js"
    );
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    (getMiniMaxAuthDiagnostics as any).mockResolvedValueOnce({
      state: "invalid",
      source: "opencode.db",
      checkedPaths: [],
      credentialDatabasePaths: [],
    });
    mockMiniMaxAuthInvalid("empty key");
    (readCredentialRows as any).mockResolvedValueOnce([
      {
        id: "bad",
        integrationId: "minimax-coding-plan",
        label: "shared",
        active: true,
        value: { key: "" },
      },
      {
        id: "good",
        integrationId: "minimax-coding-plan",
        label: "shared",
        active: false,
        value: { key: "ok" },
      },
    ]);
    (resolveMiniMaxAuth as any).mockImplementation((auth: any) =>
      auth["minimax-coding-plan"].key
        ? { state: "configured", apiKey: "row-key", endpoint: "international" }
        : { state: "invalid", error: "empty key" },
    );
    mockMiniMaxHttpSuccess([createCodingPlanModel()]);

    const out = await runProviderFetch();
    expect(out.errors).toContainEqual({
      label: "[MiniMax Token Plan shared]*",
      message: "empty key",
    });
    expect(out.entries).toContainEqual(
      expect.objectContaining({
        group: "[MiniMax Token Plan shared 2]",
        accounting: expect.objectContaining({ sourceId: "good" }),
      }),
    );
    expect(out.entries).not.toHaveLength(0);
  });

  it("maps MiniMax-M* model to structured five-hour and weekly entries", async () => {
    mockMiniMaxAuthConfigured();
    mockMiniMaxHttpSuccess([createCodingPlanModel({ model_name: "MiniMax-M2.7" })]);

    const out = await runProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(2);
    expect(out.entries[0]).toMatchObject({
      name: "minimax-token-plan-5h",
      group: "MiniMax Token Plan",
      label: "5h:",
      percentRemaining: 98,
      semantic: { metric: { kind: "window", window: "five_hour" } },
      basis: {
        used: {
          quantity: { decimal: "70", unit: { kind: "count", unit: "request" } },
          authority: "locally_derived",
        },
        limit: {
          quantity: { decimal: "4500", unit: { kind: "count", unit: "request" } },
          authority: "provider_reported",
        },
        remaining: {
          quantity: { decimal: "4430", unit: { kind: "count", unit: "request" } },
          authority: "provider_reported",
        },
      },
    });
    expect(out.entries[1]).toMatchObject({
      name: "minimax-token-plan-week",
      group: "MiniMax Token Plan",
      label: "Weekly:",
      percentRemaining: 100,
      semantic: { metric: { kind: "window", window: "week" } },
    });
    expect(out.entries.every((entry) => !("window" in entry))).toBe(true);
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([
        {
          key: "five_hour_usage",
          value: expect.stringMatching(/^percent_remaining=98 reset_at=/u),
        },
        {
          key: "weekly_usage",
          value: expect.stringMatching(/^percent_remaining=100 reset_at=/u),
        },
      ]),
    );
  });

  it("keeps window discrimination on internal query entries", async () => {
    mockMiniMaxHttpSuccess([createCodingPlanModel({ model_name: "MiniMax-M2.7" })]);

    const out = await queryMiniMaxQuota("intl-key");

    expectAttemptedWithNoErrors(out);
    expect(out.entries.map((entry) => entry.semantic?.metric)).toEqual([
      { kind: "window", window: "five_hour" },
      { kind: "window", window: "week" },
    ]);
    expect(out.entries.map((entry) => entry.name)).toEqual([
      "minimax-token-plan-5h",
      "minimax-token-plan-week",
    ]);
  });

  it("uses the China Token Plan endpoint for the MiniMax China provider", async () => {
    mockMiniMaxChinaAuthConfigured("china-key");
    mockMiniMaxHttpSuccess([createCodingPlanModel({ model_name: "MiniMax-M2.7" })]);

    const out = await runChinaProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      "https://api.minimaxi.com/v1/token_plan/remains",
      expect.objectContaining({
        request: expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({ Authorization: "Bearer china-key" }),
        }),
        timeoutMs: undefined,
        consume: expect.any(Function),
      }),
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
      name: "minimax-token-plan-5h",
      group: "MiniMax Token Plan (CN)",
      percentRemaining: 20,
      semantic: { metric: { kind: "window", window: "five_hour" } },
      basis: {
        used: { quantity: { decimal: "1200" }, authority: "provider_reported" },
        limit: { quantity: { decimal: "1500" }, authority: "provider_reported" },
        remaining: { quantity: { decimal: "300" }, authority: "locally_derived" },
      },
    });
    expect(out.entries[0]).not.toHaveProperty("window");
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([
        {
          key: "five_hour_usage",
          value: expect.stringMatching(/^percent_remaining=20 reset_at=/u),
        },
      ]),
    );
    expect(out.statusDetails).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "weekly_usage" })]),
    );
  });

  it.each([
    { rawUsed: 0, remaining: 1500, percentRemaining: 100 },
    { rawUsed: 1500, remaining: 0, percentRemaining: 0 },
    { rawUsed: 13, total: 15000, remaining: 14987, percentRemaining: 100 },
    { rawUsed: 1550, remaining: -50, percentRemaining: -3 },
  ])("normalizes China Token Plan used count $rawUsed", async ({
    rawUsed,
    total = 1500,
    remaining,
    percentRemaining,
  }) => {
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
      percentRemaining,
      basis: {
        used: { quantity: { decimal: String(rawUsed) } },
        limit: { quantity: { decimal: String(total) } },
        remaining: { quantity: { decimal: String(remaining) } },
      },
    });
  });

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
      percentRemaining: 7,
      basis: {
        used: { quantity: { decimal: "1400" } },
        limit: { quantity: { decimal: "1500" } },
        remaining: { quantity: { decimal: "100" } },
      },
    });
  });

  it("uses the international Coding Plan endpoint by default", async () => {
    mockMiniMaxHttpSuccess([createCodingPlanModel()]);

    await queryMiniMaxQuota("intl-key");

    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      "https://api.minimax.io/v1/api/openplatform/coding_plan/remains",
      expect.objectContaining({
        request: expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer intl-key" }),
        }),
        timeoutMs: undefined,
        consume: expect.any(Function),
      }),
    );
  });

  it("accepts international general rows and excludes video quota", async () => {
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
      percentRemaining: 20,
      basis: {
        used: { quantity: { decimal: "8" } },
        limit: { quantity: { decimal: "10" } },
        remaining: { quantity: { decimal: "2" } },
      },
    });
  });

  it("falls back to provider-reported percentages for zero-count international rows", async () => {
    mockMiniMaxAuthConfigured();
    mockMiniMaxHttpSuccess([
      createCodingPlanModel({
        model_name: "general",
        current_interval_total_count: 0,
        current_interval_usage_count: 0,
        current_weekly_total_count: 0,
        current_weekly_usage_count: 0,
        current_interval_remaining_percent: 86,
        current_weekly_remaining_percent: 90,
      }),
    ]);

    const out = await runProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "minimax-coding-plan")).toMatchObject([
      { percentRemaining: 86 },
      { percentRemaining: 90 },
    ]);
    expect(out.entries.every((entry) => !("basis" in entry))).toBe(true);
  });

  it("falls back to provider-reported percentages when count fields are missing", async () => {
    mockMiniMaxAuthConfigured();
    mockMiniMaxHttpSuccess([
      {
        model_name: "general",
        remains_time: 13_987_604,
        weekly_remains_time: 564_787_604,
        current_interval_remaining_percent: 75,
        current_weekly_remaining_percent: 80,
      },
    ]);

    const out = await runProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "minimax-coding-plan")).toMatchObject([
      { percentRemaining: 75 },
      { percentRemaining: 80 },
    ]);
    expect(out.entries.every((entry) => !("basis" in entry))).toBe(true);
  });

  it.each([
    { name: "zero", value: 0, percentRemaining: 0 },
    { name: "negative", value: -25, percentRemaining: -25 },
    { name: "above 100", value: 140, percentRemaining: 100 },
  ])("preserves current percentage bounds for $name international fallback values", async ({
    value,
    percentRemaining,
  }) => {
    mockMiniMaxAuthConfigured();
    mockMiniMaxHttpSuccess([
      createCodingPlanModel({
        model_name: "general",
        current_interval_total_count: 0,
        current_interval_usage_count: 0,
        current_weekly_total_count: undefined,
        current_weekly_usage_count: undefined,
        weekly_remains_time: undefined,
        current_interval_remaining_percent: value,
      }),
    ]);

    const out = await runProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "minimax-coding-plan")).toMatchObject([
      { percentRemaining },
    ]);
    expect(out.entries[0]).not.toHaveProperty("basis");
  });

  it.each([
    { name: "missing", value: undefined },
    { name: "null", value: null },
    { name: "wrong type", value: "50" },
    { name: "NaN", value: Number.NaN },
    { name: "infinite", value: Number.POSITIVE_INFINITY },
  ])("omits $name international fallback percentages", async ({ value }) => {
    mockMiniMaxAuthConfigured();
    mockMiniMaxHttpSuccess([
      createCodingPlanModel({
        model_name: "general",
        current_interval_total_count: 0,
        current_interval_usage_count: 0,
        current_weekly_total_count: undefined,
        current_weekly_usage_count: undefined,
        weekly_remains_time: undefined,
        current_interval_remaining_percent: value,
      }),
    ]);

    const out = await runProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(0);
  });

  it("keeps valid international counts authoritative over provider-reported percentages", async () => {
    mockMiniMaxAuthConfigured();
    mockMiniMaxHttpSuccess([
      createCodingPlanModel({
        model_name: "general",
        current_interval_total_count: 100,
        current_interval_usage_count: 25,
        current_weekly_total_count: undefined,
        current_weekly_usage_count: undefined,
        weekly_remains_time: undefined,
        current_interval_remaining_percent: 90,
      }),
    ]);

    const out = await runProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "minimax-coding-plan")).toMatchObject([
      {
        percentRemaining: 25,
        basis: {
          used: { quantity: { decimal: "75" } },
          limit: { quantity: { decimal: "100" } },
          remaining: { quantity: { decimal: "25" } },
        },
      },
    ]);
  });

  it("does not apply the international percentage fallback to China endpoint counts", async () => {
    mockMiniMaxChinaAuthConfigured();
    mockMiniMaxHttpSuccess([
      createCodingPlanModel({
        current_interval_total_count: 0,
        current_interval_usage_count: 0,
        current_weekly_total_count: undefined,
        current_weekly_usage_count: undefined,
        weekly_remains_time: undefined,
        current_interval_remaining_percent: 80,
      }),
    ]);

    const out = await runChinaProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(0);
  });

  it("excludes video even when it has the lowest remaining percentage", async () => {
    mockMiniMaxAuthConfigured();
    mockMiniMaxHttpSuccess([
      createCodingPlanModel({
        model_name: "general",
        current_interval_total_count: 10,
        current_interval_usage_count: 8,
        current_weekly_total_count: undefined,
        current_weekly_usage_count: undefined,
        weekly_remains_time: undefined,
      }),
      createCodingPlanModel({
        model_name: "video",
        current_interval_total_count: 10,
        current_interval_usage_count: 2,
        current_weekly_total_count: undefined,
        current_weekly_usage_count: undefined,
        weekly_remains_time: undefined,
      }),
    ]);

    const out = await runProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]).toMatchObject({
      percentRemaining: 80,
      basis: {
        used: { quantity: { decimal: "2" } },
        limit: { quantity: { decimal: "10" } },
        remaining: { quantity: { decimal: "8" } },
      },
    });
  });

  it("uses provider percentages for CN general rows and excludes video rows", async () => {
    mockMiniMaxHttpSuccess([
      {
        model_name: "general",
        remains_time: 13_987_604,
        weekly_remains_time: 564_787_604,
        current_interval_remaining_percent: 33,
        current_weekly_remaining_percent: 46,
      },
      createCodingPlanModel({
        model_name: "video",
        current_interval_total_count: 100,
        current_interval_usage_count: 99,
        current_weekly_total_count: undefined,
        current_weekly_usage_count: undefined,
        weekly_remains_time: undefined,
      }),
    ]);

    const out = await queryMiniMaxQuota("china-key", { endpoint: "china" });

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toMatchObject([
      {
        name: "minimax-token-plan-5h",
        percentRemaining: 33,
        semantic: { metric: { kind: "window", window: "five_hour" } },
      },
      {
        name: "minimax-token-plan-week",
        percentRemaining: 46,
        semantic: { metric: { kind: "window", window: "week" } },
      },
    ]);
    expect(out.entries.every((entry) => !("basis" in entry))).toBe(true);
  });

  it("keeps positive CN general counts authoritative over provider percentages", async () => {
    mockMiniMaxChinaAuthConfigured();
    mockMiniMaxHttpSuccess([
      createCodingPlanModel({
        model_name: "general",
        current_interval_total_count: 100,
        current_interval_usage_count: 25,
        current_weekly_total_count: undefined,
        current_weekly_usage_count: undefined,
        weekly_remains_time: undefined,
        current_interval_remaining_percent: 90,
      }),
    ]);

    const out = await runChinaProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]).toMatchObject({
      percentRemaining: 75,
      basis: {
        used: { quantity: { decimal: "25" } },
        limit: { quantity: { decimal: "100" } },
        remaining: { quantity: { decimal: "75" } },
      },
    });
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
      percentRemaining: -1,
      basis: {
        used: { quantity: { decimal: "4550" }, authority: "locally_derived" },
        limit: { quantity: { decimal: "4500" }, authority: "provider_reported" },
        remaining: { quantity: { decimal: "-50" }, authority: "provider_reported" },
      },
    });
    expect(out.entries[1]).toMatchObject({
      percentRemaining: -1,
      basis: {
        used: { quantity: { decimal: "45500" } },
        limit: { quantity: { decimal: "45000" } },
        remaining: { quantity: { decimal: "-500" } },
      },
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
      percentRemaining: 96,
      basis: {
        used: { quantity: { decimal: "200" } },
        remaining: { quantity: { decimal: "4300" } },
      },
    });
    expect(out.entries[1]).toMatchObject({
      percentRemaining: 99,
      basis: {
        used: { quantity: { decimal: "500" } },
        remaining: { quantity: { decimal: "44500" } },
      },
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
      percentRemaining: 98,
      basis: {
        used: { quantity: { decimal: "100" } },
        remaining: { quantity: { decimal: "4400" } },
      },
    });
    expect(out.entries[1]).toMatchObject({
      percentRemaining: 100,
      basis: {
        used: { quantity: { decimal: "105" } },
        remaining: { quantity: { decimal: "44895" } },
      },
    });
  });

  it("returns error on API failure", async () => {
    mockMiniMaxAuthConfigured();
    mockMiniMaxHttpFailure(401, "Unauthorized");

    const out = await minimaxCodingPlanProvider.fetch({ config: {} } as any);
    expectAttemptedWithErrorLabel(out, "MiniMax Token Plan");
    expect(out.errors[0]?.message).toContain("401");
  });

  it("sanitizes remote response text in API errors", async () => {
    mockMiniMaxAuthConfigured();
    mockMiniMaxHttpFailure(401, "\u001b[31mUnauthorized\nretry later\u001b[0m");

    const out = await minimaxCodingPlanProvider.fetch({ config: {} } as any);
    expectAttemptedWithErrorLabel(out, "MiniMax Token Plan");
    expect(out.errors[0]?.message).toBe("MiniMax API error 401: Unauthorized retry later");
  });

  it("returns error on non-zero status code", async () => {
    mockMiniMaxAuthConfigured();
    mocks.fetchResponse.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        model_remains: [],
        base_resp: { status_code: 1001, status_msg: "invalid token" },
      }),
    });

    const out = await minimaxCodingPlanProvider.fetch({ config: {} } as any);
    expectAttemptedWithErrorLabel(out, "MiniMax Token Plan");
    expect(out.errors[0]?.message).toContain("invalid token");
  });

  it("sanitizes status messages and thrown errors", async () => {
    mockMiniMaxAuthConfigured();
    mocks.fetchResponse.mockResolvedValueOnce({
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
    expectAttemptedWithErrorLabel(statusOut, "MiniMax Token Plan");
    expect(statusOut.errors[0]?.message).toBe(
      `MiniMax API error: ${`${"x".repeat(140)} retry`.slice(0, 120)}`,
    );

    mockMiniMaxAuthConfigured();
    mocks.fetchResponse.mockRejectedValueOnce(new Error("network\nfailed"));

    const thrownOut = await minimaxCodingPlanProvider.fetch({ config: {} } as any);
    expectAttemptedWithErrorLabel(thrownOut, "MiniMax Token Plan");
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
