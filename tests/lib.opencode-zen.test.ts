import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const fetchResponse = vi.fn();
  return {
    fetchResponse,
    fetchWithTimeout: vi.fn(
      async (
        url: string,
        options: {
          consume: (response: Response, signal: AbortSignal) => Promise<unknown> | unknown;
        },
      ) => {
        const response = await fetchResponse(url);
        return await options.consume(response, new AbortController().signal);
      },
    ),
  };
});

vi.mock("../src/lib/http.js", () => ({
  fetchWithTimeout: mocks.fetchWithTimeout,
}));

import { queryOpenCodeZenQuota } from "../src/lib/opencode-zen.js";

const CONSOLE_API = "https://opencode.ai/console/api";
const SESSION_ERROR =
  "OpenCode Console session expired or invalid — run `opencode console login` to sign in again";

const account = {
  email: "dev@example.com",
  baseUrl: "https://opencode.ai/console",
  accessToken: "st_secret-token",
  activeOrgId: "wrk_abc",
};

// Payloads captured from a real account by the maintainer (org id replaced).
const STATUS = {
  billingMode: "prepaid",
  mode: "pay-as-you-go",
  balanceMicroCents: "0",
  creditLimitMicroCents: null,
  availableMicroCents: "0",
  canPurchaseCredits: true,
  canEnableAutoRecharge: true,
  canEnrollInPrepaid: false,
};
const ACCOUNT = {
  orgId: "wrk_ABC",
  creditLimitMicroCents: null,
  createdAt: "2026-05-15T16:03:51.000Z",
  updatedAt: "2026-06-15T16:07:20.000Z",
};
const AUTO_RECHARGE = {
  enabled: false,
  thresholdDollars: 5,
  rechargeAmountDollars: 20,
  pending: false,
  failureReason: null,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function routes(overrides: Record<string, () => Response> = {}): void {
  const payloads: Record<string, () => Response> = {
    "billing/status": () => json(STATUS),
    "billing/account": () => json(ACCOUNT),
    "billing/auto-recharge": () => json(AUTO_RECHARGE),
    "usage/cost-by-day": () => json([]),
    ...overrides,
  };
  mocks.fetchResponse.mockImplementation(async (url: string) => {
    const route = url.slice(`${CONSOLE_API}/`.length);
    const payload = payloads[route];
    if (!payload) throw new Error(`unexpected url ${url}`);
    return payload();
  });
}

describe("queryOpenCodeZenQuota", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchResponse.mockReset();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-25T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls the four Console routes with the Bearer token and org id", async () => {
    routes();

    await queryOpenCodeZenQuota(account, { requestTimeoutMs: 4_000 });

    expect(mocks.fetchWithTimeout.mock.calls.map(([url]) => url).sort()).toEqual([
      `${CONSOLE_API}/billing/account`,
      `${CONSOLE_API}/billing/auto-recharge`,
      `${CONSOLE_API}/billing/status`,
      `${CONSOLE_API}/usage/cost-by-day`,
    ]);
    for (const [, options] of mocks.fetchWithTimeout.mock.calls) {
      expect(options).toMatchObject({
        request: {
          method: "GET",
          redirect: "manual",
          headers: {
            Accept: "application/json",
            Authorization: "Bearer st_secret-token",
            "x-org-id": "wrk_abc",
          },
        },
        timeoutMs: 4_000,
      });
    }
    for (const [, options] of mocks.fetchWithTimeout.mock.calls) {
      expect(options.request.headers).not.toHaveProperty("Cookie");
    }
  });

  it("parses the real empty-account payloads", async () => {
    routes();

    await expect(queryOpenCodeZenQuota(account)).resolves.toEqual({
      success: true,
      data: {
        balance: 0,
        monthlyLimit: null,
        monthlyUsage: 0,
        lastPayment: null,
        reload: false,
        reloadAmount: 20,
        reloadTrigger: 5,
      },
      errors: [],
    });
  });

  it("keeps micro-cents as billing units and sums only the current month's costs", async () => {
    routes({
      "billing/status": () => json({ ...STATUS, balanceMicroCents: "4250000000" }),
      "billing/account": () => json({ ...ACCOUNT, creditLimitMicroCents: "10000000000" }),
      "billing/auto-recharge": () => json({ ...AUTO_RECHARGE, enabled: true }),
      "usage/cost-by-day": () =>
        json([
          { date: "2026-08-31", totalCostMicroCents: "900000000" },
          { date: "2026-09-01", totalCostMicroCents: "500000000" },
          { date: "2026-09-24", totalCostMicroCents: "75000000" },
        ]),
    });

    await expect(queryOpenCodeZenQuota(account)).resolves.toEqual({
      success: true,
      data: {
        balance: 4_250_000_000,
        monthlyLimit: 100,
        monthlyUsage: 575_000_000,
        lastPayment: null,
        reload: true,
        reloadAmount: 20,
        reloadTrigger: 5,
      },
      errors: [],
    });
  });

  it.each([
    [
      "billing/account",
      { monthlyLimit: null, monthlyUsage: 75_000_000, reload: true, reloadAmount: 20 },
    ],
    [
      "billing/auto-recharge",
      { monthlyLimit: 100, monthlyUsage: 75_000_000, reload: null, reloadAmount: null },
    ],
    [
      "usage/cost-by-day",
      { monthlyLimit: 100, monthlyUsage: null, reload: true, reloadAmount: 20 },
    ],
  ])("keeps the balance when optional %s fails", async (route, expected) => {
    routes({
      "billing/status": () => json({ ...STATUS, balanceMicroCents: "4250000000" }),
      "billing/account": () => json({ ...ACCOUNT, creditLimitMicroCents: "10000000000" }),
      "billing/auto-recharge": () => json({ ...AUTO_RECHARGE, enabled: true }),
      "usage/cost-by-day": () => json([{ date: "2026-09-24", totalCostMicroCents: "75000000" }]),
      [route]: () => new Response("server error", { status: 500 }),
    });

    const result = await queryOpenCodeZenQuota(account);

    expect(result).toEqual({
      success: true,
      data: {
        balance: 4_250_000_000,
        lastPayment: null,
        reloadTrigger: expected.reload === null ? null : 5,
        ...expected,
      },
      errors: [`OpenCode Console ${route} error 500`],
    });
  });

  it("lists every failed optional route while keeping the balance", async () => {
    const failed = () => new Response("server error", { status: 500 });
    routes({
      "billing/account": failed,
      "billing/auto-recharge": failed,
      "usage/cost-by-day": failed,
    });

    await expect(queryOpenCodeZenQuota(account)).resolves.toEqual({
      success: true,
      data: {
        balance: 0,
        monthlyLimit: null,
        monthlyUsage: null,
        lastPayment: null,
        reload: null,
        reloadAmount: null,
        reloadTrigger: null,
      },
      errors: [
        "OpenCode Console billing/account error 500",
        "OpenCode Console billing/auto-recharge error 500",
        "OpenCode Console usage/cost-by-day error 500",
      ],
    });
  });

  it("clamps a negative balance to zero", async () => {
    routes({ "billing/status": () => json({ ...STATUS, balanceMicroCents: "-14496" }) });

    const result = await queryOpenCodeZenQuota(account);

    expect(result).toMatchObject({ success: true, data: { balance: 0 } });
  });

  it.each([
    [
      "302 redirect",
      () => new Response(null, { status: 302, headers: { location: "/console/login" } }),
    ],
    ["401", () => new Response("unauthorized", { status: 401 })],
    ["403", () => new Response("forbidden", { status: 403 })],
    [
      "login page",
      () =>
        new Response("<html>Sign in</html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    ],
  ])("reports an expired or invalid session for a %s", async (_name, sessionResponse) => {
    routes({
      "billing/status": sessionResponse,
      "billing/account": sessionResponse,
      "billing/auto-recharge": sessionResponse,
      "usage/cost-by-day": sessionResponse,
    });

    const result = await queryOpenCodeZenQuota(account);

    expect(result).toEqual({ success: false, error: SESSION_ERROR });
    expect(JSON.stringify(result)).not.toContain("st_secret-token");
  });

  it.each([
    "billing/account",
    "billing/auto-recharge",
    "usage/cost-by-day",
  ])("reports an expired session when only %s is rejected", async (route) => {
    routes({ [route]: () => new Response("unauthorized", { status: 401 }) });

    await expect(queryOpenCodeZenQuota(account)).resolves.toEqual({
      success: false,
      error: SESSION_ERROR,
    });
  });

  it("does not expose an HTTP response body", async () => {
    const secretBody = "private-body-session-secret";
    routes({ "billing/status": () => new Response(secretBody, { status: 500 }) });

    const result = await queryOpenCodeZenQuota(account);

    expect(result).toEqual({
      success: false,
      error: "OpenCode Console billing/status error 500",
    });
    expect(JSON.stringify(result)).not.toContain(secretBody);
    expect(JSON.stringify(result)).not.toContain("st_secret-token");
  });

  it.each([
    ["missing balance", () => json({ ...STATUS, balanceMicroCents: undefined })],
    ["non-JSON", () => new Response("not json", { status: 200 })],
    ["overflowing balance", () => json({ ...STATUS, balanceMicroCents: "9".repeat(309) })],
  ])("returns a stable parse error for a %s billing/status response", async (_name, payload) => {
    routes({ "billing/status": payload });

    await expect(queryOpenCodeZenQuota(account)).resolves.toEqual({
      success: false,
      error: "Could not parse OpenCode Console billing/status response",
    });
  });

  it.each([
    ["billing/account", () => json({ orgId: "wrk_ABC" })],
    ["billing/account", () => json({ ...ACCOUNT, creditLimitMicroCents: "9".repeat(309) })],
    ["billing/auto-recharge", () => json({ ...AUTO_RECHARGE, enabled: "no" })],
    ["usage/cost-by-day", () => json({ days: [] })],
    ["usage/cost-by-day", () => json([{ date: "2026-09-01", totalCostMicroCents: "abc" }])],
    [
      "usage/cost-by-day",
      () => json([{ date: "2026-09-01", totalCostMicroCents: "9".repeat(309) }]),
    ],
    [
      "usage/cost-by-day",
      () =>
        json([
          { date: "2026-09-01", totalCostMicroCents: "9".repeat(308) },
          { date: "2026-09-02", totalCostMicroCents: "9".repeat(308) },
        ]),
    ],
  ])("lists a stable parse error for a malformed %s response", async (route, payload) => {
    routes({ [route]: payload });

    const result = await queryOpenCodeZenQuota(account);

    expect(result).toMatchObject({
      success: true,
      data: { balance: 0 },
      errors: [`Could not parse OpenCode Console ${route} response`],
    });
  });

  it("sanitizes network and timeout errors and redacts the Bearer token and org id", async () => {
    mocks.fetchResponse.mockRejectedValue(
      new Error("\u001b[31mtimeout for wrk_abc with st_secret-token\nretry\u001b[0m"),
    );

    const result = await queryOpenCodeZenQuota(account);

    expect(result).toEqual({
      success: false,
      error:
        "OpenCode Console billing/status request failed: timeout for [redacted] with [redacted] retry",
    });
    expect(JSON.stringify(result)).not.toContain("wrk_abc");
    expect(JSON.stringify(result)).not.toContain("st_secret-token");
  });
});
