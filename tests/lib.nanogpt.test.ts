import { afterEach, describe, expect, it, vi } from "vitest";

import { queryNanoGptQuota } from "../src/lib/nanogpt.js";

vi.mock("../src/lib/nanogpt-config.js", () => ({
  resolveNanoGptApiKey: vi.fn(),
  hasNanoGptApiKey: vi.fn(),
  getNanoGptKeyDiagnostics: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("queryNanoGptQuota", () => {
  it("returns null when not configured", async () => {
    const { resolveNanoGptApiKey } = await import("../src/lib/nanogpt-config.js");
    (resolveNanoGptApiKey as any).mockResolvedValueOnce(null);

    await expect(queryNanoGptQuota()).resolves.toBeNull();
  });

  it("returns weekly, image, and daily token usage from the subscription endpoint", async () => {
    const { resolveNanoGptApiKey } = await import("../src/lib/nanogpt-config.js");
    (resolveNanoGptApiKey as any).mockResolvedValueOnce({
      key: "nano-key",
      source: "env:NANOGPT_API_KEY",
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain("/subscription/v1/usage");
      expect(init?.method).toBe("GET");
      expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("nano-key");

      return new Response(
        JSON.stringify({
          active: true,
          limits: {
            weeklyInputTokens: 60_000_000,
            dailyInputTokens: 250_000,
            dailyImages: 100,
          },
          enforceDailyLimit: true,
          weeklyInputTokens: {
            used: 59_650_170,
            remaining: 349_830,
            percentUsed: 0.9941695,
            resetAt: 1_738_540_800_000,
          },
          dailyInputTokens: {
            used: 25_000,
            remaining: 225_000,
            percentUsed: 0.1,
            resetAt: 1_738_540_800_000,
          },
          dailyImages: {
            used: 0,
            remaining: 100,
            percentUsed: 0,
            resetAt: 1_738_540_800_000,
          },
          state: "active",
          graceUntil: null,
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock as any);

    await expect(queryNanoGptQuota()).resolves.toEqual({
      success: true,
      subscription: {
        active: true,
        state: "active",
        enforceDailyLimit: true,
        weeklyInputTokens: {
          used: 59_650_170,
          limit: 60_000_000,
          remaining: 349_830,
          percentRemaining: 1,
          resetTimeIso: "2025-02-03T00:00:00.000Z",
        },
        dailyImages: {
          used: 0,
          limit: 100,
          remaining: 100,
          percentRemaining: 100,
          resetTimeIso: "2025-02-03T00:00:00.000Z",
        },
        dailyInputTokens: {
          used: 25_000,
          limit: 250_000,
          remaining: 225_000,
          percentRemaining: 90,
          resetTimeIso: "2025-02-03T00:00:00.000Z",
        },
        graceUntilIso: undefined,
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("omits daily token usage when the API does not return it", async () => {
    const { resolveNanoGptApiKey } = await import("../src/lib/nanogpt-config.js");
    (resolveNanoGptApiKey as any).mockResolvedValueOnce({
      key: "nano-key",
      source: "env:NANOGPT_API_KEY",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            active: false,
            limits: {
              weeklyInputTokens: 60_000_000,
              dailyImages: 100,
            },
            enforceDailyLimit: true,
            weeklyInputTokens: {
              used: 500,
              remaining: 59_999_500,
              percentUsed: 0.000008333333333333334,
              resetAt: 1_735_776_000_000,
            },
            dailyInputTokens: null,
            dailyImages: {
              used: 25,
              remaining: 75,
              percentUsed: 0.25,
              resetAt: 1_735_776_000_000,
            },
            state: "grace",
            graceUntil: "2026-01-09T00:00:00.000Z",
          }),
          { status: 200 },
        );
      }) as any,
    );

    await expect(queryNanoGptQuota()).resolves.toEqual({
      success: true,
      subscription: {
        active: false,
        state: "grace",
        enforceDailyLimit: true,
        weeklyInputTokens: {
          used: 500,
          limit: 60_000_000,
          remaining: 59_999_500,
          percentRemaining: 100,
          resetTimeIso: "2025-01-02T00:00:00.000Z",
        },
        dailyImages: {
          used: 25,
          limit: 100,
          remaining: 75,
          percentRemaining: 75,
          resetTimeIso: "2025-01-02T00:00:00.000Z",
        },
        dailyInputTokens: undefined,
        graceUntilIso: "2026-01-09T00:00:00.000Z",
      },
    });
  });

  it("returns an error for unexpected response shapes", async () => {
    const { resolveNanoGptApiKey } = await import("../src/lib/nanogpt-config.js");
    (resolveNanoGptApiKey as any).mockResolvedValueOnce({
      key: "nano-key",
      source: "env:NANOGPT_API_KEY",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ nope: true }), { status: 200 })) as any,
    );

    await expect(queryNanoGptQuota()).resolves.toEqual({
      success: false,
      error: "NanoGPT usage response returned an unexpected response shape",
    });
  });

  it("returns API errors when the usage endpoint fails", async () => {
    const { resolveNanoGptApiKey } = await import("../src/lib/nanogpt-config.js");
    (resolveNanoGptApiKey as any).mockResolvedValueOnce({
      key: "nano-key",
      source: "env:NANOGPT_API_KEY",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad gateway", { status: 502 })) as any,
    );

    await expect(queryNanoGptQuota()).resolves.toEqual({
      success: false,
      error: "NanoGPT API error 502: bad gateway",
    });
  });

  it("returns caught errors when fetch fails", async () => {
    const { resolveNanoGptApiKey } = await import("../src/lib/nanogpt-config.js");
    (resolveNanoGptApiKey as any).mockResolvedValueOnce({
      key: "nano-key",
      source: "env:NANOGPT_API_KEY",
    });

    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("network down"))) as any);

    await expect(queryNanoGptQuota()).resolves.toEqual({
      success: false,
      error: "network down",
    });
  });
});
