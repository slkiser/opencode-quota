import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import superGrokWeeklyFixture from "./fixtures/xai/supergrok-weekly.json";

const mocks = vi.hoisted(() => ({
  hasOpenCodeAuthContentOverride: vi.fn(),
  isCurrentXaiOAuth: vi.fn(),
  readAuthFile: vi.fn(),
  readAuthFileCached: vi.fn(),
  updateCurrentXaiOAuth: vi.fn(),
}));

vi.mock("../src/lib/opencode-auth.js", () => ({
  hasOpenCodeAuthContentOverride: mocks.hasOpenCodeAuthContentOverride,
  isCurrentXaiOAuth: mocks.isCurrentXaiOAuth,
  readAuthFile: mocks.readAuthFile,
  readAuthFileCached: mocks.readAuthFileCached,
  updateCurrentXaiOAuth: mocks.updateCurrentXaiOAuth,
}));

import {
  clearXaiOAuthRefreshForTests,
  hasXaiOAuth,
  periodKindLabel,
  queryXaiQuota,
  resolveXaiOAuth,
} from "../src/lib/xai.js";

function configureAuth(overrides: Record<string, unknown> = {}): void {
  mocks.readAuthFile.mockResolvedValueOnce({
    xai: {
      type: "oauth",
      access: "token-1",
      expires: Date.now() + 10 * 60_000,
      ...overrides,
    },
  });
}

function quotaResponse(): Response {
  return new Response(JSON.stringify(superGrokWeeklyFixture), { status: 200 });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasOpenCodeAuthContentOverride.mockReturnValue(false);
  mocks.isCurrentXaiOAuth.mockReset();
  mocks.readAuthFile.mockReset();
  mocks.readAuthFileCached.mockReset();
  mocks.updateCurrentXaiOAuth.mockReset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  clearXaiOAuthRefreshForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  clearXaiOAuthRefreshForTests();
});

describe("xAI auth resolution", () => {
  it("resolves only the xAI OAuth access and refresh tokens", () => {
    expect(
      resolveXaiOAuth({
        xai: { type: "oauth", access: " token-1 ", refresh: " refresh-1 ", expires: 123 },
      }),
    ).toEqual({
      state: "configured",
      accessToken: "token-1",
      refreshToken: "refresh-1",
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
      refreshToken: undefined,
      expiresAt: undefined,
    });
  });
});

describe("queryXaiQuota", () => {
  it("returns null for missing, wrong-type, and incomplete auth", async () => {
    mocks.readAuthFile
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ xai: { type: "api", key: "xai-key" } })
      .mockResolvedValueOnce({ xai: { type: "oauth", refresh: "refresh-only" } });

    await expect(queryXaiQuota()).resolves.toBeNull();
    await expect(queryXaiQuota()).resolves.toBeNull();
    await expect(queryXaiQuota()).resolves.toBeNull();
  });

  it("refreshes expired OAuth, persists it, then queries quota", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T00:00:00.000Z"));
    mocks.readAuthFile.mockResolvedValueOnce({
      xai: {
        type: "oauth",
        access: "expired-token",
        refresh: "refresh-1",
        expires: Date.now() - 1_000,
      },
    });
    mocks.isCurrentXaiOAuth.mockResolvedValueOnce(true);
    mocks.updateCurrentXaiOAuth.mockResolvedValueOnce(true);
    const fetchMock = vi.fn(async (url: string) =>
      url === "https://auth.x.ai/oauth2/token"
        ? new Response(
            JSON.stringify({
              access_token: "refreshed-access",
              refresh_token: "refreshed-refresh",
              expires_in: 3600,
            }),
            { status: 200 },
          )
        : quotaResponse(),
    ) as any;
    vi.stubGlobal("fetch", fetchMock);

    await expect(queryXaiQuota()).resolves.toMatchObject({
      success: true,
      window: { percentRemaining: 95, kind: "weekly" },
    });
    expect(mocks.updateCurrentXaiOAuth).toHaveBeenCalledWith({
      expectedAccess: "expired-token",
      expectedRefresh: "refresh-1",
      access: "refreshed-access",
      refresh: "refreshed-refresh",
      expires: Date.parse("2026-07-23T01:00:00.000Z"),
    });
    const refreshRequest = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(refreshRequest).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({ "Content-Type": "application/x-www-form-urlencoded" }),
    });
    expect(new URLSearchParams(String(refreshRequest.body)).get("grant_type")).toBe(
      "refresh_token",
    );
    expect(new URLSearchParams(String(refreshRequest.body)).get("refresh_token")).toBe("refresh-1");
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer refreshed-access" }),
      }),
    );
  });

  it("does not use a rotated refresh token when persistence detects changed auth", async () => {
    const expiredAuth = {
      xai: {
        type: "oauth",
        access: "expired-token",
        refresh: "refresh-1",
        expires: Date.now() - 1_000,
      },
    };
    mocks.readAuthFile.mockResolvedValue(expiredAuth);
    mocks.isCurrentXaiOAuth.mockResolvedValueOnce(true);
    mocks.updateCurrentXaiOAuth.mockResolvedValueOnce(false);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              access_token: "refreshed-access",
              refresh_token: "refreshed-refresh",
            }),
            { status: 200 },
          ),
      ) as any,
    );

    await expect(queryXaiQuota()).resolves.toEqual({
      success: false,
      error: "xAI OAuth changed during refresh; retry or reconnect xAI",
    });
  });

  it("uses an xAI credential refreshed by another plugin context", async () => {
    const expiredAuth = {
      xai: {
        type: "oauth",
        access: "expired-token",
        refresh: "refresh-1",
        expires: Date.now() - 1_000,
      },
    };
    mocks.readAuthFile
      .mockResolvedValueOnce(expiredAuth)
      .mockResolvedValueOnce(expiredAuth)
      .mockResolvedValueOnce({
        xai: {
          type: "oauth",
          access: "other-context-access",
          refresh: "other-context-refresh",
          expires: Date.now() + 10 * 60_000,
        },
      });
    mocks.isCurrentXaiOAuth.mockResolvedValueOnce(false);
    const fetchMock = vi.fn(async () => quotaResponse()) as any;
    vi.stubGlobal("fetch", fetchMock);

    await expect(queryXaiQuota()).resolves.toMatchObject({ success: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer other-context-access" }),
      }),
    );
    expect(mocks.updateCurrentXaiOAuth).not.toHaveBeenCalled();
  });

  it("does not consume a refresh token when OPENCODE_AUTH_CONTENT owns credentials", async () => {
    mocks.readAuthFile.mockResolvedValueOnce({
      xai: {
        type: "oauth",
        access: "expired-token",
        refresh: "refresh-1",
        expires: Date.now() - 1_000,
      },
    });
    mocks.hasOpenCodeAuthContentOverride.mockReturnValue(true);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(queryXaiQuota()).resolves.toEqual({
      success: false,
      error: "xAI OAuth token expired; update OPENCODE_AUTH_CONTENT or reconnect xAI",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shares one OAuth refresh between concurrent quota requests", async () => {
    const expiredAuth = {
      xai: {
        type: "oauth",
        access: "expired-token",
        refresh: "refresh-1",
        expires: Date.now() - 1_000,
      },
    };
    mocks.readAuthFile.mockResolvedValue(expiredAuth);
    mocks.isCurrentXaiOAuth.mockResolvedValueOnce(true);
    mocks.updateCurrentXaiOAuth.mockResolvedValueOnce(true);
    let resolveRefresh: ((response: Response) => void) | undefined;
    const refreshResponse = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    const fetchMock = vi.fn(async (url: string) =>
      url === "https://auth.x.ai/oauth2/token" ? refreshResponse : quotaResponse(),
    ) as any;
    vi.stubGlobal("fetch", fetchMock);

    const first = queryXaiQuota();
    const second = queryXaiQuota();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    resolveRefresh?.(
      new Response(
        JSON.stringify({ access_token: "refreshed-access", refresh_token: "refreshed-refresh" }),
        { status: 200 },
      ),
    );

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ success: true }),
      expect.objectContaining({ success: true }),
    ]);
    expect(mocks.isCurrentXaiOAuth).toHaveBeenCalledOnce();
    expect(mocks.updateCurrentXaiOAuth).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("reads the current auth file instead of a stale cached token", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      xai: { type: "oauth", access: "stale-token", expires: Date.now() - 1_000 },
    });
    configureAuth({ access: "fresh-token" });
    const fetchMock = vi.fn(async () => quotaResponse()) as any;
    vi.stubGlobal("fetch", fetchMock);

    await expect(queryXaiQuota()).resolves.toMatchObject({
      success: true,
      window: { percentRemaining: 95, kind: "weekly" },
    });
    expect(mocks.readAuthFileCached).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer fresh-token" }),
      }),
    );
  });

  it("maps the exact PR fixture through one fixed authenticated GET", async () => {
    configureAuth();
    const fetchMock = vi.fn(async () => quotaResponse()) as any;
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

  it("uses a fresh access-only credential without forcing a refresh", async () => {
    mocks.readAuthFile.mockResolvedValueOnce({
      xai: { type: "oauth", access: "access-only-token" },
    });
    const fetchMock = vi.fn(async () => quotaResponse()) as any;
    vi.stubGlobal("fetch", fetchMock);

    await expect(queryXaiQuota()).resolves.toMatchObject({ success: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer access-only-token" }),
      }),
    );
    expect(mocks.isCurrentXaiOAuth).not.toHaveBeenCalled();
  });

  it("treats an omitted protobuf percentage as 0% used when a period exists", async () => {
    configureAuth();
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
    configureAuth();
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
    configureAuth();
    configureAuth();
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
    configureAuth();
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
    configureAuth();
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
    configureAuth();
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
    configureAuth();
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
