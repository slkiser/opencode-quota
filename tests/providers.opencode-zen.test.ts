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

const MEMBER_ROUTE = "policies/members/usr_me";

/** A funded account without a monthly limit or member budget: $42.50 balance, auto reload off. */
const ROUTES: Record<string, unknown> = {
  "billing/status": { balanceMicroCents: "4250000000" },
  "billing/account": { creditLimitMicroCents: null },
  "billing/auto-recharge": { enabled: false, thresholdDollars: 5, rechargeAmountDollars: 20 },
  [MEMBER_ROUTE]: { userID: "usr_me", budgets: [], policies: [] },
  "usage/cost-by-day": [],
};

/** A $100 credit limit with $5.75 spent this month: the fallback when no member budget is used. */
const CREDIT_LIMIT = {
  "billing/account": { creditLimitMicroCents: "10000000000" },
  "usage/cost-by-day": [{ date: "2026-09-24", totalCostMicroCents: "575000000" }],
};

/** A monthly budget rule, unfiltered (`includeUnknownPrice` alone restricts no model). */
function budgetRule(id: string, fields: Record<string, unknown> = {}) {
  return {
    id,
    kind: "budget",
    period: "month",
    scope: "combined",
    per: "set",
    selector: { includeUnknownPrice: false },
    ...fields,
  };
}

/** The signed-in member's budgets, each with its own policy holding `rule` (default: matching). */
function member(
  budgets: Array<{
    limit?: number | null;
    spent?: number | null;
    scope?: string;
    per?: string;
    rule?: Record<string, unknown>;
  }>,
) {
  return {
    userID: "usr_me",
    budgets: budgets.map(({ limit, spent, scope = "combined", per }, index) => ({
      policyID: `pol_${index}`,
      ruleID: `rule_${index}`,
      scope,
      ...(per ? { per } : {}),
      limitDollars: limit,
      spentDollars: spent,
    })),
    policies: budgets.map(({ scope = "combined", per, rule }, index) => ({
      id: `pol_${index}`,
      rules: [budgetRule(`rule_${index}`, { scope, ...(per ? { per } : {}), ...rule })],
    })),
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
        MEMBER_ROUTE,
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
      "a member budget before the credit limit, reset at the start of the next UTC month",
      { ...CREDIT_LIMIT, [MEMBER_ROUTE]: member([{ limit: 60, spent: 15 }]) },
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
        [MEMBER_ROUTE]: member([
          { limit: 40, spent: 3 },
          { limit: 30, spent: 3, scope: "each" },
        ]),
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
        [MEMBER_ROUTE]: member([
          { limit: 40, spent: 35 },
          { limit: 30, spent: 2.44, scope: "each" },
        ]),
      },
      {},
      [
        ["opencode.monthly", null, "Monthly", "month", "12.5 (35 USD of 40 USD)", NEXT_MONTH],
        BALANCE_ROW,
        RELOAD_OFF_ROW,
      ],
    ],
    [
      "a $0 member budget as a blocking 0% budget",
      { ...CREDIT_LIMIT, [MEMBER_ROUTE]: member([{ limit: 0, spent: 0 }]) },
      {},
      [
        ["opencode.monthly", null, "Monthly", "month", "0 (0 USD of 0 USD)", NEXT_MONTH],
        BALANCE_ROW,
        RELOAD_OFF_ROW,
      ],
    ],
    [
      "a $0 per-model member budget as a blocking 0% budget",
      { ...CREDIT_LIMIT, [MEMBER_ROUTE]: member([{ limit: 0, spent: 0, per: "model" }]) },
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
    consoleHttp({ ...CREDIT_LIMIT, [MEMBER_ROUTE]: member([{ limit: 60, spent: 15 }]) });

    const fetched = await fetchRows(opencodeZenProvider);

    expect(fetched.debug).toContainEqual({ key: "budget_source", value: "member_budget" });
    expect(fetched.debug.map((item) => item.key)).not.toContain("member_budget_note");
  });

  it.each([
    ["a model filter", [{ limit: 10, spent: 1, rule: { selector: { models: ["gpt-5"] } } }]],
    ["a vendor filter", [{ limit: 10, spent: 1, rule: { selector: { vendors: ["openai"] } } }]],
    ["a price filter", [{ limit: 10, spent: 1, rule: { selector: { inputPriceAtLeast: 0 } } }]],
    ["a null selector", [{ limit: 10, spent: 1, rule: { selector: null } }]],
    ["a text selector", [{ limit: 10, spent: 1, rule: { selector: "openai" } }]],
    ["an unknown selector key", [{ limit: 10, spent: 1, rule: { selector: { brands: [] } } }]],
    ["a non-string models entry", [{ limit: 10, spent: 1, rule: { selector: { models: [7] } } }]],
    ["a non-list vendors filter", [{ limit: 10, spent: 1, rule: { selector: { vendors: "x" } } }]],
    [
      "a non-boolean includeUnknownPrice",
      [{ limit: 10, spent: 1, rule: { selector: { includeUnknownPrice: "no" } } }],
    ],
    [
      "a filtered budget next to an applicable one",
      [
        { limit: 40, spent: 2.44 },
        { limit: 10, spent: 1, rule: { selector: { models: ["gpt-5"] } } },
      ],
    ],
    ["a rule that is not a monthly budget", [{ limit: 40, spent: 2, rule: { kind: "usage" } }]],
    ["a weekly budget rule", [{ limit: 40, spent: 2, rule: { period: "week" } }]],
    ["a rule with another scope", [{ limit: 40, spent: 2, rule: { scope: "each" } }]],
    ["a non-zero per-model budget", [{ limit: 25, spent: 3, per: "model" }]],
    ["a rule the policy does not have", [{ limit: 40, spent: 2, rule: { id: "rule_gone" } }]],
    ["missing amounts", [{ limit: null, spent: null }]],
    ["a missing spend", [{ limit: 40 }]],
  ])(
    "uses the credit limit without an error for a member budget with %s",
    async (_name, budgets) => {
      world.storeLogins([consoleLogin()]);
      consoleHttp({ ...CREDIT_LIMIT, [MEMBER_ROUTE]: member(budgets) });

      const fetched = await fetchRows(opencodeZenProvider);

      expect(rowSummary(fetched.rows)).toEqual([CREDIT_LIMIT_ROW, BALANCE_ROW, RELOAD_OFF_ROW]);
      expect(fetched.error).toBeUndefined();
      expect(fetched.debug).toEqual(
        expect.arrayContaining([
          { key: "budget_source", value: "credit_limit" },
          {
            key: "member_budget_note",
            value:
              "member budgets found, but not all can be evaluated (model filters, per-model limits, or missing amounts); using the credit limit",
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
    consoleHttp({ [MEMBER_ROUTE]: member([{ limit: 60, spent: 15 }]) });

    const fetched = await fetchRows(opencodeZenProvider);

    expect(fetched.rows[0]?.resetsAt).toBe("2027-01-01T00:00:00.000Z");
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
      "a failed member route, falling back to the credit limit",
      { ...CREDIT_LIMIT, [MEMBER_ROUTE]: serverError },
      [CREDIT_LIMIT_ROW, BALANCE_ROW, RELOAD_OFF_ROW],
      "provider_error",
      ["OpenCode Console policies/members error 500"],
    ],
    [
      "a forbidden member route, falling back to the credit limit",
      { ...CREDIT_LIMIT, [MEMBER_ROUTE]: () => new Response("forbidden", { status: 403 }) },
      [CREDIT_LIMIT_ROW, BALANCE_ROW, RELOAD_OFF_ROW],
      "provider_error",
      ["OpenCode Console policies/members error 403"],
    ],
    [
      "a member reply for another account, falling back to the credit limit",
      { ...CREDIT_LIMIT, [MEMBER_ROUTE]: { ...member([{ limit: 0, spent: 0 }]), userID: "usr_x" } },
      [CREDIT_LIMIT_ROW, BALANCE_ROW, RELOAD_OFF_ROW],
      "bad_response",
      ["Could not parse OpenCode Console policies/members response"],
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

  it("asks for no member budget and lists why for a sign-in without an account id", async () => {
    world.storeLogins([consoleLogin({ metadata: { orgID: "wrk_abc" } })]);
    const http = consoleHttp(CREDIT_LIMIT);

    const fetched = await fetchRows(opencodeZenProvider);

    expect(rowSummary(fetched.rows)).toEqual([CREDIT_LIMIT_ROW, BALANCE_ROW, RELOAD_OFF_ROW]);
    expect(fetched.error?.code).toBe("no_data");
    expect(errorDebug(fetched)).toEqual([
      "OpenCode Zen: OpenCode Console member budgets unavailable: the Console sign-in has no account id",
    ]);
    expect(http.mock.calls.map(([url]) => url)).not.toContain(`${CONSOLE_API}/${MEMBER_ROUTE}`);
  });

  it.each([
    ["no budgets list", { userID: "usr_me", policies: [] }],
    ["a text reply", "none"],
    ["a budget that is not an object", { userID: "usr_me", budgets: ["none"], policies: [] }],
    ["policies that are not a list", { ...member([{ limit: 60, spent: 5 }]), policies: {} }],
    ["an unknown scope", member([{ limit: 60, spent: 5, scope: "per-user" }])],
    ["an unknown per", member([{ limit: 60, spent: 5, per: "day" }])],
    ["a text amount", member([{ limit: "60" as never, spent: 5 }])],
    ["a negative amount", member([{ limit: -1, spent: 5 }])],
    ["an amount over 90,000,000 dollars", member([{ limit: 90_000_001, spent: 5 }])],
    [
      "a budget without a rule id",
      { userID: "usr_me", budgets: [{ policyID: "pol_0", scope: "combined" }], policies: [] },
    ],
  ])("lists a parse error for a member reply with %s", async (_name, reply) => {
    world.storeLogins([consoleLogin()]);
    consoleHttp({ ...CREDIT_LIMIT, [MEMBER_ROUTE]: reply });

    const fetched = await fetchRows(opencodeZenProvider);

    expect(rowSummary(fetched.rows)).toEqual([CREDIT_LIMIT_ROW, BALANCE_ROW, RELOAD_OFF_ROW]);
    expect(errorDebug(fetched)).toEqual([
      "OpenCode Zen: Could not parse OpenCode Console policies/members response",
    ]);
  });

  it.each([
    ["the account id", "usr_me"],
    ["a padded account id", " usr_me "],
    ["an account id that needs URL encoding", "usr me/1"],
  ])("keeps %s out of a failed member request", async (_name, accountID) => {
    world.storeLogins([consoleLogin({ metadata: { orgID: "wrk_abc", accountID } })]);
    const memberPath = `policies/members/${encodeURIComponent(accountID.trim())}`;
    consoleHttp({
      [memberPath]: () => {
        throw new Error(`connect ECONNREFUSED for /api/${memberPath} (${accountID.trim()})`);
      },
    });

    const fetched = await fetchRows(opencodeZenProvider);

    expect(errorDebug(fetched)).toEqual([
      "OpenCode Zen: OpenCode Console policies/members request failed: connect ECONNREFUSED for /api/policies/members/[redacted] ([redacted])",
    ]);
    expect(JSON.stringify(fetched)).not.toContain(accountID.trim());
    expect(JSON.stringify(fetched)).not.toContain(encodeURIComponent(accountID.trim()));
  });

  it.each([
    [
      "an expired session on any route",
      { [MEMBER_ROUTE]: () => new Response("unauthorized", { status: 401 }) },
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
