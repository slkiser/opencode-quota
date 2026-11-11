import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  bindCredentialSource,
  createIntegrationCredentialSource,
} from "../src/lib/opencode-auth.js";
import { opencodeZenProvider } from "../src/providers/opencode-zen.js";
import type { CredentialDatabaseRow } from "./helpers/credential-database.js";
import { createFakeIntegration } from "./helpers/fake-integration.js";
import {
  fakeHttp,
  fetchRows,
  requestHeader,
  rowSummary,
  useProviderWorld,
} from "./helpers/provider-fetch.js";

const CONSOLE_API = "https://opencode.ai/console/api";
const NOW = Date.parse("2026-09-25T12:00:00.000Z");
const LOGIN_HINT = "Run `opencode auth login opencode`.";
const SESSION_ERROR =
  "OpenCode Console session expired or invalid. Run `opencode auth login opencode` to sign in again.";
const EXPLICIT = { enabledProviders: ["opencode"] };

/** A stored Console sign-in (`opencode auth login opencode`); `value` fields replace the defaults. */
function consoleLogin(value: Record<string, unknown> = {}): CredentialDatabaseRow {
  return {
    id: "cred_console",
    integrationId: "opencode",
    active: 1,
    updated: 1,
    value: {
      type: "oauth",
      access: "st_secret-token",
      refresh: "console-refresh",
      expires: NOW + 3_600_000,
      metadata: { orgID: "wrk_abc", orgName: "Acme", accountID: "usr_me" },
      ...value,
    },
  };
}

const BUDGET_ROUTE = "policies/current-budgets";

/** A funded account without a monthly limit or member budget: $42.50 balance, auto reload off. */
const ROUTES: Record<string, unknown> = {
  "billing/status": { balanceMicroCents: "4250000000" },
  "billing/account": { creditLimitMicroCents: null },
  "billing/auto-recharge": { enabled: false, thresholdDollars: 5, rechargeAmountDollars: 20 },
  [BUDGET_ROUTE]: [],
  "usage/cost-by-day": [],
};

/** A $100 credit limit with $5.75 spent this month: the fallback when no member budget is used. */
const CREDIT_LIMIT = {
  "billing/account": { creditLimitMicroCents: "10000000000" },
  "usage/cost-by-day": [{ date: "2026-09-24", totalCostMicroCents: "575000000" }],
};

/** One budget the Console reports as current; `fields` replaces the parts that matter. */
function budget(fields: Record<string, unknown> = {}) {
  return {
    policyID: "pol_0",
    ruleID: "rule_0",
    limitDollars: 10,
    spentDollars: 0,
    scope: "combined",
    per: "set",
    coverage: "all",
    models: [],
    vendors: [],
    picked: false,
    shared: true,
    resetsAt: NEXT_MONTH,
    ...fields,
  };
}

/**
 * Answers each Console route with its `ROUTES` reply, or with `overrides[route]`: a JSON body,
 * or a function that builds the Response.
 */
function consoleHttp(overrides: Record<string, unknown> = {}, consoleApi = CONSOLE_API) {
  const replies = { ...ROUTES, ...overrides };
  return fakeHttp((url) => {
    const route = url.slice(`${consoleApi}/`.length);
    if (!url.startsWith(`${consoleApi}/`) || !(route in replies)) {
      throw new Error(`unexpected url ${url}`);
    }
    const reply = replies[route];
    return typeof reply === "function" ? reply() : reply;
  });
}

const serverError = () => new Response("server error", { status: 500 });
const NEXT_MONTH = "2026-10-01T00:00:00.000Z";
const NO_SPEND_ROW = ["opencode.monthly", null, "Monthly", "month", "0 USD", null];
const CREDIT_LIMIT_ROW = [
  "opencode.monthly",
  null,
  "Monthly",
  "month",
  "94.25 (5.75 USD of 100 USD)",
  null,
];
const BALANCE_ROW = ["opencode.balance", null, "Balance", null, "42.5 USD", null];
const RELOAD_OFF_ROW = ["opencode.auto_reload", null, "Auto reload", null, false, null];

function errorDebug(fetched: { debug: Array<{ key: string; value: string }> }): string[] {
  return fetched.debug.filter((item) => item.key === "error").map((item) => item.value);
}

describe("OpenCode Zen provider", () => {
  const world = useProviderWorld();

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  });

  it.each([
    ["no Console sign-in", []],
    [
      "only an API key under opencode",
      [{ ...consoleLogin(), value: { type: "api", key: "sk-workspace" } }],
    ],
  ])("is not configured with %s in auto mode", async (_name, logins) => {
    world.storeLogins(logins);
    const http = consoleHttp();

    await expect(fetchRows(opencodeZenProvider)).resolves.toEqual({
      rows: [],
      error: { code: "not_configured" },
      debug: [{ key: "console_auth_state", value: "none" }],
    });
    expect(http).not.toHaveBeenCalled();
  });

  it.each([
    [
      "no sign-in while opencode is listed in enabledProviders",
      [],
      "none",
      "internal",
      `No OpenCode Console sign-in found. ${LOGIN_HINT}`,
    ],
    [
      "a sign-in without an access token",
      [consoleLogin({ access: " " })],
      "invalid",
      "not_configured",
      `OpenCode Console sign-in failed: OpenCode Console credential has no access token. ${LOGIN_HINT}`,
    ],
    [
      "an expired sign-in",
      [consoleLogin({ expires: NOW - 1 })],
      "expired",
      "login_expired",
      `OpenCode Console sign-in failed: the sign-in expired. ${LOGIN_HINT}`,
    ],
  ])("reports %s without asking the Console", async (_name, logins, authState, code, message) => {
    world.storeLogins(logins);
    const http = consoleHttp();

    const fetched = await fetchRows(opencodeZenProvider, EXPLICIT);

    expect(fetched.rows).toEqual([]);
    expect(fetched.error?.code).toBe(code);
    expect(fetched.debug).toEqual([
      { key: "console_auth_state", value: authState },
      { key: "error", value: `OpenCode Zen: ${message}` },
      { key: "error_kind", value: code },
    ]);
    expect(http).not.toHaveBeenCalled();
  });

  it("reports a sign-in OpenCode could not refresh, with its token redacted", async () => {
    const integration = createFakeIntegration([
      {
        integrationId: "opencode",
        id: "cred_console",
        label: "default",
        registered: true,
        method: "oauth",
        value: consoleLogin().value as Record<string, unknown>,
        resolveError: `HTTP 401 for token ${"a".repeat(40)}`,
      },
    ]);
    const unbind = bindCredentialSource(createIntegrationCredentialSource(integration as never));

    try {
      const fetched = await fetchRows(opencodeZenProvider);

      expect(fetched.error?.code).toBe("login_expired");
      expect(errorDebug(fetched)).toEqual([
        `OpenCode Zen: OpenCode Console sign-in failed: refresh_failed: HTTP 401 for token [redacted]. ${LOGIN_HINT}`,
      ]);
    } finally {
      unbind();
    }
  });

  it("asks the sign-in's Console server for each route with its token and org", async () => {
    world.storeLogins([
      consoleLogin({
        metadata: {
          orgID: "wrk_abc",
          accountID: "usr_me",
          server: "https://console.example.test",
        },
      }),
    ]);
    const http = consoleHttp({}, "https://console.example.test/api");

    const fetched = await fetchRows(opencodeZenProvider);

    expect(rowSummary(fetched.rows)).toEqual([NO_SPEND_ROW, BALANCE_ROW, RELOAD_OFF_ROW]);
    expect(http.mock.calls.map(([url]) => url).sort()).toEqual(
      [
        "billing/account",
        "billing/auto-recharge",
        "billing/status",
        BUDGET_ROUTE,
        "usage/cost-by-day",
      ].map((route) => `https://console.example.test/api/${route}`),
    );
    for (const [, init] of http.mock.calls) {
      expect(requestHeader(init, "Authorization")).toBe("Bearer st_secret-token");
      expect(requestHeader(init, "x-org-id")).toBe("wrk_abc");
    }
    expect(fetched.debug).toContainEqual({ key: "console_auth_state", value: "configured" });
    expect(JSON.stringify(fetched.debug)).not.toMatch(/console\.example\.test|wrk_abc/u);
  });

  it.each([
    [
      "this month's spend when there is no limit (string micro-cents, older months left out)",
      {
        "usage/cost-by-day": [
          { date: "2026-08-31", totalCostMicroCents: "900000000" },
          { date: "2026-09-01", totalCostMicroCents: "1100000000" },
          { date: "2026-09-24", totalCostMicroCents: 82_020_000 },
        ],
      },
      {},
      [
        ["opencode.monthly", null, "Monthly", "month", "11.8202 USD", null],
        BALANCE_ROW,
        RELOAD_OFF_ROW,
      ],
    ],
    [
      "the credit limit as the monthly budget, with auto reload on",
      {
        ...CREDIT_LIMIT,
        "billing/auto-recharge": { enabled: true, thresholdDollars: 5, rechargeAmountDollars: 20 },
      },
      {},
      [
        CREDIT_LIMIT_ROW,
        BALANCE_ROW,
        ["opencode.auto_reload", null, "Auto reload", null, true, null],
      ],
    ],
    [
      "a member budget before the credit limit, reset when the Console says",
      { ...CREDIT_LIMIT, [BUDGET_ROUTE]: [budget({ limitDollars: 60, spentDollars: 15 })] },
      {},
      [
        ["opencode.monthly", null, "Monthly", "month", "75 (15 USD of 60 USD)", NEXT_MONTH],
        BALANCE_ROW,
        RELOAD_OFF_ROW,
      ],
    ],
    [
      "the personal cap when it leaves less than the workspace cap",
      {
        ...CREDIT_LIMIT,
        [BUDGET_ROUTE]: [
          budget({ policyID: "pol_0", ruleID: "rule_0", limitDollars: 40, spentDollars: 3 }),
          budget({
            policyID: "pol_1",
            ruleID: "rule_1",
            limitDollars: 30,
            spentDollars: 3,
            scope: "each",
          }),
        ],
      },
      {},
      [
        ["opencode.monthly", null, "Monthly", "month", "90 (3 USD of 30 USD)", NEXT_MONTH],
        BALANCE_ROW,
        RELOAD_OFF_ROW,
      ],
    ],
    [
      "the workspace cap when it leaves less than the personal cap, with its own amounts",
      {
        ...CREDIT_LIMIT,
        [BUDGET_ROUTE]: [
          budget({ policyID: "pol_0", ruleID: "rule_0", limitDollars: 40, spentDollars: 35 }),
          budget({
            policyID: "pol_1",
            ruleID: "rule_1",
            limitDollars: 30,
            spentDollars: 2.44,
            scope: "each",
          }),
        ],
      },
      {},
      [
        ["opencode.monthly", null, "Monthly", "month", "12.5 (35 USD of 40 USD)", NEXT_MONTH],
        BALANCE_ROW,
        RELOAD_OFF_ROW,
      ],
    ],
    [
      "a whole-account cap next to a cap over some models only",
      {
        ...CREDIT_LIMIT,
        [BUDGET_ROUTE]: [
          budget({ policyID: "pol_0", ruleID: "rule_0", limitDollars: 40, spentDollars: 2.44 }),
          budget({
            policyID: "pol_1",
            ruleID: "rule_1",
            limitDollars: 10,
            spentDollars: 1,
            coverage: "models",
          }),
        ],
      },
      {},
      [
        ["opencode.monthly", null, "Monthly", "month", "93.9 (2.44 USD of 40 USD)", NEXT_MONTH],
        BALANCE_ROW,
        RELOAD_OFF_ROW,
      ],
    ],
    [
      "a $0 member budget as a blocking 0% budget",
      { ...CREDIT_LIMIT, [BUDGET_ROUTE]: [budget({ limitDollars: 0, spentDollars: 0 })] },
      {},
      [
        ["opencode.monthly", null, "Monthly", "month", "0 (0 USD of 0 USD)", NEXT_MONTH],
        BALANCE_ROW,
        RELOAD_OFF_ROW,
      ],
    ],
    [
      "a $0 per-model member budget as a blocking 0% budget",
      {
        ...CREDIT_LIMIT,
        [BUDGET_ROUTE]: [budget({ limitDollars: 0, spentDollars: 0, per: "model" })],
      },
      {},
      [
        ["opencode.monthly", null, "Monthly", "month", "0 (0 USD of 0 USD)", NEXT_MONTH],
        BALANCE_ROW,
        RELOAD_OFF_ROW,
      ],
    ],
    [
      "the configured opencodeMonthlyLimit over the credit limit",
      CREDIT_LIMIT,
      { opencodeMonthlyLimit: 200 },
      [
        ["opencode.monthly", null, "Monthly", "month", "97.125 (5.75 USD of 200 USD)", null],
        BALANCE_ROW,
        RELOAD_OFF_ROW,
      ],
    ],
  ])("shows %s", async (_name, overrides, config, rows) => {
    world.storeLogins([consoleLogin()]);
    consoleHttp(overrides);

    const fetched = await fetchRows(opencodeZenProvider, config);

    expect(rowSummary(fetched.rows)).toEqual(rows);
    expect(fetched.error).toBeUndefined();
  });

  it("names the member budget as the budget source in its status", async () => {
    world.storeLogins([consoleLogin()]);
    consoleHttp({
      ...CREDIT_LIMIT,
      [BUDGET_ROUTE]: [budget({ limitDollars: 60, spentDollars: 15 })],
    });

    const fetched = await fetchRows(opencodeZenProvider);

    expect(fetched.debug).toContainEqual({ key: "budget_source", value: "member_budget" });
    expect(fetched.debug.map((item) => item.key)).not.toContain("member_budget_note");
  });

  it.each([
    [
      "a cap over some models only",
      [budget({ limitDollars: 10, spentDollars: 1, coverage: "models" })],
    ],
    ["a per-model limit", [budget({ limitDollars: 25, spentDollars: 3, per: "model" })]],
    ["missing amounts", [budget({ limitDollars: null, spentDollars: null })]],
    ["a missing limit", [budget({ limitDollars: undefined })]],
    ["a missing spend", [budget({ spentDollars: undefined })]],
    ["an unknown coverage", [budget({ coverage: "some" })]],
  ])(
    "uses the credit limit without an error for a member budget with %s",
    async (_name, budgets) => {
      world.storeLogins([consoleLogin()]);
      consoleHttp({ ...CREDIT_LIMIT, [BUDGET_ROUTE]: budgets });

      const fetched = await fetchRows(opencodeZenProvider);

      expect(rowSummary(fetched.rows)).toEqual([CREDIT_LIMIT_ROW, BALANCE_ROW, RELOAD_OFF_ROW]);
      expect(fetched.error).toBeUndefined();
      expect(fetched.debug).toEqual(
        expect.arrayContaining([
          { key: "budget_source", value: "credit_limit" },
          {
            key: "member_budget_note",
            value:
              "member budgets found, but none can be used as the monthly cap (model filters, per-model limits, or missing amounts); using the credit limit",
          },
        ]),
      );
    },
  );

  it("uses the credit limit quietly for a member without budgets", async () => {
    world.storeLogins([consoleLogin()]);
    consoleHttp(CREDIT_LIMIT);

    const fetched = await fetchRows(opencodeZenProvider);

    expect(rowSummary(fetched.rows)).toEqual([CREDIT_LIMIT_ROW, BALANCE_ROW, RELOAD_OFF_ROW]);
    expect(fetched.error).toBeUndefined();
    expect(fetched.debug.map((item) => item.key)).not.toContain("member_budget_note");
  });

  it("resets a member budget at the start of the next UTC month across a year end", async () => {
    const now = Date.parse("2026-12-31T23:30:00.000Z");
    vi.setSystemTime(now);
    world.storeLogins([consoleLogin({ expires: now + 3_600_000 })]);
    consoleHttp({
      [BUDGET_ROUTE]: [budget({ limitDollars: 60, spentDollars: 15, resetsAt: undefined })],
    });

    const fetched = await fetchRows(opencodeZenProvider);

    expect(fetched.rows[0]?.resetsAt).toBe("2027-01-01T00:00:00.000Z");
  });

  it("resets a member budget when the Console gives the reset time", async () => {
    world.storeLogins([consoleLogin()]);
    consoleHttp({
      [BUDGET_ROUTE]: [
        budget({ limitDollars: 60, spentDollars: 15, resetsAt: "2026-10-15T00:00:00.000Z" }),
      ],
    });

    const fetched = await fetchRows(opencodeZenProvider);

    expect(fetched.rows[0]?.resetsAt).toBe("2026-10-15T00:00:00.000Z");
  });

  it.each([
    [
      "failed auto reload and usage routes",
      { "billing/auto-recharge": serverError, "usage/cost-by-day": serverError },
      [BALANCE_ROW],
      "provider_error",
      [
        "OpenCode Console billing/auto-recharge error 500",
        "OpenCode Console usage/cost-by-day error 500",
      ],
    ],
    [
      "a failed budget route, falling back to the credit limit",
      { ...CREDIT_LIMIT, [BUDGET_ROUTE]: serverError },
      [CREDIT_LIMIT_ROW, BALANCE_ROW, RELOAD_OFF_ROW],
      "provider_error",
      ["OpenCode Console policies/current-budgets error 500"],
    ],
    [
      "a forbidden budget route, falling back to the credit limit",
      { ...CREDIT_LIMIT, [BUDGET_ROUTE]: () => new Response("forbidden", { status: 403 }) },
      [CREDIT_LIMIT_ROW, BALANCE_ROW, RELOAD_OFF_ROW],
      "provider_error",
      ["OpenCode Console policies/current-budgets error 403"],
    ],
    [
      "a budget reply that is not a list, falling back to the credit limit",
      { ...CREDIT_LIMIT, [BUDGET_ROUTE]: { budgets: [] } },
      [CREDIT_LIMIT_ROW, BALANCE_ROW, RELOAD_OFF_ROW],
      "bad_response",
      ["Could not parse OpenCode Console policies/current-budgets response"],
    ],
  ])("keeps the balance and reports %s", async (_name, overrides, rows, code, messages) => {
    world.storeLogins([consoleLogin()]);
    consoleHttp(overrides);

    const fetched = await fetchRows(opencodeZenProvider);

    expect(rowSummary(fetched.rows)).toEqual(rows);
    expect(fetched.error?.code).toBe(code);
    expect(errorDebug(fetched)).toEqual(messages.map((message) => `OpenCode Zen: ${message}`));
    expect(JSON.stringify(fetched)).not.toContain("usr_me");
  });

  it("asks for the budgets without an account id", async () => {
    world.storeLogins([consoleLogin({ metadata: { orgID: "wrk_abc" } })]);
    const http = consoleHttp(CREDIT_LIMIT);

    const fetched = await fetchRows(opencodeZenProvider);

    expect(rowSummary(fetched.rows)).toEqual([CREDIT_LIMIT_ROW, BALANCE_ROW, RELOAD_OFF_ROW]);
    expect(fetched.error).toBeUndefined();
    expect(http.mock.calls.map(([url]) => url)).toContain(`${CONSOLE_API}/${BUDGET_ROUTE}`);
  });

  it.each([
    ["a text reply", "none"],
    ["a budget that is not an object", ["none"]],
    ["a text amount", [budget({ limitDollars: "60" as never })]],
    ["a negative amount", [budget({ limitDollars: -1 })]],
    ["an amount over 90,000,000 dollars", [budget({ limitDollars: 90_000_001 })]],
  ])("lists a parse error for a budget reply with %s", async (_name, reply) => {
    world.storeLogins([consoleLogin()]);
    consoleHttp({ ...CREDIT_LIMIT, [BUDGET_ROUTE]: reply });

    const fetched = await fetchRows(opencodeZenProvider);

    expect(rowSummary(fetched.rows)).toEqual([CREDIT_LIMIT_ROW, BALANCE_ROW, RELOAD_OFF_ROW]);
    expect(errorDebug(fetched)).toEqual([
      "OpenCode Zen: Could not parse OpenCode Console policies/current-budgets response",
    ]);
  });

  it.each([
    ["the account id", "usr_me"],
    ["a padded account id", " usr_me "],
    ["an account id that needs URL encoding", "usr me/1"],
  ])("keeps %s out of a failed request", async (_name, accountID) => {
    world.storeLogins([consoleLogin({ metadata: { orgID: "wrk_abc", accountID } })]);
    consoleHttp({
      [BUDGET_ROUTE]: () => {
        throw new Error(`connect ECONNREFUSED for /api/${BUDGET_ROUTE} (${accountID.trim()})`);
      },
    });

    const fetched = await fetchRows(opencodeZenProvider);

    expect(errorDebug(fetched)).toEqual([
      "OpenCode Zen: OpenCode Console policies/current-budgets request failed: connect ECONNREFUSED for /api/policies/current-budgets ([redacted])",
    ]);
    expect(JSON.stringify(fetched)).not.toContain(accountID.trim());
    expect(JSON.stringify(fetched)).not.toContain(encodeURIComponent(accountID.trim()));
  });

  it.each([
    [
      "an expired session on any route",
      { [BUDGET_ROUTE]: () => new Response("unauthorized", { status: 401 }) },
      "login_expired",
      SESSION_ERROR,
    ],
    [
      "a redirect to the sign-in page",
      {
        "billing/status": () =>
          new Response(null, { status: 302, headers: { location: "/login" } }),
      },
      "login_expired",
      SESSION_ERROR,
    ],
    [
      "a failed balance route",
      { "billing/status": serverError },
      "provider_error",
      "OpenCode Console billing/status error 500",
    ],
    [
      "an unreadable balance",
      { "billing/status": { balanceMicroCents: "lots" } },
      "bad_response",
      "Could not parse OpenCode Console billing/status response",
    ],
  ])("shows no rows for %s", async (_name, overrides, code, message) => {
    world.storeLogins([consoleLogin()]);
    consoleHttp(overrides);

    const fetched = await fetchRows(opencodeZenProvider);

    expect(fetched.rows).toEqual([]);
    expect(fetched.error?.code).toBe(code);
    expect(errorDebug(fetched)).toEqual([`OpenCode Zen: ${message}`]);
    expect(JSON.stringify(fetched)).not.toContain("st_secret-token");
  });

  it.each([
    ["a sign-in", [consoleLogin()], "auto", true],
    ["an expired sign-in", [consoleLogin({ expires: NOW - 1 })], "auto", true],
    ["no sign-in", [], "auto", false],
    ["no sign-in while opencode is listed in enabledProviders", [], ["opencode"], true],
  ])("is available with %s", async (_name, logins, enabledProviders, expected) => {
    world.storeLogins(logins);

    await expect(
      opencodeZenProvider.isAvailable({ config: { enabledProviders } } as never),
    ).resolves.toBe(expected);
  });

  it("does not treat the v6 discovery list as an explicit request without a Console sign-in", async () => {
    world.storeLogins([]);
    const config = { ...EXPLICIT, automaticDiscovery: true };
    await expect(opencodeZenProvider.isAvailable({ config } as never)).resolves.toBe(false);
    const http = consoleHttp();
    expect((await fetchRows(opencodeZenProvider, config)).rows).toEqual([]);
    expect(http).not.toHaveBeenCalled();
  });

  it.each([
    ["opencode/gpt-5", true],
    ["OPENCODE/gemini", true],
    ["opencode-go/model", false],
  ])("matches model %s: %s", (model, expected) => {
    expect(opencodeZenProvider.matchesCurrentModel?.(model)).toBe(expected);
  });
});
