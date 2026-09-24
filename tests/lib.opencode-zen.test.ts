import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  route: vi.fn<(url: string) => Response>(),
  fetchWithTimeout: vi.fn(
    async (
      url: string,
      options: {
        request: { headers: Record<string, string> };
        consume: (response: Response, signal: AbortSignal) => Promise<unknown> | unknown;
      },
    ) => {
      const response = mocks.route(url);
      return await options.consume(response, new AbortController().signal);
    },
  ),
}));

vi.mock("../src/lib/http.js", () => ({
  fetchWithTimeout: mocks.fetchWithTimeout,
}));

import {
  OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR,
  queryOpenCodeZenQuota,
} from "../src/lib/opencode-zen.js";

function currentMonthPrefix(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

type Route = { status?: number; body?: unknown; text?: string };

function routes(
  responses: Record<string, Route>,
  recorded: Array<{ url: string; headers: Record<string, string> }> = [],
): void {
  mocks.route.mockImplementation((url) => {
    const path = new URL(url).pathname;
    const spec = responses[path];
    if (!spec) throw new Error(`unexpected console fetch: ${url}`);
    recorded.add({ url: path, headers: {} });
    void recorded;
    return new Response(spec.text ?? JSON.stringify(spec.body ?? null), {
      status: spec.status ?? 200,
    });
  });
  void recorded;
}

const recorded: Array<{ url: string; headers: Record<string, string> }> = [];

describe("OpenCode Zen console quota query", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recorded.length = 0;
  });

  it("queries the console billing and usage endpoints in contract order", async () => {
    const responses: Record<string, Route> = {
      "/console/api/billing/status": { body: { billingMode: "prepaid", balanceMicroCents: "1234" } },
      "/console/api/billing/account": { body: { creditLimitMicroCents: null } },
      "/console/api/billing/auto-recharge": {
        body: { enabled: true, thresholdDollars: 5, rechargeAmountDollars: 20 },
      },
      "/console/api/usage/cost-by-day": { body: [] },
    };
    let calls = 0;
    mocks.route.mockImplementation((url: string) => {
      const path = new URL(url).pathname;
      const spec = responses[path];
      if (!spec) throw new Error(`unexpected console fetch: ${url}`);
      calls++;
      return new Response(JSON.stringify(spec.body ?? null), { status: spec.status ?? 200 });
    });

    const out = await queryOpenCodeZenQuota({ accessToken: "console-access" });

    expect(out.success).toBe(true);
    expect(calls).toBe(4);
    expect(recorded.length).toBe(0);
  });

  it("sends the console bearer token with JSON accept headers", async () => {
    mocks.route.mockImplementation((url: string) => {
      void url;
      return new Response(JSON.stringify({ balanceMicroCents: "100" }), { status: 200 });
    });

    await queryOpenCodeZenQuota({ accessToken: "console-access" });

    const first = mocks.fetchWithTimeout.mock.calls[0]!;
    expect(first[0]).toBe("https://opencode.ai/console/api/billing/status");
    expect(first[1].request.headers.Authorization).toBe("Bearer console-access");
    expect(first[1].request.headers.Accept).toBe("application/json");
  });

  it("maps balance, credit limit, monthly usage, and auto-recharge", async () => {
    const prefix = currentMonthPrefix();
    mocks.route.mockImplementation((url: string) => {
      const path = new URL(url).pathname;
      if (path === "/console/api/billing/status") {
        return new Response(JSON.stringify({ balanceMicroCents: "1234000000" }), { status: 200 });
      }
      if (path === "/console/api/billing/account") {
        return new Response(JSON.stringify({ creditLimitMicroCents: "1000000000" }), { status: 200 });
      }
      if (path === "/console/api/billing/auto-recharge") {
        return new Response(
          JSON.stringify({ enabled: true, thresholdDollars: 5, rechargeAmountDollars: 20 }),
          { status: 200 },
        );
      }
      if (path === "/console/api/usage/cost-by-day") {
        return new Response(
          JSON.stringify([
            { date: `${prefix}-05`, totalCostMicroCents: "250000000" },
            { date: `${prefix}-06`, totalCostMicroCents: "250000000" },
            { date: "2020-01-01", totalCostMicroCents: "999000000" },
          ]),
          { status: 200 },
        );
      }
      throw new Error(`unexpected console fetch: ${url}`);
    });

    const out = await queryOpenCodeZenQuota({ accessToken: "console-access" });

    expect(out).toEqual({
      success: true,
      data: {
        balance: 12.34,
        monthlyLimit: 10,
        monthlyUsage: 5,
        lastPayment: null,
        reload: true,
        reloadAmount: 20,
        reloadTrigger: 5,
      },
    });
    expect(OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR).toBe(100_000_000);
  });

  it("keeps auto-reload fields unset when auto-recharge is disabled", async () => {
    mocks.route.mockImplementation((url: string) => {
      const path = new URL(url).pathname;
      if (path === "/console/api/billing/status") {
        return new Response(JSON.stringify({ balanceMicroCents: "100" }), { status: 200 });
      }
      if (path === "/console/api/billing/account") {
        return new Response(JSON.stringify({ creditLimitMicroCents: null }), { status: 200 });
      }
      if (path === "/console/api/billing/auto-recharge") {
        return new Response(JSON.stringify({ enabled: false }), { status: 200 });
      }
      if (path === "/console/api/usage/cost-by-day") {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      throw new Error(`unexpected console fetch: ${url}`);
    });

    const out = await queryOpenCodeZenQuota({ accessToken: "console-access" });

    expect(out).toMatchObject({ success: true, data: { reload: false, reloadAmount: null, reloadTrigger: null, monthlyLimit: null } });
  });

  it("reports console API errors per endpoint", async () => {
    mocks.route.mockImplementation((url: string) => {
      const path = new URL(url).pathname;
      if (path === "/console/api/billing/status") {
        return new Response(JSON.stringify({ _tag: "Unauthorized" }), { status: 401 });
      }
      throw new Error(`unexpected console fetch: ${url}`);
    });

    const out = await queryOpenCodeZenQuota({ accessToken: "console-access" });

    expect(out).toEqual({
      success: false,
      error: "OpenCode Console API error 401 (/api/billing/status)",
    });
  });

  it("returns a contract error for malformed console responses", async () => {
    mocks.route.mockImplementation((url: string) => {
      const path = new URL(url).pathname;
      if (path === "/console/api/billing/status") {
        return new Response("{not json", { status: 200 });
      }
      throw new Error(`unexpected console fetch: ${url}`);
    });

    const out = await queryOpenCodeZenQuota({ accessToken: "console-access" });

    expect(out).toEqual({
      success: false,
      error: "Could not parse OpenCode Console response (/api/billing/status)",
    });
  });

  it("surfaces timeout errors without leaking the token", async () => {
    mocks.fetchWithTimeout.mockImplementationOnce(async () => {
      throw new Error("Request timeout after 10s");
    });

    const out = await queryOpenCodeZenQuota({ accessToken: "secret-console-token" });

    expect(out).toEqual({ success: false, error: "Request timeout after 10s" });
    expect(JSON.stringify(out)).not.toContain("console-access");
    expect(JSON.stringify(out)).not.toContain("secret-console-token");
  });
});
