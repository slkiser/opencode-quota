import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { xiaomiProvider } from "../src/providers/mimo.js";
import {
  fakeHttp,
  fetchRows,
  requestHeader,
  rowSummary,
  useProviderWorld,
} from "./helpers/provider-fetch.js";

const MIMO_API = "https://platform.xiaomimimo.com/api/v1";
const COOKIE = "api-platform_serviceToken=service-secret; userId=user-secret";

const USAGE = {
  code: 0,
  data: {
    monthUsage: {
      items: [
        { name: "plan_total_token", used: 1, limit: 2 },
        { name: "month_total_token", used: 10_100_158, limit: 200_000_000 },
      ],
    },
  },
};
const DETAIL = {
  code: 0,
  data: { planName: "Standard", planCode: "standard_monthly", expired: false },
};
const BALANCE = {
  code: 0,
  data: { balance: "50.00", cashBalance: "30.00", giftBalance: "20.00", currency: "USD" },
};

type Endpoint = "usage" | "detail" | "balance";
const ENDPOINT_PATHS: Record<string, Endpoint> = {
  "/tokenPlan/usage": "usage",
  "/tokenPlan/detail": "detail",
  "/balance": "balance",
};

/**
 * Answers the three dashboard endpoints with the payloads above, or with `overrides[endpoint]`:
 * a JSON body, or a function that builds the Response.
 */
function mimoHttp(overrides: Partial<Record<Endpoint, unknown>> = {}) {
  const replies: Record<Endpoint, unknown> = {
    usage: USAGE,
    detail: DETAIL,
    balance: BALANCE,
    ...overrides,
  };
  return fakeHttp((url) => {
    const endpoint = ENDPOINT_PATHS[url.slice(MIMO_API.length)];
    if (!url.startsWith(MIMO_API) || !endpoint) throw new Error(`unexpected url ${url}`);
    const reply = replies[endpoint];
    return typeof reply === "function" ? reply() : reply;
  });
}

const loginRedirect = () =>
  new Response(null, { status: 302, headers: { location: "https://example.test/login" } });

const TOKENS = "94.949921 (10100158 token of 200000000 token)";
const MONTHLY_ROW = ["xiaomi.monthly_tokens", "Standard", "Monthly", "month", TOKENS, null];

function errorDebug(fetched: { debug: Array<{ key: string; value: string }> }): string[] {
  return fetched.debug.filter((item) => item.key === "error").map((item) => item.value);
}

/** The resolved cookie is cached for 30 s, so each test starts a minute after the last one. */
let clock = Date.parse("2026-05-01T00:00:00.000Z");

describe("Xiaomi MiMo provider", () => {
  const world = useProviderWorld();
  const configPath = () => join(world.configDir, "opencode-quota", "mimo.json");

  beforeEach(() => {
    clock += 60_000;
    vi.useFakeTimers({ now: clock, toFake: ["Date"] });
  });

  it("is not configured without a cookie", async () => {
    const http = mimoHttp();

    await expect(fetchRows(xiaomiProvider)).resolves.toEqual({
      rows: [],
      error: { code: "not_configured" },
      debug: [
        { key: "config_state", value: "none" },
        { key: "config_source", value: "(none)" },
        { key: "config_checked_paths", value: configPath() },
      ],
    });
    expect(http).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a cookie variable that lacks the service token, even with a valid file",
      "Cookie: userId=private-user",
      JSON.stringify({ cookie: COOKIE }),
      "Invalid cookie header",
    ],
    ["a cookie variable with a line break", `${COOKIE}\nx=1`, undefined, "Invalid cookie header"],
    ["a config file that is not JSON", undefined, "{", "Failed to parse JSON"],
    [
      "a config file with more than the cookie",
      undefined,
      JSON.stringify({ cookie: COOKIE, endpoint: "https://example.test" }),
      "Config file must contain only the cookie field",
    ],
  ])("reports %s as invalid config", async (_name, envCookie, file, problem) => {
    if (envCookie !== undefined) process.env.MIMO_USAGE_COOKIE = envCookie;
    if (file !== undefined) world.writeConfigFile("opencode-quota/mimo.json", file);
    const http = mimoHttp();

    const fetched = await fetchRows(xiaomiProvider);

    const source = envCookie === undefined ? configPath() : "env:MIMO_USAGE_COOKIE";
    expect(fetched.rows).toEqual([]);
    expect(fetched.error?.code).toBe("not_configured");
    expect(errorDebug(fetched)).toEqual([`Xiaomi MiMo: Invalid config (${source}): ${problem}`]);
    expect(fetched.debug).toContainEqual({ key: "config_state", value: "invalid" });
    expect(JSON.stringify(fetched)).not.toMatch(/private-user|secret/);
    expect(http).not.toHaveBeenCalled();
  });

  it("sends only the dashboard cookies from the variable to the three endpoints", async () => {
    process.env.MIMO_USAGE_COOKIE =
      " Cookie: other=drop; userId=user=part; api-platform_slh=slh; api-platform_serviceToken=service ";
    const http = mimoHttp();

    const fetched = await fetchRows(xiaomiProvider);

    expect(fetched.rows).toHaveLength(4);
    expect(http.mock.calls.map(([url]) => url)).toEqual([
      `${MIMO_API}/tokenPlan/usage`,
      `${MIMO_API}/tokenPlan/detail`,
      `${MIMO_API}/balance`,
    ]);
    for (const [, init] of http.mock.calls) {
      expect(requestHeader(init, "Cookie")).toBe(
        "api-platform_serviceToken=service; userId=user=part; api-platform_slh=slh",
      );
      expect(init?.redirect).toBe("manual");
    }
  });

  it("shows the monthly tokens and balances of the plan, with the cookie from the config file", async () => {
    world.writeConfigFile("opencode-quota/mimo.json", JSON.stringify({ cookie: COOKIE }));
    mimoHttp();

    const fetched = await fetchRows(xiaomiProvider);

    expect(rowSummary(fetched.rows)).toEqual([
      MONTHLY_ROW,
      ["xiaomi.total_balance", "Standard", "Balance", null, "50 USD", null],
      ["xiaomi.cash_balance", "Standard", "Cash", null, "30 USD", null],
      ["xiaomi.gift_balance", "Standard", "Gift", null, "20 USD", null],
    ]);
    expect(fetched.error).toBeUndefined();
    expect(fetched.debug).toContainEqual({ key: "config_source", value: configPath() });
  });

  it.each([
    [
      "an expired plan as balances only",
      { detail: { code: 0, data: { planName: "Old", planCode: "old", expired: true } } },
      [
        ["xiaomi.total_balance", null, "Balance", null, "50 USD", null],
        ["xiaomi.cash_balance", null, "Cash", null, "30 USD", null],
        ["xiaomi.gift_balance", null, "Gift", null, "20 USD", null],
      ],
    ],
    [
      "number and missing balances in a lower-case currency",
      { balance: { code: 0, data: { balance: 0, giftBalance: "2.50", currency: "eur" } } },
      [
        MONTHLY_ROW,
        ["xiaomi.total_balance", "Standard", "Balance", null, "0 EUR", null],
        ["xiaomi.gift_balance", "Standard", "Gift", null, "2.5 EUR", null],
      ],
    ],
    [
      "balances without a currency as credits",
      { balance: { code: 0, data: { balance: "12.50", currency: "US$" } } },
      [MONTHLY_ROW, ["xiaomi.total_balance", "Standard", "Balance", null, "12.5 credit", null]],
    ],
  ])("shows %s", async (_name, overrides, rows) => {
    process.env.MIMO_USAGE_COOKIE = COOKIE;
    mimoHttp(overrides);

    const fetched = await fetchRows(xiaomiProvider);

    expect(rowSummary(fetched.rows)).toEqual(rows);
    expect(fetched.error).toBeUndefined();
  });

  it.each([
    [
      "an expired cookie (every endpoint redirects to sign-in)",
      { usage: loginRedirect, detail: loginRedirect, balance: loginRedirect },
      [],
      "login_expired",
      [
        "Xiaomi MiMo usage request requires login",
        "Xiaomi MiMo detail request requires login",
        "Xiaomi MiMo balance request requires login",
      ],
    ],
    [
      "a failed plan request, keeping the tokens without a plan name",
      {
        detail: () => new Response("private body", { status: 503 }),
        balance: { code: 0, data: {} },
      },
      [["xiaomi.monthly_tokens", null, "Monthly", "month", TOKENS, null]],
      "provider_error",
      ["Xiaomi MiMo detail request failed (HTTP 503)"],
    ],
    [
      "a usage reply with a zero limit",
      {
        usage: {
          code: 0,
          data: { monthUsage: { items: [{ name: "month_total_token", used: 5, limit: 0 }] } },
        },
        balance: { code: 0, data: {} },
      },
      [],
      "bad_response",
      ["Xiaomi MiMo usage response did not match the expected schema"],
    ],
    [
      "a negative balance",
      { balance: { code: 0, data: { balance: "-1" } } },
      [MONTHLY_ROW],
      "bad_response",
      ["Xiaomi MiMo balance response did not match the expected schema"],
    ],
  ])("reports %s", async (_name, overrides, rows, code, messages) => {
    process.env.MIMO_USAGE_COOKIE = COOKIE;
    mimoHttp(overrides);

    const fetched = await fetchRows(xiaomiProvider);

    expect(rowSummary(fetched.rows)).toEqual(rows);
    expect(fetched.error?.code).toBe(code);
    expect(errorDebug(fetched)).toEqual(messages.map((message) => `Xiaomi MiMo: ${message}`));
    expect(JSON.stringify(fetched)).not.toMatch(/private|example\.test/);
  });

  it.each([
    ["a valid cookie", COOKIE, true],
    ["an invalid cookie", "userId=user-secret", false],
    ["no cookie", undefined, false],
  ])("is available with %s", async (_name, envCookie, expected) => {
    if (envCookie !== undefined) process.env.MIMO_USAGE_COOKIE = envCookie;

    await expect(xiaomiProvider.isAvailable({ config: {} } as never)).resolves.toBe(expected);
  });

  it.each([
    ["xiaomi/mimo-v2", true],
    ["xiaomi-token-plan-cn/mimo-v2", true],
    ["xiaomi-mimo/mimo-v2", false],
  ])("matches model %s: %s", (model, expected) => {
    expect(xiaomiProvider.matchesCurrentModel?.(model)).toBe(expected);
  });
});
