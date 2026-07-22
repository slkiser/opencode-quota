import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import superGrokWeeklyFixture from "./fixtures/xai/supergrok-weekly.json";
import { hasXaiOAuth, periodKindLabel, queryXaiQuota, resolveXaiOAuth } from "../src/lib/xai.js";

vi.mock("../src/lib/opencode-auth.js", () => ({
  readAuthFileCached: vi.fn(),
}));

async function mockConfiguredAuth(overrides: Record<string, unknown> = {}): Promise<void> {
  const { readAuthFileCached } = await import("../src/lib/opencode-auth.js");
  (readAuthFileCached as any).mockResolvedValueOnce({
    xai: {
      type: "oauth",
      access: "token-1",
      expires: Date.now() + 60_000,
      ...overrides,
    },
  });
}

describe("xAI auth resolution", () => {
  it("resolves only the read-only xai OAuth access token", () => {
    expect(
      resolveXaiOAuth({
        xai: { type: "oauth", access: " token-1 ", refresh: "ignored", expires: 123 },
      }),
    ).toEqual({
      state: "configured",
      accessToken: "token-1",
      expiresAt: 123,
    });

    expect(hasXaiOAuth({ xai: { type: "api", access: "token-1" } })).toBe(false);
    expect(hasXaiOAuth({ xai: { type: "oauth", access: "   " } })).toBe(false);
    expect(hasXaiOAuth({ grok: { type: "oauth", access: "token-1" } } as any)).toBe(false);
    expect(hasXaiOAuth({ "x-ai": { type: "oauth", access: "token-1" } } as any)).toBe(false);
    expect(hasXaiOAuth({})).toBe(false);
  });

  it("ignores a malformed optional expiry while retaining a complete bearer token", () => {
    expect(
      resolveXaiOAuth({
        xai: { type: "oauth", access: "token-1", expires: Number.NaN },
      }),
    ).toEqual({
      state: "configured",
      accessToken: "token-1",
      expiresAt: undefined,
    });
  });
});

describe("queryXaiQuota", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns null for missing, wrong-type, and incomplete auth", async () => {
    const { readAuthFileCached } = await import("../src/lib/opencode-auth.js");
    (readAuthFileCached as any)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ xai: { type: "api", key: "xai-key" } })
      .mockResolvedValueOnce({ xai: { type: "oauth", refresh: "refresh-only" } });

    await expect(queryXaiQuota()).resolves.toBeNull();
    await expect(queryXaiQuota()).resolves.toBeNull();
    await expect(queryXaiQuota()).resolves.toBeNull();
  });

  it("does not refresh, fetch, or write an expired token", async () => {
    const { readAuthFileCached } = await import("../src/lib/opencode-auth.js");
    (readAuthFileCached as any).mockResolvedValueOnce({
      xai: {
        type: "oauth",
        access: "expired-token",
        refresh: "refresh-1",
        expires: Date.now() - 1_000,
      },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(queryXaiQuota()).resolves.toEqual({
      success: false,
      error: "xAI OAuth token expired; use xAI in OpenCode to refresh it or reconnect xAI",
    });
    expect(readAuthFileCached).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps the exact PR fixture through one fixed authenticated GET", async () => {
    await mockConfiguredAuth();

    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(superGrokWeeklyFixture), { status: 200 }),
    ) as any;
    vi.stubGlobal("fetch", fetchMock);

    await expect(queryXaiQuota({ requestTimeoutMs: 3_210 })).resolves.toEqual({
      success: true,
      label: "xAI SuperGrok",
      window: {
        percentRemaining: 95,
        resetTimeIso: "2026-07-20T02:24:00.983Z",
        kind: "weekly",
      },
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://cli-chat-proxy.grok.com/v1/billing?format=credits");
    expect(init).toEqual({
      method: "GET",
      headers: {
        Authorization: "Bearer token-1",
        Accept: "application/json",
        "User-Agent": "OpenCode-Quota-Toast/1.0",
        "x-grok-client-surface": "grok-build",
        "x-grok-client-version": "1.0.0",
      },
      signal: expect.any(AbortSignal),
    });
    expect(init).not.toHaveProperty("body");
  });

  it("treats an omitted protobuf percentage as 0% used when a period exists", async () => {
    await mockConfiguredAuth();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              config: {
                currentPeriod: {
                  type: "USAGE_PERIOD_TYPE_WEEKLY",
                  end: "2026-07-20T02:24:00.983423+00:00",
                },
              },
            }),
            { status: 200 },
          ),
      ) as any,
    );

    await expect(queryXaiQuota()).resolves.toEqual({
      success: true,
      label: "xAI SuperGrok",
      window: {
        percentRemaining: 100,
        resetTimeIso: "2026-07-20T02:24:00.983Z",
        kind: "weekly",
      },
    });
  });

  it("uses the exact billingPeriodEnd reset fallback from the PR", async () => {
    await mockConfiguredAuth();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              config: {
                currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY" },
                creditUsagePercent: 25,
                billingPeriodEnd: "2026-08-01T00:00:00Z",
              },
            }),
            { status: 200 },
          ),
      ) as any,
    );

    await expect(queryXaiQuota()).resolves.toEqual({
      success: true,
      label: "xAI SuperGrok",
      window: {
        percentRemaining: 75,
        resetTimeIso: "2026-08-01T00:00:00.000Z",
        kind: "monthly",
      },
    });
  });

  it("rejects malformed percentages and response shapes", async () => {
    await mockConfiguredAuth();
    await mockConfiguredAuth();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              config: {
                currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" },
                creditUsagePercent: "100",
              },
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 })),
    );

    await expect(queryXaiQuota()).resolves.toEqual({
      success: false,
      error: "xAI credits response returned an invalid usage percentage",
    });
    await expect(queryXaiQuota()).resolves.toEqual({
      success: false,
      error: "xAI credits response returned an unexpected response shape",
    });
  });

  it("reports missing period data instead of inventing quota", async () => {
    await mockConfiguredAuth();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ config: { currentPeriod: {} } }), { status: 200 }),
      ) as any,
    );

    await expect(queryXaiQuota()).resolves.toEqual({
      success: false,
      error: "No weekly quota data",
    });
  });

  it("bounds and sanitizes HTTP errors without exposing the bearer token", async () => {
    await mockConfiguredAuth();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(`denied\u001b[31m token-1 ${"x".repeat(300)}`, {
            status: 401,
          }),
      ) as any,
    );

    const result = await queryXaiQuota();
    expect(result && !result.success ? result.error : "").toMatch(
      /^xAI API error 401: denied \[redacted\] x+$/,
    );
    expect(result && !result.success ? result.error : "").not.toContain("token-1");
    expect(result && !result.success ? result.error.length : 0).toBeLessThanOrEqual(180);
  });

  it("sanitizes network errors without exposing the bearer token", async () => {
    await mockConfiguredAuth();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("socket failed for token-1\u001b[31m");
      }) as any,
    );

    await expect(queryXaiQuota()).resolves.toEqual({
      success: false,
      error: "socket failed for [redacted]",
    });
  });

  it("returns the normalized timeout error", async () => {
    vi.useFakeTimers();
    await mockConfiguredAuth();

    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock as any);

    const resultPromise = queryXaiQuota({ requestTimeoutMs: 1_000 });
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(resultPromise).resolves.toEqual({
      success: false,
      error: "Request timeout after 1s",
    });
  });
});

describe("periodKindLabel", () => {
  it("labels only the period kinds derived from the PR response", () => {
    expect(periodKindLabel("weekly")).toBe("Weekly");
    expect(periodKindLabel("monthly")).toBe("Monthly");
    expect(periodKindLabel("daily")).toBe("Daily");
    expect(periodKindLabel("period")).toBe("Period");
  });
});
