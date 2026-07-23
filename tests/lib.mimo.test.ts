import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchWithTimeout: vi.fn(),
}));

vi.mock("../src/lib/http.js", () => ({
  fetchWithTimeout: mocks.fetchWithTimeout,
}));

import {
  parseMimoBalanceResponse,
  parseMimoDetailResponse,
  parseMimoUsageResponse,
  queryMimoDashboard,
} from "../src/lib/mimo.js";

const cookie = "api-platform_serviceToken=service-secret; userId=user-secret";

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json", ...init.headers },
    ...init,
  });
}

function usagePayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    code: 0,
    message: "",
    data: {
      monthUsage: {
        percent: 0.0505,
        items: [
          { name: "plan_total_token", used: 1, limit: 2 },
          {
            name: "month_total_token",
            used: 10_100_158,
            limit: 200_000_000,
            percent: 0.0505,
            ...overrides,
          },
        ],
      },
    },
  };
}

function detailPayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    code: 0,
    message: "",
    data: {
      planName: "Standard",
      planCode: "standard_monthly",
      currentPeriodEnd: "2026-05-04 23:59:59",
      expired: false,
      ...overrides,
    },
  };
}

function balancePayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    code: 0,
    message: "",
    data: {
      balance: "50.00",
      cashBalance: "30.00",
      giftBalance: "20.00",
      currency: "USD",
      ...overrides,
    },
  };
}

describe("MiMo response parsers", () => {
  it("selects only the named month_total_token item", () => {
    expect(parseMimoUsageResponse(usagePayload())).toEqual({
      used: 10_100_158,
      limit: 200_000_000,
    });
  });

  it("preserves zero usage and accepts over-limit provider values", () => {
    expect(parseMimoUsageResponse(usagePayload({ used: 0, limit: 100 }))).toEqual({
      used: 0,
      limit: 100,
    });
    expect(parseMimoUsageResponse(usagePayload({ used: 120, limit: 100 }))).toEqual({
      used: 120,
      limit: 100,
    });
  });

  it.each([
    ["missing named item", { code: 0, data: { monthUsage: { items: [] } } }],
    ["negative usage", usagePayload({ used: -1 })],
    ["zero limit", usagePayload({ limit: 0 })],
    ["string usage", usagePayload({ used: "10" })],
    ["non-finite usage", usagePayload({ used: Number.POSITIVE_INFINITY })],
  ])("rejects %s", (_label, payload) => {
    expect(() => parseMimoUsageResponse(payload)).toThrow();
  });

  it("uses plan labels and explicit expiry while ignoring currentPeriodEnd", () => {
    expect(
      parseMimoDetailResponse(
        detailPayload({
          currentPeriodEnd: "1999-01-01 00:00:00",
          expired: true,
        }),
      ),
    ).toEqual({
      planName: "Standard",
      planCode: "standard_monthly",
      expired: true,
    });
  });

  it.each([
    ["null data", { code: 0, data: null }],
    ["missing expired", { code: 0, data: { planCode: "standard" } }],
    ["wrong expired type", detailPayload({ expired: "false" })],
  ])("rejects detail with %s", (_label, payload) => {
    expect(() => parseMimoDetailResponse(payload)).toThrow();
  });

  it("parses optional total, cash, and gift balances with provider currency", () => {
    expect(parseMimoBalanceResponse(balancePayload())).toEqual({
      total: 50,
      cash: 30,
      gift: 20,
      currency: "USD",
    });
    expect(
      parseMimoBalanceResponse({
        code: 0,
        data: { balance: 0, giftBalance: "2.50", currency: "eur" },
      }),
    ).toEqual({
      total: 0,
      cash: null,
      gift: 2.5,
      currency: "EUR",
    });
    expect(parseMimoBalanceResponse({ code: 0, data: {} })).toEqual({
      total: null,
      cash: null,
      gift: null,
      currency: null,
    });
  });

  it.each([
    ["negative", balancePayload({ balance: "-1" })],
    ["non-numeric", balancePayload({ cashBalance: "private" })],
    ["non-finite", balancePayload({ giftBalance: Number.NaN })],
  ])("rejects a present %s balance", (_label, payload) => {
    expect(() => parseMimoBalanceResponse(payload)).toThrow();
  });
});

describe("queryMimoDashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the three fixed HTTPS GET contracts with manual redirects and fixed browser headers", async () => {
    mocks.fetchWithTimeout.mockImplementation((url: string) => {
      if (url.endsWith("/tokenPlan/usage")) return Promise.resolve(jsonResponse(usagePayload()));
      if (url.endsWith("/tokenPlan/detail")) return Promise.resolve(jsonResponse(detailPayload()));
      return Promise.resolve(jsonResponse(balancePayload()));
    });

    const result = await queryMimoDashboard(cookie, { requestTimeoutMs: 4_321 });

    expect(result.usage.state).toBe("success");
    expect(result.detail.state).toBe("success");
    expect(result.balance.state).toBe("success");
    expect(mocks.fetchWithTimeout.mock.calls.map((call) => call[0])).toEqual([
      "https://platform.xiaomimimo.com/api/v1/tokenPlan/usage",
      "https://platform.xiaomimimo.com/api/v1/tokenPlan/detail",
      "https://platform.xiaomimimo.com/api/v1/balance",
    ]);

    for (const [url, init, timeout] of mocks.fetchWithTimeout.mock.calls) {
      expect(url).toMatch(/^https:\/\/platform\.xiaomimimo\.com\/api\/v1\//u);
      expect(init).toEqual({
        method: "GET",
        redirect: "manual",
        headers: {
          Accept: "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9",
          Cookie: cookie,
          Origin: "https://platform.xiaomimimo.com",
          Referer: "https://platform.xiaomimimo.com/#/console/balance",
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
          "x-timeZone": "UTC+01:00",
        },
      });
      expect(init.body).toBeUndefined();
      expect(timeout).toBe(4_321);
    }
  });

  it("keeps successful endpoint data when another endpoint fails", async () => {
    mocks.fetchWithTimeout.mockImplementation((url: string) => {
      if (url.endsWith("/tokenPlan/usage")) {
        return Promise.resolve(new Response("private response body", { status: 503 }));
      }
      if (url.endsWith("/tokenPlan/detail")) return Promise.resolve(jsonResponse(detailPayload()));
      return Promise.resolve(jsonResponse(balancePayload()));
    });

    const result = await queryMimoDashboard(cookie);

    expect(result).toEqual({
      usage: {
        state: "error",
        error: "Xiaomi MiMo usage request failed (HTTP 503)",
      },
      detail: {
        state: "success",
        data: {
          planName: "Standard",
          planCode: "standard_monthly",
          expired: false,
        },
      },
      balance: {
        state: "success",
        data: {
          total: 50,
          cash: 30,
          gift: 20,
          currency: "USD",
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("private response body");
  });

  it("does not follow redirects", async () => {
    mocks.fetchWithTimeout.mockImplementation((url: string) => {
      if (url.endsWith("/tokenPlan/usage")) {
        return Promise.resolve(
          new Response("", {
            status: 302,
            headers: { Location: "https://example.test/private-login" },
          }),
        );
      }
      if (url.endsWith("/tokenPlan/detail")) return Promise.resolve(jsonResponse(detailPayload()));
      return Promise.resolve(jsonResponse(balancePayload()));
    });

    const result = await queryMimoDashboard(cookie);

    expect(result.usage).toEqual({
      state: "error",
      error: "Xiaomi MiMo usage request requires login",
    });
    expect(JSON.stringify(result)).not.toContain("example.test");
  });

  it("uses fixed parse errors for malformed, unexpected, and oversized responses", async () => {
    mocks.fetchWithTimeout.mockImplementation((url: string) => {
      if (url.endsWith("/tokenPlan/usage")) {
        return Promise.resolve(new Response("{"));
      }
      if (url.endsWith("/tokenPlan/detail")) {
        return Promise.resolve(jsonResponse({ code: 0, data: { expired: "no" } }));
      }
      return Promise.resolve(
        new Response("{}", {
          headers: { "Content-Length": String(300 * 1024) },
        }),
      );
    });

    await expect(queryMimoDashboard(cookie)).resolves.toEqual({
      usage: {
        state: "error",
        error: "Xiaomi MiMo usage response could not be parsed",
      },
      detail: {
        state: "error",
        error: "Xiaomi MiMo detail response did not match the expected schema",
      },
      balance: {
        state: "error",
        error: "Xiaomi MiMo balance response could not be parsed",
      },
    });
  });

  it("sanitizes network errors and redacts the cookie and retained values", async () => {
    mocks.fetchWithTimeout.mockImplementation((url: string) => {
      if (url.endsWith("/tokenPlan/usage")) {
        return Promise.reject(
          new Error(`\u001b[31mtimeout for ${cookie}\nservice-secret user-secret retry\u001b[0m`),
        );
      }
      if (url.endsWith("/tokenPlan/detail")) return Promise.resolve(jsonResponse(detailPayload()));
      return Promise.resolve(jsonResponse(balancePayload()));
    });

    const result = await queryMimoDashboard(cookie);
    const serialized = JSON.stringify(result);

    expect(result.usage).toEqual({
      state: "error",
      error: "Xiaomi MiMo usage request failed: timeout for [redacted] [redacted] [redacted] retry",
    });
    expect(serialized).not.toContain("service-secret");
    expect(serialized).not.toContain("user-secret");
    expect(serialized).not.toContain("\u001b");
    expect(serialized).not.toContain("\n");
  });
});
