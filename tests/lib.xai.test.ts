import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  formatXaiMonthlyValue,
  hasXaiOAuth,
  periodKindLabel,
  queryXaiQuota,
  resolveXaiOAuth,
} from "../src/lib/xai.js";

vi.mock("../src/lib/opencode-auth.js", () => ({
  readAuthFileCached: vi.fn(),
  getAuthPaths: vi.fn(() => []),
  clearReadAuthFileCacheForTests: vi.fn(),
}));

vi.mock("../src/lib/atomic-json.js", () => ({
  writeJsonAtomic: vi.fn(),
}));

describe("xai auth resolution", () => {
  it("resolves oauth access tokens from auth.json", () => {
    expect(
      resolveXaiOAuth({
        xai: { type: "oauth", access: "token-1", refresh: "refresh-1", expires: 123 },
      }),
    ).toEqual({
      state: "configured",
      sourceKey: "xai",
      accessToken: "token-1",
      refreshToken: "refresh-1",
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

  it("returns null when not configured", async () => {
    const { readAuthFileCached } = await import("../src/lib/opencode-auth.js");
    (readAuthFileCached as any).mockResolvedValueOnce({});
    await expect(queryXaiQuota()).resolves.toBeNull();
  });

  it("refreshes an expired access token before querying", async () => {
    const { readAuthFileCached } = await import("../src/lib/opencode-auth.js");
    (readAuthFileCached as any).mockResolvedValueOnce({
      xai: {
        type: "oauth",
        access: "old-token",
        refresh: "refresh-1",
        expires: Date.now() - 1_000,
      },
    });

    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/oauth2/token")) {
        return new Response(
          JSON.stringify({
            access_token: "new-token",
            refresh_token: "refresh-2",
            expires_in: 3600,
          }),
          { status: 200 },
        );
      }
      if (String(url).includes("format=credits")) {
        return new Response(
          JSON.stringify({
            config: {
              currentPeriod: {
                type: "USAGE_PERIOD_TYPE_WEEKLY",
                end: "2026-07-20T02:24:00.983423+00:00",
              },
              creditUsagePercent: 1,
              productUsage: [],
            },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ config: {} }), { status: 200 });
    }) as any;
    vi.stubGlobal("fetch", fetchMock);

    const out = await queryXaiQuota();
    expect(out && out.success ? out.windows.primary?.percentRemaining : null).toBe(99);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://auth.x.ai/oauth2/token",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer new-token",
        }),
      }),
    );
  });

  it("returns token expired when expired and refresh is missing", async () => {
    const { readAuthFileCached } = await import("../src/lib/opencode-auth.js");
    (readAuthFileCached as any).mockResolvedValueOnce({
      xai: { type: "oauth", access: "token-1", expires: Date.now() - 1_000 },
    });

    await expect(queryXaiQuota()).resolves.toEqual({
      success: false,
      error: "Token expired",
    });
  });

  it("maps weekly credits, zero-omitted product rows, monthly allowance, and subscription label", async () => {
    const { readAuthFileCached } = await import("../src/lib/opencode-auth.js");
    (readAuthFileCached as any).mockResolvedValueOnce({
      xai: { type: "oauth", access: "token-1", expires: Date.now() + 60_000 },
    });

    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("format=credits")) {
        return new Response(
          JSON.stringify({
            config: {
              currentPeriod: {
                type: "USAGE_PERIOD_TYPE_WEEKLY",
                start: "2026-07-13T02:24:00.983423+00:00",
                end: "2026-07-20T02:24:00.983423+00:00",
              },
              creditUsagePercent: 1,
              isUnifiedBillingUser: true,
              productUsage: [{ product: "Api", usagePercent: 1 }, { product: "GrokChat" }],
            },
          }),
          { status: 200 },
        );
      }
      if (String(url).includes("/v1/billing")) {
        return new Response(
          JSON.stringify({
            config: {
              monthlyLimit: { val: 150000 },
              used: { val: 426 },
              billingPeriodEnd: "2026-08-01T00:00:00+00:00",
            },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          subscriptions: [
            {
              tier: "SUBSCRIPTION_TIER_SUPER_GROK_PRO",
              status: "SUBSCRIPTION_STATUS_ACTIVE",
              google: { productId: "grok.ultra" },
            },
          ],
        }),
        { status: 200 },
      );
    }) as any;
    vi.stubGlobal("fetch", fetchMock);

    const out = await queryXaiQuota({ requestTimeoutMs: 3210 });

    expect(out).toEqual({
      success: true,
      label: "xAI SuperGrok",
      unifiedBilling: true,
      windows: {
        primary: {
          percentRemaining: 99,
          resetTimeIso: "2026-07-20T02:24:00.983Z",
          kind: "weekly",
        },
        products: [
          {
            product: "Api",
            window: {
              percentRemaining: 99,
              resetTimeIso: "2026-07-20T02:24:00.983Z",
              kind: "weekly",
            },
          },
          {
            product: "GrokChat",
            window: {
              percentRemaining: 100,
              resetTimeIso: "2026-07-20T02:24:00.983Z",
              kind: "weekly",
            },
          },
        ],
      },
      monthly: {
        limitUsd: 1500,
        usedUsd: 4.26,
        remainingUsd: 1495.74,
        percentRemaining: 100,
        resetTimeIso: "2026-08-01T00:00:00.000Z",
      },
    });
  });

  it("treats omitted creditUsagePercent as 0% used when period exists", async () => {
    const { readAuthFileCached } = await import("../src/lib/opencode-auth.js");
    (readAuthFileCached as any).mockResolvedValueOnce({
      xai: { type: "oauth", access: "token-1", expires: Date.now() + 60_000 },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("format=credits")) {
          return new Response(
            JSON.stringify({
              config: {
                currentPeriod: {
                  type: "USAGE_PERIOD_TYPE_WEEKLY",
                  end: "2026-07-20T02:24:00.983423+00:00",
                },
                productUsage: [{ product: "Api" }],
              },
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({}), { status: 200 });
      }) as any,
    );

    const out = await queryXaiQuota();
    expect(out && out.success ? out.windows.primary : null).toEqual({
      percentRemaining: 100,
      resetTimeIso: "2026-07-20T02:24:00.983Z",
      kind: "weekly",
    });
    expect(out && out.success ? out.unifiedBilling : null).toBe(false);
    expect(out && out.success ? out.windows.products : null).toEqual([
      {
        product: "Api",
        window: {
          percentRemaining: 100,
          resetTimeIso: "2026-07-20T02:24:00.983Z",
          kind: "weekly",
        },
      },
    ]);
  });

  it("keeps primary credits when optional endpoints fail", async () => {
    const { readAuthFileCached } = await import("../src/lib/opencode-auth.js");
    (readAuthFileCached as any).mockResolvedValueOnce({
      xai: { type: "oauth", access: "token-1", expires: Date.now() + 60_000 },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("format=credits")) {
          return new Response(
            JSON.stringify({
              config: {
                currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-07-20T00:00:00Z" },
                creditUsagePercent: 10,
              },
            }),
            { status: 200 },
          );
        }
        throw new Error("network down");
      }) as any,
    );

    const out = await queryXaiQuota();
    expect(out).toEqual({
      success: true,
      label: "xAI",
      unifiedBilling: false,
      windows: {
        primary: {
          percentRemaining: 90,
          resetTimeIso: "2026-07-20T00:00:00.000Z",
          kind: "weekly",
        },
        products: [],
      },
      monthly: undefined,
    });
  });

  it("returns API errors from the primary credits endpoint", async () => {
    const { readAuthFileCached } = await import("../src/lib/opencode-auth.js");
    (readAuthFileCached as any).mockResolvedValueOnce({
      xai: { type: "oauth", access: "token-1", expires: Date.now() + 60_000 },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("format=credits")) {
          return new Response("nope", { status: 401 });
        }
        return new Response("{}", { status: 200 });
      }) as any,
    );

    await expect(queryXaiQuota()).resolves.toEqual({
      success: false,
      error: "xAI API error 401: nope",
    });
  });
});

describe("format helpers", () => {
  it("formats remaining monthly allowance", () => {
    expect(
      formatXaiMonthlyValue({
        limitUsd: 1500,
        usedUsd: 4.26,
        remainingUsd: 1495.74,
        percentRemaining: 100,
      }),
    ).toBe("$1495.74 left ($4.26/$1500.00)");
  });

  it("labels period kinds", () => {
    expect(periodKindLabel("weekly")).toBe("Weekly");
    expect(periodKindLabel("monthly")).toBe("Monthly");
    expect(periodKindLabel("daily")).toBe("Daily");
    expect(periodKindLabel("period")).toBe("Period");
  });
});
