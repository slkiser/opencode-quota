import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
  baseUrl: "https://opencode.ai/console",
  accountId: "usr_me",
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
// Payload shaped like the policies/members/{userID} response for the signed-in
// member (ids replaced): one workspace (combined-audience) budget rule in its
// correlated policy. Model selectors live on the rule, not the policy.
const MEMBER = {
  userID: "usr_me",
  budgets: [
    {
      policyID: "pol_ws",
      ruleID: "rule_ws",
      scope: "combined",
      limitDollars: 60,
      spentDollars: 6.1735557,
    },
  ],
  policies: [
    {
      id: "pol_ws",
      audience: { members: ["usr_me"] },
      rules: [
        {
          id: "rule_ws",
          kind: "budget",
          period: "month",
          scope: "combined",
          per: "set",
          limitDollars: 60,
          spentDollars: 6.1735557,
          selector: { includeUnknownPrice: false },
        },
      ],
    },
  ],
};

// Console monthly budgets reset at the start of the next UTC month; the tests
// run at 2026-09-25T12:00Z.
const NEXT_MONTH_RESET = "2026-10-01T00:00:00.000Z";

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
    "policies/members/usr_me": () => json(MEMBER),
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

  it("calls the five Console routes with the Bearer token and org id", async () => {
    routes();

    await queryOpenCodeZenQuota(account, { requestTimeoutMs: 4_000 });

    expect(mocks.fetchWithTimeout.mock.calls.map(([url]) => url).sort()).toEqual([
      `${CONSOLE_API}/billing/account`,
      `${CONSOLE_API}/billing/auto-recharge`,
      `${CONSOLE_API}/billing/status`,
      `${CONSOLE_API}/policies/members/usr_me`,
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
        monthlyLimit: 60,
        monthlyUsage: 617_355_570,
        lastPayment: null,
        reload: false,
        reloadAmount: 20,
        reloadTrigger: 5,
        budgetResetIso: NEXT_MONTH_RESET,
        memberBudgetsSkipped: false,
      },
      errors: [],
    });
  });

  it("resets a member budget at the start of the next UTC month across a year end", async () => {
    vi.setSystemTime(new Date("2026-12-31T23:30:00.000Z"));
    routes();

    await expect(queryOpenCodeZenQuota(account)).resolves.toMatchObject({
      success: true,
      data: { budgetResetIso: "2027-01-01T00:00:00.000Z" },
    });
  });

  /**
   * A monthly budget rule as lines up in a verified policy: `kind: "budget"`,
   * `period: "month"` with `scope`/`per`/limit/spend, plus a `selector` that is
   * unfiltered (`includeUnknownPrice: false` restricts nothing).
   */
  function budgetRule(id: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
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

  function memberBudget(
    policyID: string,
    ruleID: string,
    fields: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return { policyID, ruleID, scope: "combined", ...fields };
  }

  function memberPayload(
    budgets: Array<Record<string, unknown>>,
    policies: Array<Record<string, unknown>>,
  ): unknown {
    return { userID: "usr_me", budgets, policies };
  }

  /**
   * Mirrors the Console UI for an organization with both a workspace cap
   * ("Entire workspace can spend up to $40 a month combined") and a personal cap
   * ("vmvarela@gmail.com can spend up to $30 a month per member"), both $2.44 in.
   */
  const WORKSPACE_PLUS_PERSONAL = memberPayload(
    [
      memberBudget("pol_ws", "rule_ws", {
        scope: "combined",
        limitDollars: 40,
        spentDollars: 2.44,
      }),
      memberBudget("pol_me", "rule_me", { scope: "each", limitDollars: 30, spentDollars: 2.44 }),
    ],
    [
      {
        id: "pol_ws",
        audience: { workspace: true },
        rules: [budgetRule("rule_ws", { limitDollars: 40, spentDollars: 2.44 })],
      },
      {
        id: "pol_me",
        audience: { members: ["usr_me"] },
        rules: [budgetRule("rule_me", { scope: "each", limitDollars: 30, spentDollars: 2.44 })],
      },
    ],
  );

  it("selects the workspace budget when the member has no personal budget", async () => {
    routes({
      "billing/account": () => json({ ...ACCOUNT, creditLimitMicroCents: "10000000000" }),
      "usage/cost-by-day": () => json([{ date: "2026-09-24", totalCostMicroCents: "75000000" }]),
      "policies/members/usr_me": () =>
        json(
          memberPayload(
            [memberBudget("pol_ws", "rule_ws", { limitDollars: 40, spentDollars: 2.44 })],
            [
              {
                id: "pol_ws",
                rules: [budgetRule("rule_ws", { limitDollars: 40, spentDollars: 2.44 })],
              },
            ],
          ),
        ),
    });

    // The workspace rule (shared accounting over its audience) supplies the
    // budget when the member has none of their own; it resets with the UTC month.
    await expect(queryOpenCodeZenQuota(account)).resolves.toMatchObject({
      success: true,
      data: {
        monthlyLimit: 40,
        monthlyUsage: 244_000_000,
        budgetResetIso: NEXT_MONTH_RESET,
      },
      errors: [],
    });
  });

  it("prefers the personal cap over the workspace cap when both apply", async () => {
    routes({ "policies/members/usr_me": () => json(WORKSPACE_PLUS_PERSONAL) });

    // Personal remains $30 - $2.44 = $27.56 < workspace $40 - $2.44 = $37.56;
    // the workspace cap is not org-wide, it is only the shared accounting of
    // its audience.
    await expect(queryOpenCodeZenQuota(account)).resolves.toMatchObject({
      success: true,
      data: { monthlyLimit: 30, monthlyUsage: 244_000_000, budgetResetIso: NEXT_MONTH_RESET },
      errors: [],
    });
  });

  it("selects the workspace cap when it binds harder than the personal cap", async () => {
    routes({
      "policies/members/usr_me": () =>
        json(
          memberPayload(
            [
              memberBudget("pol_ws", "rule_ws", { limitDollars: 40, spentDollars: 35 }),
              memberBudget("pol_me", "rule_me", {
                scope: "each",
                limitDollars: 30,
                spentDollars: 2.44,
              }),
            ],
            [
              {
                id: "pol_ws",
                rules: [budgetRule("rule_ws", { limitDollars: 40, spentDollars: 35 })],
              },
              {
                id: "pol_me",
                audience: { members: ["usr_me"] },
                rules: [
                  budgetRule("rule_me", { scope: "each", limitDollars: 30, spentDollars: 2.44 }),
                ],
              },
            ],
          ),
        ),
    });

    // Workspace remaining $5 < personal remaining $30 - $2.44 = $27.56.
    await expect(queryOpenCodeZenQuota(account)).resolves.toMatchObject({
      success: true,
      data: { monthlyLimit: 40, monthlyUsage: 3_500_000_000, budgetResetIso: NEXT_MONTH_RESET },
      errors: [],
    });
  });

  it("selects the lowest absolute remaining and keeps the chosen budget's own amounts", async () => {
    routes({
      "policies/members/usr_me": () =>
        json(
          memberPayload(
            [
              memberBudget("pol_shared", "r2", { limitDollars: 1000, spentDollars: 900 }),
              memberBudget("pol_each", "r1", { scope: "each", limitDollars: 60, spentDollars: 59 }),
            ],
            [
              {
                id: "pol_shared",
                rules: [budgetRule("r2", { limitDollars: 1000, spentDollars: 900 })],
              },
              {
                id: "pol_each",
                rules: [budgetRule("r1", { scope: "each", limitDollars: 60, spentDollars: 59 })],
              },
            ],
          ),
        ),
    });

    // The $60 personal budget with $59 spent ($1 left) binds; neither the shared
    // cap's limit ($1000) nor its spend ($900) may be mixed into the entry.
    await expect(queryOpenCodeZenQuota(account)).resolves.toMatchObject({
      success: true,
      data: { monthlyLimit: 60, monthlyUsage: 5_900_000_000, budgetResetIso: NEXT_MONTH_RESET },
      errors: [],
    });
  });

  it("falls back to the credit limit for a model-restricted rule budget", async () => {
    routes({
      "billing/account": () => json({ ...ACCOUNT, creditLimitMicroCents: "10000000000" }),
      "usage/cost-by-day": () => json([{ date: "2026-09-24", totalCostMicroCents: "75000000" }]),
      "policies/members/usr_me": () =>
        json(
          memberPayload(
            [memberBudget("pol_sel", "r1", { scope: "each", limitDollars: 10, spentDollars: 1 })],
            [
              {
                id: "pol_sel",
                rules: [
                  budgetRule("r1", {
                    scope: "each",
                    selector: { models: ["gpt-5"], vendors: ["openai"] },
                  }),
                ],
              },
            ],
          ),
        ),
    });

    // The restricted rule may only cap certain models; without the current
    // model's selector semantics Zen cannot claim it applies, so no member
    // budget is used and the credit-limit fallback applies without an error.
    await expect(queryOpenCodeZenQuota(account)).resolves.toEqual({
      success: true,
      data: {
        balance: 0,
        monthlyLimit: 100,
        monthlyUsage: 75_000_000,
        lastPayment: null,
        reload: false,
        reloadAmount: 20,
        reloadTrigger: 5,
        budgetResetIso: null,
        memberBudgetsSkipped: true,
      },
      errors: [],
    });
  });

  it("falls back to the credit limit when an unevaluable budget coexists with an applicable one", async () => {
    routes({
      "billing/account": () => json({ ...ACCOUNT, creditLimitMicroCents: "10000000000" }),
      "usage/cost-by-day": () => json([{ date: "2026-09-24", totalCostMicroCents: "75000000" }]),
      "policies/members/usr_me": () =>
        json(
          memberPayload(
            [
              memberBudget("pol_ws", "rule_ws", { limitDollars: 40, spentDollars: 2.44 }),
              memberBudget("pol_sel", "r1", { limitDollars: 10, spentDollars: 1 }),
            ],
            [
              {
                id: "pol_ws",
                rules: [budgetRule("rule_ws", { limitDollars: 40, spentDollars: 2.44 })],
              },
              {
                id: "pol_sel",
                rules: [budgetRule("r1", { selector: { models: ["gpt-5"] } })],
              },
            ],
          ),
        ),
    });

    // The skipped candidate could be the binding cap, so the known-applicable
    // budget is not a trustworthy effective limit: the credit limit applies.
    await expect(queryOpenCodeZenQuota(account)).resolves.toMatchObject({
      success: true,
      data: {
        monthlyLimit: 100,
        monthlyUsage: 75_000_000,
        budgetResetIso: null,
        memberBudgetsSkipped: true,
      },
      errors: [],
    });
  });

  it.each([
    ["a null selector", null],
    ["a non-object selector", "openai"],
    ["an unknown selector key", { includeUnknownPrice: false, brands: ["openai"] }],
    ["a non-string models entry", { models: [7] }],
    ["a non-array models filter", { models: true }],
    ["a non-array vendors filter", { vendors: "openai" }],
    ["an inputPriceAtLeast filter", { inputPriceAtLeast: 0.5 }],
    ["a non-boolean includeUnknownPrice", { includeUnknownPrice: "no" }],
  ])("falls back to the credit limit for %s in a rule selector", async (_name, selector) => {
    routes({
      "billing/account": () => json({ ...ACCOUNT, creditLimitMicroCents: "10000000000" }),
      "usage/cost-by-day": () => json([{ date: "2026-09-24", totalCostMicroCents: "75000000" }]),
      "policies/members/usr_me": () =>
        json(
          memberPayload(
            [memberBudget("pol_sel", "r1", { limitDollars: 10, spentDollars: 1 })],
            [
              {
                id: "pol_sel",
                rules: [budgetRule("r1", { selector })],
              },
            ],
          ),
        ),
    });

    await expect(queryOpenCodeZenQuota(account)).resolves.toMatchObject({
      success: true,
      data: {
        monthlyLimit: 100,
        monthlyUsage: 75_000_000,
        budgetResetIso: null,
        memberBudgetsSkipped: true,
      },
      errors: [],
    });
  });

  it("falls back to the credit limit when the member's only budget rule is not monthly budget kind", async () => {
    routes({
      "billing/account": () => json({ ...ACCOUNT, creditLimitMicroCents: "10000000000" }),
      "usage/cost-by-day": () => json([{ date: "2026-09-24", totalCostMicroCents: "75000000" }]),
      "policies/members/usr_me": () =>
        json(
          memberPayload(
            [memberBudget("pol_1", "r1", { limitDollars: 40, spentDollars: 2 })],
            [
              {
                id: "pol_1",
                rules: [
                  {
                    id: "r1",
                    kind: "usage",
                    period: "week",
                    per: "set",
                    limitDollars: 40,
                    spentDollars: 2,
                  },
                  budgetRule("r2", { limitDollars: 40, spentDollars: 2 }),
                ],
              },
            ],
          ),
        ),
    });

    await expect(queryOpenCodeZenQuota(account)).resolves.toMatchObject({
      success: true,
      data: {
        monthlyLimit: 100,
        monthlyUsage: 75_000_000,
        budgetResetIso: null,
        memberBudgetsSkipped: true,
      },
      errors: [],
    });
  });

  it("skips per-model budgets and keeps only a $0 per-model limit as blocking", async () => {
    routes({
      "billing/account": () => json({ ...ACCOUNT, creditLimitMicroCents: "10000000000" }),
      "usage/cost-by-day": () => json([{ date: "2026-09-24", totalCostMicroCents: "75000000" }]),
      "policies/members/usr_me": () =>
        json(
          memberPayload(
            [
              // A non-zero per-model limit has no per-model spend here, so it
              // cannot be claimed for the current model.
              memberBudget("pol_1", "r1", {
                per: "model",
                limitDollars: 25,
                spentDollars: 3,
                modelCount: 4,
              }),
            ],
            [
              {
                id: "pol_1",
                rules: [budgetRule("r1", { per: "model", limitDollars: 25, spentDollars: 3 })],
              },
            ],
          ),
        ),
    });

    const skipped = await queryOpenCodeZenQuota(account);
    expect(skipped).toMatchObject({
      success: true,
      data: {
        monthlyLimit: 100,
        monthlyUsage: 75_000_000,
        budgetResetIso: null,
        memberBudgetsSkipped: true,
      },
      errors: [],
    });

    routes({
      "policies/members/usr_me": () =>
        json(
          memberPayload(
            [
              // $0 per-model limit blocks every model of the unfiltered rule.
              memberBudget("pol_1", "r1", {
                per: "model",
                limitDollars: 0,
                spentDollars: 0,
                modelCount: 1,
              }),
            ],
            [
              {
                id: "pol_1",
                rules: [budgetRule("r1", { per: "model", limitDollars: 0, spentDollars: 0 })],
              },
            ],
          ),
        ),
    });

    const blocking = await queryOpenCodeZenQuota(account);
    expect(blocking).toMatchObject({
      success: true,
      data: { monthlyLimit: 0, monthlyUsage: 0, budgetResetIso: NEXT_MONTH_RESET },
      errors: [],
    });
  });

  it("falls back to the credit limit when a member budget's rule or policy cannot be matched", async () => {
    routes({
      "billing/account": () => json({ ...ACCOUNT, creditLimitMicroCents: "10000000000" }),
      "usage/cost-by-day": () => json([{ date: "2026-09-24", totalCostMicroCents: "75000000" }]),
      "policies/members/usr_me": () =>
        json(
          memberPayload(
            [
              memberBudget("pol_gone", "r1", { limitDollars: 40, spentDollars: 2 }),
              memberBudget("pol_ws", "rule_gone", { limitDollars: 40, spentDollars: 2 }),
            ],
            [
              {
                id: "pol_ws",
                rules: [budgetRule("rule_ws", { limitDollars: 40, spentDollars: 2.44 })],
              },
            ],
          ),
        ),
    });

    // Budgets need both their policy and their monthly budget rule matched
    // before Zen claims the amounts; unmatched ones never reach the entry.
    await expect(queryOpenCodeZenQuota(account)).resolves.toMatchObject({
      success: true,
      data: {
        monthlyLimit: 100,
        monthlyUsage: 75_000_000,
        budgetResetIso: null,
        memberBudgetsSkipped: true,
      },
      errors: [],
    });
  });

  it("falls back when the member response identity does not match the account id", async () => {
    routes({
      "billing/account": () => json({ ...ACCOUNT, creditLimitMicroCents: "10000000000" }),
      "usage/cost-by-day": () => json([{ date: "2026-09-24", totalCostMicroCents: "75000000" }]),
      "policies/members/usr_me": () => json({ ...MEMBER, userID: "usr_other" }),
    });

    await expect(queryOpenCodeZenQuota(account)).resolves.toEqual({
      success: true,
      data: {
        balance: 0,
        monthlyLimit: 100,
        monthlyUsage: 75_000_000,
        lastPayment: null,
        reload: false,
        reloadAmount: 20,
        reloadTrigger: 5,
        budgetResetIso: null,
        memberBudgetsSkipped: false,
      },
      errors: ["Could not parse OpenCode Console policies/members response"],
    });
  });

  it("falls back quietly when the member has no applicable budget", async () => {
    routes({
      "billing/status": () => json({ ...STATUS, balanceMicroCents: "4250000000" }),
      "billing/account": () => json({ ...ACCOUNT, creditLimitMicroCents: "10000000000" }),
      "usage/cost-by-day": () => json([{ date: "2026-09-24", totalCostMicroCents: "75000000" }]),
      "policies/members/usr_me": () => json({ userID: "usr_me", budgets: [], policies: [] }),
    });

    await expect(queryOpenCodeZenQuota(account)).resolves.toEqual({
      success: true,
      data: {
        balance: 4_250_000_000,
        monthlyLimit: 100,
        monthlyUsage: 75_000_000,
        lastPayment: null,
        reload: false,
        reloadAmount: 20,
        reloadTrigger: 5,
        budgetResetIso: null,
        memberBudgetsSkipped: false,
      },
      errors: [],
    });
  });

  it("falls back to the credit limit for a member budget without usable amounts", async () => {
    routes({
      "billing/status": () => json({ ...STATUS, balanceMicroCents: "4250000000" }),
      "billing/account": () => json({ ...ACCOUNT, creditLimitMicroCents: "10000000000" }),
      "usage/cost-by-day": () => json([{ date: "2026-09-24", totalCostMicroCents: "75000000" }]),
      "policies/members/usr_me": () =>
        json(
          memberPayload(
            [memberBudget("pol_ws", "rule_ws", { limitDollars: null, spentDollars: null })],
            [
              {
                id: "pol_ws",
                rules: [budgetRule("rule_ws", { limitDollars: null, spentDollars: null })],
              },
            ],
          ),
        ),
    });

    await expect(queryOpenCodeZenQuota(account)).resolves.toMatchObject({
      success: true,
      data: {
        monthlyLimit: 100,
        monthlyUsage: 75_000_000,
        budgetResetIso: null,
        memberBudgetsSkipped: true,
      },
      errors: [],
    });
  });

  it("falls back and lists an error when the member route fails", async () => {
    routes({
      "billing/status": () => json({ ...STATUS, balanceMicroCents: "4250000000" }),
      "billing/account": () => json({ ...ACCOUNT, creditLimitMicroCents: "10000000000" }),
      "usage/cost-by-day": () => json([{ date: "2026-09-24", totalCostMicroCents: "75000000" }]),
      "policies/members/usr_me": () => new Response("server error", { status: 500 }),
    });

    await expect(queryOpenCodeZenQuota(account)).resolves.toEqual({
      success: true,
      data: {
        balance: 4_250_000_000,
        monthlyLimit: 100,
        monthlyUsage: 75_000_000,
        lastPayment: null,
        reload: false,
        reloadAmount: 20,
        reloadTrigger: 5,
        budgetResetIso: null,
        memberBudgetsSkipped: false,
      },
      errors: ["OpenCode Console policies/members error 500"],
    });
  });

  it("keeps micro-cents as billing units and sums only the current month's costs", async () => {
    routes({
      "billing/status": () => json({ ...STATUS, balanceMicroCents: "4250000000" }),
      "billing/account": () => json({ ...ACCOUNT, creditLimitMicroCents: "10000000000" }),
      "billing/auto-recharge": () => json({ ...AUTO_RECHARGE, enabled: true }),
      "policies/members/usr_me": () => json({ userID: "usr_me", budgets: [], policies: [] }),
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
        budgetResetIso: null,
        memberBudgetsSkipped: false,
      },
      errors: [],
    });
  });

  it.each([
    [
      "billing/account",
      {
        monthlyLimit: 60,
        monthlyUsage: 617_355_570,
        reload: true,
        reloadAmount: 20,
        budgetResetIso: NEXT_MONTH_RESET,
      },
    ],
    [
      "billing/auto-recharge",
      {
        monthlyLimit: 60,
        monthlyUsage: 617_355_570,
        reload: null,
        reloadAmount: null,
        budgetResetIso: NEXT_MONTH_RESET,
      },
    ],
    [
      "usage/cost-by-day",
      {
        monthlyLimit: 60,
        monthlyUsage: 617_355_570,
        reload: true,
        reloadAmount: 20,
        budgetResetIso: NEXT_MONTH_RESET,
      },
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
        memberBudgetsSkipped: false,
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
      "policies/members/usr_me": failed,
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
        budgetResetIso: null,
        memberBudgetsSkipped: false,
      },
      errors: [
        "OpenCode Console billing/account error 500",
        "OpenCode Console billing/auto-recharge error 500",
        "OpenCode Console policies/members error 500",
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
      "policies/members/usr_me": sessionResponse,
      "usage/cost-by-day": sessionResponse,
    });

    const result = await queryOpenCodeZenQuota(account);

    expect(result).toEqual({ success: false, error: SESSION_ERROR });
    expect(JSON.stringify(result)).not.toContain("st_secret-token");
  });

  it("fails the query when the required billing/status route returns 403", async () => {
    routes({ "billing/status": () => new Response("forbidden", { status: 403 }) });

    await expect(queryOpenCodeZenQuota(account)).resolves.toEqual({
      success: false,
      error: "OpenCode Console billing/status error 403",
    });
  });

  it("keeps the balance when only policies/members/usr_me is forbidden", async () => {
    routes({
      "billing/status": () => json({ ...STATUS, balanceMicroCents: "4250000000" }),
      "billing/account": () => json({ ...ACCOUNT, creditLimitMicroCents: "10000000000" }),
      "usage/cost-by-day": () => json([{ date: "2026-09-24", totalCostMicroCents: "75000000" }]),
      "policies/members/usr_me": () => new Response("forbidden", { status: 403 }),
    });

    const result = await queryOpenCodeZenQuota(account);

    expect(result).toEqual({
      success: true,
      data: {
        balance: 4_250_000_000,
        monthlyLimit: 100,
        monthlyUsage: 75_000_000,
        lastPayment: null,
        reload: false,
        reloadAmount: 20,
        reloadTrigger: 5,
        budgetResetIso: null,
        memberBudgetsSkipped: false,
      },
      errors: ["OpenCode Console policies/members error 403"],
    });
    expect(JSON.stringify(result)).not.toContain("usr_me");
  });

  it("keeps the account id out of a failed member request", async () => {
    routes({
      "policies/members/usr_me": () => {
        throw new Error("connect ECONNREFUSED for /api/policies/members/usr_me");
      },
    });

    const result = await queryOpenCodeZenQuota(account);

    expect(result).toMatchObject({
      success: true,
      errors: [
        "OpenCode Console policies/members request failed: connect ECONNREFUSED for /api/policies/members/[redacted]",
      ],
    });
    expect(JSON.stringify(result)).not.toContain("usr_me");
  });

  it("requests and redacts a URL-encoded account id", async () => {
    routes({
      "policies/members/usr_me%2F1": () => {
        throw new Error("connect ECONNREFUSED for /api/policies/members/usr_me%2F1");
      },
    });

    const result = await queryOpenCodeZenQuota({ ...account, accountId: "usr_me/1" });

    expect(result).toMatchObject({
      success: true,
      errors: [
        "OpenCode Console policies/members request failed: connect ECONNREFUSED for /api/policies/members/[redacted]",
      ],
    });
    expect(JSON.stringify(result)).not.toContain("usr_me");
  });

  it.each([
    "billing/account",
    "billing/auto-recharge",
    "policies/members/usr_me",
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
    ["policies/members/usr_me", () => json({})],
    ["policies/members/usr_me", () => json("none")],
    ["policies/members/usr_me", () => json({ userID: "usr_me" })],
    ["policies/members/usr_me", () => json({ userID: "usr_other", budgets: [], policies: [] })],
    ["policies/members/usr_me", () => json({ userID: "usr_me", budgets: ["none"], policies: [] })],
    [
      "policies/members/usr_me",
      () =>
        json({
          userID: "usr_me",
          budgets: [{ scope: "combined", limitDollars: 60, spentDollars: 5 }],
          policies: [],
        }),
    ],
    [
      "policies/members/usr_me",
      () =>
        json(
          memberPayload(
            [memberBudget("pol_1", "r1", { scope: "per-user", limitDollars: 60, spentDollars: 5 })],
            [{ id: "pol_1", rules: [budgetRule("r1")] }],
          ),
        ),
    ],
    [
      "policies/members/usr_me",
      () =>
        json(
          memberPayload(
            [memberBudget("pol_1", "r1", { per: "day", limitDollars: 60, spentDollars: 5 })],
            [{ id: "pol_1", rules: [budgetRule("r1")] }],
          ),
        ),
    ],
    [
      "policies/members/usr_me",
      () =>
        json(
          memberPayload(
            [memberBudget("pol_1", "r1", { limitDollars: "60", spentDollars: 5 })],
            [{ id: "pol_1", rules: [budgetRule("r1")] }],
          ),
        ),
    ],
    [
      "policies/members/usr_me",
      () =>
        json(
          memberPayload(
            [memberBudget("pol_1", "r1", { limitDollars: -1, spentDollars: 5 })],
            [{ id: "pol_1", rules: [budgetRule("r1")] }],
          ),
        ),
    ],
    [
      "policies/members/usr_me",
      () =>
        json(
          memberPayload(
            [memberBudget("pol_1", "r1", { limitDollars: 90_000_001, spentDollars: 5 })],
            [{ id: "pol_1", rules: [budgetRule("r1")] }],
          ),
        ),
    ],
    [
      "policies/members/usr_me",
      () =>
        json({
          userID: "usr_me",
          budgets: [{ policyID: "pol_1", scope: "combined", limitDollars: 60, spentDollars: 5 }],
          policies: [{ id: "pol_1" }],
        }),
    ],
    [
      "policies/members/usr_me",
      () =>
        json({
          userID: "usr_me",
          budgets: [
            {
              policyID: "pol_1",
              ruleID: "r1",
              scope: "combined",
              limitDollars: 60,
              spentDollars: 5,
            },
          ],
          policies: {},
        }),
    ],
    [
      "policies/members/usr_me",
      () =>
        json({
          userID: "usr_me",
          budgets: [
            { policyID: 7, ruleID: "r1", scope: "combined", limitDollars: 60, spentDollars: 5 },
          ],
          policies: [],
        }),
    ],
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

    // Error text names the member route without the account id.
    const label = route === "policies/members/usr_me" ? "policies/members" : route;
    expect(result).toMatchObject({
      success: true,
      data: { balance: 0 },
      errors: [`Could not parse OpenCode Console ${label} response`],
    });
    expect(JSON.stringify(result)).not.toContain("usr_me");
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
