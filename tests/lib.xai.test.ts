import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hasXaiOAuth, periodKindLabel, queryXaiQuota, resolveXaiOAuth } from "../src/lib/xai.js";

vi.mock("../src/lib/opencode-auth.js", () => ({
  readAuthFileCached: vi.fn(),
}));

describe("xai auth resolution", () => {
  it("resolves a read-only oauth access token", () => {
    expect(
      resolveXaiOAuth({
        xai: { type: "oauth", access: "token-1", refresh: "refresh-1", expires: 123 },
      }),
    ).toEqual({
      state: "configured",
      accessToken: "token-1",
      expiresAt: 123,
    });
    expect(hasXaiOAuth({ xai: { type: "api", key: "xai-key" } as any })).toBe(false);
    expect(hasXaiOAuth({})).toBe(false);
  });
});

describe("queryXaiQuota", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null when oauth is not configured", async () => {
    const { readAuthFileCached } = await import("../src/lib/opencode-auth.js");
    (readAuthFileCached as any).mockResolvedValueOnce({});

    await expect(queryXaiQuota()).resolves.toBeNull();
  });

  it("does not refresh or write an expired token", async () => {
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
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps the shared weekly meter with one authenticated request", async () => {
    const { readAuthFileCached } = await import("../src/lib/opencode-auth.js");
    (readAuthFileCached as any).mockResolvedValueOnce({
      xai: { type: "oauth", access: "token-1", expires: Date.now() + 60_000 },
    });

    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            config: {
              currentPeriod: {
                type: "USAGE_PERIOD_TYPE_WEEKLY",
                start: "2026-07-13T02:24:00.983423+00:00",
                end: "2026-07-20T02:24:00.983423+00:00",
              },
              creditUsagePercent: 5,
              isUnifiedBillingUser: true,
              productUsage: [{ product: "Api", usagePercent: 5 }, { product: "GrokChat" }],
            },
          }),
          { status: 200 },
        ),
    ) as any;
    vi.stubGlobal("fetch", fetchMock);

    await expect(queryXaiQuota({ requestTimeoutMs: 3210 })).resolves.toEqual({
      success: true,
      label: "xAI SuperGrok",
      window: {
        percentRemaining: 95,
        resetTimeIso: "2026-07-20T02:24:00.983Z",
        kind: "weekly",
      },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer token-1",
          "x-grok-client-surface": "grok-build",
        }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("treats an omitted protobuf percentage as 0% used when a period exists", async () => {
    const { readAuthFileCached } = await import("../src/lib/opencode-auth.js");
    (readAuthFileCached as any).mockResolvedValueOnce({
      xai: { type: "oauth", access: "token-1", expires: Date.now() + 60_000 },
    });
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

    const out = await queryXaiQuota();
    expect(out && out.success ? out.window.percentRemaining : null).toBe(100);
  });

  it("rejects a present malformed percentage", async () => {
    const { readAuthFileCached } = await import("../src/lib/opencode-auth.js");
    (readAuthFileCached as any).mockResolvedValueOnce({
      xai: { type: "oauth", access: "token-1", expires: Date.now() + 60_000 },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              config: {
                currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" },
                creditUsagePercent: "100",
              },
            }),
            { status: 200 },
          ),
      ) as any,
    );

    await expect(queryXaiQuota()).resolves.toEqual({
      success: false,
      error: "xAI credits response returned an invalid usage percentage",
    });
  });

  it("reports missing period data instead of synthesizing 0% remaining", async () => {
    const { readAuthFileCached } = await import("../src/lib/opencode-auth.js");
    (readAuthFileCached as any).mockResolvedValueOnce({
      xai: { type: "oauth", access: "token-1", expires: Date.now() + 60_000 },
    });
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

  it("returns sanitized API errors", async () => {
    const { readAuthFileCached } = await import("../src/lib/opencode-auth.js");
    (readAuthFileCached as any).mockResolvedValueOnce({
      xai: { type: "oauth", access: "token-1", expires: Date.now() + 60_000 },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })) as any);

    await expect(queryXaiQuota()).resolves.toEqual({
      success: false,
      error: "xAI API error 401: nope",
    });
  });
});

describe("periodKindLabel", () => {
  it("labels supported period kinds", () => {
    expect(periodKindLabel("weekly")).toBe("Weekly");
    expect(periodKindLabel("monthly")).toBe("Monthly");
    expect(periodKindLabel("daily")).toBe("Daily");
    expect(periodKindLabel("period")).toBe("Period");
  });
});
