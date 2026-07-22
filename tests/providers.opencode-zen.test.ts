import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
} from "./helpers/provider-assertions.js";

const mocks = vi.hoisted(() => ({
  queryOpenCodeZenQuota: vi.fn(),
  resolveOpenCodeZenConfigCached: vi.fn(),
}));

vi.mock("../src/lib/opencode-zen.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/opencode-zen.js")>();
  return {
    ...original,
    queryOpenCodeZenQuota: mocks.queryOpenCodeZenQuota,
  };
});

vi.mock("../src/lib/opencode-zen-config.js", () => ({
  DEFAULT_OPENCODE_ZEN_CONFIG_CACHE_MAX_AGE_MS: 30_000,
  resolveOpenCodeZenConfigCached: mocks.resolveOpenCodeZenConfigCached,
}));

import { opencodeZenProvider } from "../src/providers/opencode-zen.js";

const accounting = {
  resultType: "balance",
  acquisitionMethod: "dashboard_scrape",
  ownership: "maintained",
  authority: "provider_reported",
} as const;

function configured(): void {
  mocks.resolveOpenCodeZenConfigCached.mockResolvedValueOnce({
    state: "configured",
    config: { workspaceId: "wrk_123", authCookie: "cookie-abc" },
    source: "env(OPENCODE_*)",
  });
}

function success(overrides: Record<string, unknown> = {}): void {
  mocks.queryOpenCodeZenQuota.mockResolvedValueOnce({
    success: true,
    data: {
      balance: 4_250_000_000,
      monthlyLimit: null,
      monthlyUsage: null,
      lastPayment: null,
      ...overrides,
    },
  });
}

function context(config: Record<string, unknown> = {}): any {
  return { config };
}

describe("opencode Zen provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the original canonical provider id", () => {
    expect(opencodeZenProvider.id).toBe("opencode");
  });

  it.each([
    [
      {
        state: "configured",
        config: { workspaceId: "wrk", authCookie: "cookie" },
        source: "env(OPENCODE_*)",
      },
      true,
    ],
    [{ state: "incomplete", source: "env", missing: "authCookie" }, false],
    [{ state: "invalid", source: "/tmp/opencode.json", error: "broken" }, false],
    [{ state: "none" }, false],
  ])("reports availability for config state %j", async (configState, expected) => {
    mocks.resolveOpenCodeZenConfigCached.mockResolvedValueOnce(configState);
    await expect(opencodeZenProvider.isAvailable(context())).resolves.toBe(expected);
  });

  it.each([
    ["opencode/gpt-5", true],
    ["opencode-zen/claude-opus", true],
    ["OPENCODE/gemini", true],
    ["openai/gpt-5", false],
    ["opencode-go/model", false],
  ])("matchesCurrentModel(%s) -> %s", (model, expected) => {
    expect(opencodeZenProvider.matchesCurrentModel?.(model)).toBe(expected);
  });

  it("returns attempted:false when configuration is absent", async () => {
    mocks.resolveOpenCodeZenConfigCached.mockResolvedValueOnce({ state: "none" });
    expectNotAttempted(await opencodeZenProvider.fetch(context()));
    expect(mocks.queryOpenCodeZenQuota).not.toHaveBeenCalled();
  });

  it.each([
    [
      { state: "incomplete", source: "env(OPENCODE_*)", missing: "OPENCODE_AUTH_COOKIE" },
      "Missing OPENCODE_AUTH_COOKIE",
    ],
    [{ state: "invalid", source: "/tmp/opencode.json", error: "bad JSON" }, "Invalid config"],
  ])("projects config state as an attempted error", async (configState, message) => {
    mocks.resolveOpenCodeZenConfigCached.mockResolvedValueOnce(configState);
    const result = await opencodeZenProvider.fetch(context());

    expectAttemptedWithErrorLabel(result, "OpenCode");
    expect(result.errors[0]?.message).toContain(message);
    expect(mocks.queryOpenCodeZenQuota).not.toHaveBeenCalled();
  });

  it("projects scraper failures as attempted errors", async () => {
    configured();
    mocks.queryOpenCodeZenQuota.mockResolvedValueOnce({
      success: false,
      error: "OpenCode Zen billing error 403",
    });

    const result = await opencodeZenProvider.fetch(context());

    expectAttemptedWithErrorLabel(result, "OpenCode");
    expect(result.errors[0]?.message).toBe("OpenCode Zen billing error 403");
  });

  it("returns the original value entry when no monthly limit is available", async () => {
    configured();
    success();

    const result = await opencodeZenProvider.fetch(context());

    expectAttemptedWithNoErrors(result);
    expect(result.entries).toEqual([
      {
        accounting,
        kind: "value",
        name: "",
        group: "OpenCode Zen",
        value: "$42.50",
      },
    ]);
    expect(result.presentation).toBeUndefined();
  });

  it("returns the original percentage entry when the page reports a monthly limit", async () => {
    configured();
    success({ monthlyLimit: 100, monthlyUsage: 575_000_000 });

    const result = await opencodeZenProvider.fetch(context());

    expectAttemptedWithNoErrors(result);
    expect(result.entries).toEqual([
      {
        accounting,
        name: "",
        group: "OpenCode Zen",
        percentRemaining: 42.5,
      },
    ]);
  });

  it("prefers the positive plugin monthly-limit override", async () => {
    configured();
    success({ monthlyLimit: 100 });

    const result = await opencodeZenProvider.fetch(context({ opencodeMonthlyLimit: 200 }));

    expectAttemptedWithNoErrors(result);
    expect(result.entries[0]).toMatchObject({ percentRemaining: 21.25 });
  });

  it("uses the last payment when neither config nor page limit is available", async () => {
    configured();
    success({ lastPayment: 50 });

    const result = await opencodeZenProvider.fetch(context());

    expectAttemptedWithNoErrors(result);
    expect(result.entries[0]).toMatchObject({ percentRemaining: 85 });
  });

  it("uses value display for a zero page limit instead of emitting NaN", async () => {
    configured();
    success({ monthlyLimit: 0 });

    const result = await opencodeZenProvider.fetch(context());

    expectAttemptedWithNoErrors(result);
    expect(result.entries[0]).toMatchObject({ kind: "value", value: "$42.50" });
    expect(JSON.stringify(result)).not.toContain("NaN");
  });

  it("clamps balance percentages to 100", async () => {
    configured();
    success({ balance: 20_000_000_000, monthlyLimit: 100 });

    const result = await opencodeZenProvider.fetch(context());

    expectAttemptedWithNoErrors(result);
    expect(result.entries[0]).toMatchObject({ percentRemaining: 100 });
  });

  it("passes a user-configured timeout and otherwise keeps the scraper default", async () => {
    configured();
    success();
    await opencodeZenProvider.fetch(
      context({ requestTimeoutMs: 7_654, requestTimeoutMsConfigured: true }),
    );
    expect(mocks.queryOpenCodeZenQuota).toHaveBeenLastCalledWith("wrk_123", "cookie-abc", {
      requestTimeoutMs: 7_654,
    });

    configured();
    success();
    await opencodeZenProvider.fetch(
      context({ requestTimeoutMs: 5_000, requestTimeoutMsConfigured: false }),
    );
    expect(mocks.queryOpenCodeZenQuota).toHaveBeenLastCalledWith("wrk_123", "cookie-abc", {
      requestTimeoutMs: undefined,
    });
  });
});
