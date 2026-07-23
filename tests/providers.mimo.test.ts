import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
  visibleEntries,
} from "./helpers/provider-assertions.js";

const mocks = vi.hoisted(() => ({
  resolveMimoConfigCached: vi.fn(),
  queryMimoDashboard: vi.fn(),
}));

vi.mock("../src/lib/mimo-config.js", () => ({
  DEFAULT_MIMO_CONFIG_CACHE_MAX_AGE_MS: 30_000,
  resolveMimoConfigCached: mocks.resolveMimoConfigCached,
}));

vi.mock("../src/lib/mimo.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/mimo.js")>();
  return {
    ...original,
    queryMimoDashboard: mocks.queryMimoDashboard,
  };
});

import { xiaomiProvider } from "../src/providers/mimo.js";

const quotaAccounting = {
  resultType: "quota",
  acquisitionMethod: "dashboard_scrape",
  ownership: "maintained",
  authority: "provider_reported",
} as const;
const balanceAccounting = {
  resultType: "balance",
  acquisitionMethod: "dashboard_scrape",
  ownership: "maintained",
  authority: "provider_reported",
} as const;

function context(config: Record<string, unknown> = {}): any {
  return { config };
}

function configured(): void {
  mocks.resolveMimoConfigCached.mockResolvedValueOnce({
    state: "configured",
    source: "env:MIMO_USAGE_COOKIE",
    config: {
      cookie: "api-platform_serviceToken=service-secret; userId=user-secret",
    },
  });
}

function dashboard(overrides: Record<string, unknown> = {}): void {
  mocks.queryMimoDashboard.mockResolvedValueOnce({
    usage: { state: "success", data: { used: 10_100_158, limit: 200_000_000 } },
    detail: {
      state: "success",
      data: { planName: "Standard", planCode: "standard_monthly", expired: false },
    },
    balance: {
      state: "success",
      data: { total: 50, cash: 30, gift: 20, currency: "USD" },
    },
    ...overrides,
  });
}

describe("Xiaomi MiMo provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses canonical xiaomi provider identity", () => {
    expect(xiaomiProvider.id).toBe("xiaomi");
  });

  it.each([
    [{ state: "configured", config: { cookie: "filtered" }, source: "env" }, true],
    [{ state: "invalid", source: "env", error: "Invalid cookie header" }, false],
    [{ state: "none" }, false],
  ])("reports availability for config state %j", async (configState, expected) => {
    mocks.resolveMimoConfigCached.mockResolvedValueOnce(configState);
    await expect(xiaomiProvider.isAvailable(context())).resolves.toBe(expected);
  });

  it.each([
    ["xiaomi/mimo-v2", true],
    ["xiaomi-token-plan-cn/mimo-v2", true],
    ["xiaomi-token-plan-ams/mimo-v2", true],
    ["xiaomi-token-plan-sgp/mimo-v2", true],
    ["XIAOMI/MIMO-V2", true],
    ["mimo/mimo-v2", false],
    ["xiaomi-mimo/mimo-v2", false],
    ["openai/gpt-5", false],
  ])("matchesCurrentModel(%s) -> %s", (model, expected) => {
    expect(xiaomiProvider.matchesCurrentModel?.(model)).toBe(expected);
  });

  it("does not attempt a request without trusted configuration", async () => {
    mocks.resolveMimoConfigCached.mockResolvedValueOnce({ state: "none" });

    expectNotAttempted(await xiaomiProvider.fetch(context()));
    expect(mocks.queryMimoDashboard).not.toHaveBeenCalled();
  });

  it("projects invalid configuration as a safe attempted error", async () => {
    mocks.resolveMimoConfigCached.mockResolvedValueOnce({
      state: "invalid",
      source: "/tmp/config/opencode-quota/mimo.json",
      error: "Invalid cookie header",
    });

    const result = await xiaomiProvider.fetch(context());

    expectAttemptedWithErrorLabel(result, "Xiaomi MiMo");
    expect(result.errors[0]?.message).toBe(
      "Invalid config (/tmp/config/opencode-quota/mimo.json): Invalid cookie header",
    );
    expect(JSON.stringify(result)).not.toContain("api-platform_serviceToken");
    expect(JSON.stringify(result)).not.toContain("userId");
  });

  it("maps the named monthly quota and provider-reported balances", async () => {
    configured();
    dashboard();

    const result = await xiaomiProvider.fetch(context());

    expectAttemptedWithNoErrors(result);
    expect(result.entries).toHaveLength(4);
    expect(result.entries[0]).toEqual({
      accounting: quotaAccounting,
      name: "Xiaomi MiMo · Standard [standard_monthly] Monthly",
      group: "Xiaomi MiMo · Standard [standard_monthly]",
      label: "Monthly:",
      right: "10100158/200000000",
      percentRemaining: 94.949921,
    });
    expect(result.entries[0]).not.toHaveProperty("resetTimeIso");
    expect(result.entries.slice(1)).toEqual([
      {
        accounting: balanceAccounting,
        kind: "value",
        name: "Xiaomi MiMo Total Balance",
        group: "Xiaomi MiMo · Standard [standard_monthly]",
        label: "Total:",
        value: "$50.00",
      },
      {
        accounting: balanceAccounting,
        kind: "value",
        name: "Xiaomi MiMo Cash Balance",
        group: "Xiaomi MiMo · Standard [standard_monthly]",
        label: "Cash:",
        value: "$30.00",
      },
      {
        accounting: balanceAccounting,
        kind: "value",
        name: "Xiaomi MiMo Gift Balance",
        group: "Xiaomi MiMo · Standard [standard_monthly]",
        label: "Gift:",
        value: "$20.00",
      },
    ]);
    visibleEntries(result.entries, "xiaomi");
  });

  it("uses sanitized plan labels only as display enrichment", async () => {
    configured();
    dashboard({
      detail: {
        state: "success",
        data: {
          planName: "\u001b]2;title\u0007Premium\nPlan",
          planCode: "premium\u0007",
          expired: false,
        },
      },
      balance: { state: "success", data: { total: 1, cash: null, gift: null, currency: "EUR" } },
    });

    const result = await xiaomiProvider.fetch(context());

    expect(result.entries[0]?.group).toBe("Xiaomi MiMo · Premium Plan [premium]");
    expect(result.entries[1]).toMatchObject({ value: "EUR 1.00" });
    expect(JSON.stringify(result)).not.toContain("\u001b");
    expect(JSON.stringify(result)).not.toContain("\u0007");
  });

  it("suppresses an explicitly expired plan without hiding balances", async () => {
    configured();
    dashboard({
      detail: {
        state: "success",
        data: { planName: "Old plan", planCode: "old", expired: true },
      },
    });

    const result = await xiaomiProvider.fetch(context());

    expectAttemptedWithNoErrors(result);
    expect(result.entries).toHaveLength(3);
    expect(result.entries.every((entry) => entry.accounting.resultType === "balance")).toBe(true);
    expect(result.entries.every((entry) => entry.group === "Xiaomi MiMo")).toBe(true);
  });

  it("keeps monthly quota when detail fails and returns a partial result", async () => {
    configured();
    dashboard({
      detail: {
        state: "error",
        error: "Xiaomi MiMo detail response did not match the expected schema",
      },
      balance: {
        state: "error",
        error: "Xiaomi MiMo balance request failed (HTTP 503)",
      },
    });

    const result = await xiaomiProvider.fetch(context());

    expect(result.attempted).toBe(true);
    expect(result.entries).toEqual([
      {
        accounting: quotaAccounting,
        name: "Xiaomi MiMo Monthly",
        group: "Xiaomi MiMo",
        label: "Monthly:",
        right: "10100158/200000000",
        percentRemaining: 94.949921,
      },
    ]);
    expect(result.errors).toEqual([
      {
        label: "Xiaomi MiMo",
        message: "Xiaomi MiMo detail response did not match the expected schema",
      },
      {
        label: "Xiaomi MiMo",
        message: "Xiaomi MiMo balance request failed (HTTP 503)",
      },
    ]);
  });

  it("preserves zero optional balances and their deterministic order", async () => {
    configured();
    dashboard({
      usage: { state: "error", error: "usage unavailable" },
      balance: {
        state: "success",
        data: { total: 0, cash: null, gift: 0, currency: null },
      },
    });

    const result = await xiaomiProvider.fetch(context());

    expect(result.entries.map((entry) => entry.label)).toEqual(["Total:", "Gift:"]);
    expect(result.entries.map((entry) => ("value" in entry ? entry.value : null))).toEqual([
      "0.00",
      "0.00",
    ]);
    expect(result.errors).toEqual([{ label: "Xiaomi MiMo", message: "usage unavailable" }]);
  });

  it("returns all endpoint errors in fixed order when no data is available", async () => {
    configured();
    mocks.queryMimoDashboard.mockResolvedValueOnce({
      usage: { state: "error", error: "usage failed" },
      detail: { state: "error", error: "detail failed" },
      balance: { state: "error", error: "balance failed" },
    });

    const result = await xiaomiProvider.fetch(context());

    expect(result).toEqual({
      attempted: true,
      entries: [],
      errors: [
        { label: "Xiaomi MiMo", message: "usage failed" },
        { label: "Xiaomi MiMo", message: "detail failed" },
        { label: "Xiaomi MiMo", message: "balance failed" },
      ],
    });
  });

  it("passes a configured timeout and otherwise keeps the client default", async () => {
    configured();
    dashboard();
    await xiaomiProvider.fetch(
      context({ requestTimeoutMs: 7_654, requestTimeoutMsConfigured: true }),
    );
    expect(mocks.queryMimoDashboard).toHaveBeenLastCalledWith(
      "api-platform_serviceToken=service-secret; userId=user-secret",
      { requestTimeoutMs: 7_654 },
    );

    configured();
    dashboard();
    await xiaomiProvider.fetch(
      context({ requestTimeoutMs: 5_000, requestTimeoutMsConfigured: false }),
    );
    expect(mocks.queryMimoDashboard).toHaveBeenLastCalledWith(
      "api-platform_serviceToken=service-secret; userId=user-secret",
      { requestTimeoutMs: undefined },
    );
  });
});
