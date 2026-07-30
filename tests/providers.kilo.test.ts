import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
  visibleEntries,
} from "./helpers/provider-assertions.js";
import { buildCompactQuotaStatusLine } from "../src/lib/tui-compact-format.js";

const mocks = vi.hoisted(() => ({
  resolveKiloConfigCached: vi.fn(),
  queryKiloDashboard: vi.fn(),
}));

vi.mock("../src/lib/kilo-config.js", () => ({
  DEFAULT_KILO_CONFIG_CACHE_MAX_AGE_MS: 30_000,
  resolveKiloConfigCached: mocks.resolveKiloConfigCached,
  getKiloConfigDiagnostics: vi.fn(async () => ({
    state: "none",
    source: null,
    error: null,
    checkedPaths: [],
  })),
}));

vi.mock("../src/lib/kilo.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/kilo.js")>();
  return {
    ...original,
    queryKiloDashboard: mocks.queryKiloDashboard,
  };
});

import { kiloProvider } from "../src/providers/kilo.js";

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
const usageAccounting = {
  resultType: "usage",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
} as const;

function context(config: Record<string, unknown> = {}): any {
  return { config };
}

function configured(): void {
  mocks.resolveKiloConfigCached.mockResolvedValueOnce({
    state: "configured",
    source: "env:KILO_USAGE_COOKIE",
    config: { cookie: "__Secure-next-auth.session-token=session-secret" },
  });
}

function dashboard(overrides: Record<string, unknown> = {}): void {
  mocks.queryKiloDashboard.mockResolvedValueOnce({
    success: true,
    data: {
      usedMicrodollars: 12_500_000,
      limitMicrodollars: 50_000_000,
      balanceMicrodollars: 37_500_000,
      resetTimeIso: "2026-08-01T00:00:00.000Z",
      planName: "Kilo Pass",
      ...overrides,
    },
  });
}

describe("Kilo Gateway provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses canonical kilo provider identity", () => {
    expect(kiloProvider.id).toBe("kilo");
  });

  it.each([
    [{ state: "configured", config: { cookie: "filtered" }, source: "env" }, true],
    [{ state: "invalid", source: "env", error: "Invalid cookie header" }, false],
    [{ state: "none" }, false],
  ])("reports availability for config state %j", async (configState, expected) => {
    mocks.resolveKiloConfigCached.mockResolvedValueOnce(configState);
    await expect(kiloProvider.isAvailable(context())).resolves.toBe(expected);
  });

  it.each([
    ["kilo/claude-sonnet-4", true],
    ["kilo-gateway/gpt-5", true],
    ["kilo-code/model", true],
    ["KILO/GPT-5", true],
    ["openai/gpt-5", false],
  ])("matchesCurrentModel(%s) -> %s", (model, expected) => {
    expect(kiloProvider.matchesCurrentModel?.(model)).toBe(expected);
  });

  it("does not attempt a request without trusted configuration", async () => {
    mocks.resolveKiloConfigCached.mockResolvedValueOnce({ state: "none" });

    expectNotAttempted(await kiloProvider.fetch(context()));
    expect(mocks.queryKiloDashboard).not.toHaveBeenCalled();
  });

  it("projects invalid configuration as a safe attempted error", async () => {
    mocks.resolveKiloConfigCached.mockResolvedValueOnce({
      state: "invalid",
      source: "/tmp/config/opencode-quota/kilo.json",
      error: "Invalid cookie header",
    });

    const result = await kiloProvider.fetch(context());

    expectAttemptedWithErrorLabel(result, "Kilo Gateway");
    expect(result.errors[0]?.message).toBe(
      "Invalid config (/tmp/config/opencode-quota/kilo.json): Invalid cookie header",
    );
    expect(JSON.stringify(result)).not.toContain("session-secret");
  });

  it("maps credit balance with bonus breakdown", async () => {
    configured();
    dashboard({
      usedMicrodollars: 0,
      limitMicrodollars: 28_500_000,
      balanceMicrodollars: 19_000_000,
      periodBonusCreditsUsd: 9_500_000,
    });

    const result = await kiloProvider.fetch(context());

    expectAttemptedWithNoErrors(result);
    expect(result.entries).toEqual([
      {
        accounting: quotaAccounting,
        name: "Kilo Credits",
        group: "[Kilo] Kilo Pass",
        label: "Credits:",
        right: "$0/$28.50 +$9.50 bonus",
        percentRemaining: 100,
      },
      {
        accounting: balanceAccounting,
        kind: "value",
        name: "Kilo Credit Balance",
        group: "[Kilo] Kilo Pass",
        label: "Balance",
        value: "$19 +$9.50 bonus | Usage $0",
      },
    ]);
    visibleEntries(result.entries, "kilo");
  });

  it("formats compact credits with dynamic plan in parentheses", async () => {
    configured();
    dashboard({
      planName: "Starter",
      usedMicrodollars: 0,
      limitMicrodollars: 28_500_000,
      balanceMicrodollars: null,
    });

    const result = await kiloProvider.fetch(context());

    expectAttemptedWithNoErrors(result);
    expect(
      buildCompactQuotaStatusLine({
        data: { entries: result.entries, errors: [] },
        percentDisplayMode: "used",
        maxWidth: 120,
      }),
    ).toContain("[Kilo] (Starter) Credits");
  });

  it("keeps balance-only results", async () => {
    configured();
    dashboard({ usedMicrodollars: null, limitMicrodollars: null, balanceMicrodollars: 0 });

    const result = await kiloProvider.fetch(context());

    expectAttemptedWithNoErrors(result);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ kind: "value", value: "$0" });
  });

  it("maps personal usage summary without quota data", async () => {
    configured();
    dashboard({
      usedMicrodollars: 0,
      limitMicrodollars: null,
      balanceMicrodollars: null,
      planName: "Last 30 days",
      requestCount: 1,
      totalTokens: 52_876,
    });

    const result = await kiloProvider.fetch(context());

    expectAttemptedWithNoErrors(result);
    expect(result.entries).toEqual([
      {
        accounting: usageAccounting,
        kind: "value",
        name: "Kilo Usage",
        group: "[Kilo] Last 30 days",
        label: "Usage",
        value: "$0",
      },
    ]);
    visibleEntries(result.entries, "kilo");
  });

  it("passes a configured timeout and otherwise keeps the client default", async () => {
    configured();
    dashboard();
    await kiloProvider.fetch(context({ requestTimeoutMs: 7_654, requestTimeoutMsConfigured: true }));
    expect(mocks.queryKiloDashboard).toHaveBeenLastCalledWith(
      "__Secure-next-auth.session-token=session-secret",
      { requestTimeoutMs: 7_654 },
    );

    configured();
    dashboard();
    await kiloProvider.fetch(context({ requestTimeoutMs: 5_000, requestTimeoutMsConfigured: false }));
    expect(mocks.queryKiloDashboard).toHaveBeenLastCalledWith(
      "__Secure-next-auth.session-token=session-secret",
      { requestTimeoutMs: undefined },
    );
  });
});
