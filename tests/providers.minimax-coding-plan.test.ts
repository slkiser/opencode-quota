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
  resolveMiniMaxAuthCached: mocks.resolveMiniMaxAuthCached,
  resolveMiniMaxChinaAuthCached: mocks.resolveMiniMaxChinaAuthCached,
  getMiniMaxAuthDiagnostics: vi.fn(async () => ({
    state: "none",
    source: null,
    checkedPaths: [],
    authPaths: [],
  })),
  getMiniMaxChinaAuthDiagnostics: vi.fn(async () => ({
    state: "none",
    source: null,
    checkedPaths: [],
    authPaths: [],
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

  it("maps MiniMax-M* model to 5h+weekly with credit basis (REQUEST_UNIT, 3 facts)", async () => {
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
    });
    expect(out.entries[1]).toMatchObject({
      name: "minimax-token-plan-week",
      group: "MiniMax Token Plan",
      label: "Weekly:",
      percentRemaining: 100,
      semantic: { metric: { kind: "window", window: "week" } },
    });
    // 3-fact basis, all REQUEST_UNIT
    for (const entry of out.entries) {
      expect(entry.basis).toMatchObject({
        used: { quantity: { unit: { kind: "count", unit: "request" } } },
        limit: { quantity: { unit: { kind: "count", unit: "request" } } },
        remaining: { quantity: { unit: { kind: "count", unit: "request" } } },
      });
    }
  });

  it("keeps window discrimination on internal query entries", async () => {
    mockMiniMaxHttpSuccess([createCodingPlanModel({ model_name: "MiniMax-M2.7" })]);

    const out = await queryMiniMaxQuota("intl-key");
    expect(out).not.toBeNull();
    if (out === null || "error" in out) throw new Error("Expected successful MiniMax query");
    expect(out.entries.map((entry) => entry.semantic?.metric?.window)).toEqual([
      "five_hour",
      "week",
    ]);
    expect(out.entries.map((entry) => entry.name)).toEqual([
      "minimax-token-plan-5h",
      "minimax-token-plan-week",
    ]);
  });

  it("omits basis for general bucket (total=0, percent only)", async () => {
    mockMiniMaxAuthConfigured();
    mockMiniMaxHttpSuccess([
      createCodingPlanModel({
        model_name: "general",
        current_interval_total_count: 0,
        current_interval_usage_count: 0,
        current_weekly_total_count: 0,
        current_weekly_usage_count: 0,
        current_interval_remaining_percent: 95,
        current_weekly_remaining_percent: 74,
      }),
    ]);

    const out = await runProviderFetch();
    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(2);
    for (const entry of out.entries) {
      expect(entry.basis).toBeUndefined();
    }
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
