/**
 * Copilot as one module: the PAT config file in the temp config folder, OpenCode logins in a temp
 * `opencode.db` (or a fake integration for a login OpenCode could not return), and GitHub's
 * replies through fake HTTP.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { describeError } from "../src/core/errors.js";
import type { Amount, QuotaRow } from "../src/core/types.js";
import {
  bindCredentialSource,
  createIntegrationCredentialSource,
  notifyCredentialsChanged,
} from "../src/lib/opencode-auth.js";
import { copilotProvider } from "../src/providers/copilot.js";
import type { CredentialDatabaseRow } from "./helpers/credential-database.js";
import { createFakeIntegration } from "./helpers/fake-integration.js";
import { fakeHttp, fetchRows, useProviderWorld } from "./helpers/provider-fetch.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";

const world = useProviderWorld();

const RESET = "2026-02-01T00:00:00.000Z";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-15T00:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

/** Writes `copilot-quota-token.json`, the PAT config Copilot prefers over OAuth. */
function patConfig(config: Record<string, unknown>): void {
  world.writeConfigFile("copilot-quota-token.json", JSON.stringify(config));
}

/** One OpenCode Copilot OAuth login with this token. */
function oauthLogin(token = "oauth-token") {
  return {
    id: "copilot",
    integrationId: "github-copilot",
    active: 1,
    updated: 1,
    value: { type: "oauth", access: token, refresh: token },
  } satisfies CredentialDatabaseRow;
}

/** One AI Credit usage item of GitHub's billing report. */
function aiUsage(overrides: Record<string, unknown> = {}) {
  return {
    timePeriod: { year: 2026, month: 1 },
    usageItems: [
      {
        product: "Copilot AI Credits",
        sku: "AI Credit",
        unitType: "ai-credits",
        grossQuantity: 100,
        discountQuantity: 80,
        netQuantity: 20,
        netAmount: 0.2,
        ...overrides,
      },
    ],
  };
}

function aiCreditBudget(scope: string, amount: number, extra: Record<string, unknown> = {}) {
  return {
    budgets: [
      {
        budget_type: "BundlePricing",
        budget_product_skus: ["ai_credits"],
        budget_scope: scope,
        budget_amount: amount,
        ...extra,
      },
    ],
    has_next_page: false,
  };
}

/** Copilot's internal user reply for an OAuth login: plan, reset and premium interactions. */
function copilotUser(overrides: Record<string, unknown> = {}) {
  return {
    copilot_plan: "enterprise",
    quota_reset_date_utc: RESET,
    token_based_billing: true,
    quota_snapshots: {
      premium_interactions: {
        entitlement: 1000,
        remaining: 400,
        quota_remaining: 399.495,
        percent_remaining: 40,
        unlimited: false,
      },
    },
    ...overrides,
  };
}

function snapshot(premiumInteractions: Record<string, unknown>) {
  return { quota_snapshots: { premium_interactions: premiumInteractions } };
}

/** Answers `/user`, budgets and the billing usage report like GitHub. */
function billingApi(usage: unknown = aiUsage(), budgets: unknown = { budgets: [] }) {
  return fakeHttp((url) => {
    const path = new URL(url).pathname;
    if (path === "/user") return { login: "alice" };
    return path.endsWith("/budgets") ? budgets : usage;
  });
}

function forbidden(): Response {
  return new Response(JSON.stringify({ message: "Forbidden" }), { status: 403 });
}

function amount(value: Amount | undefined): string | null {
  if (!value) return null;
  return `${value.decimal} ${value.unit.kind === "currency" ? value.unit.code : value.unit.kind === "count" ? value.unit.unit : value.unit.symbol}`;
}

/** id, account, label, type, authority, value, used, limit, reset. */
function summary(rows: QuotaRow[]) {
  return rows.map((row) => [
    row.id,
    row.account ?? null,
    row.label,
    row.type,
    row.authority,
    row.percentRemaining ?? row.text,
    amount(row.used),
    amount(row.limit),
    row.resetsAt ?? null,
  ]);
}

describe("copilot provider", () => {
  it("is not set up without a PAT config or an OpenCode login, and asks nothing", async () => {
    const http = fakeHttp(() => ({}));

    const fetched = await fetchRows(copilotProvider);

    expect(fetched).toMatchObject({ rows: [], error: { code: "not_configured" } });
    expect(http).not.toHaveBeenCalled();
  });

  it("reports a failed billing request as the error", async () => {
    patConfig({ token: "github_pat_personal", tier: "pro", username: "alice" });
    fakeHttp((url) => (new URL(url).pathname === "/user" ? { login: "alice" } : forbidden()));

    const fetched = await fetchRows(copilotProvider);

    expect(fetched).toMatchObject({ rows: [], error: { code: "provider_error", status: 403 } });
    expect(fetched.debug).toContainEqual({
      key: "error",
      value: "Copilot: GitHub API error 403: Forbidden",
    });
  });

  it.each([
    ["an empty body", "", "Copilot: GitHub API error 503"],
    [
      "a plain-text body",
      "Service Unavailable",
      "Copilot: GitHub API error 503: Service Unavailable",
    ],
  ])("names a 503 with %s by its status alone or with its words", async (_name, body, text) => {
    patConfig({ token: "github_pat_personal", tier: "pro", username: "alice" });
    fakeHttp((url) =>
      new URL(url).pathname === "/user" ? { login: "alice" } : new Response(body, { status: 503 }),
    );

    const fetched = await fetchRows(copilotProvider);

    if (!fetched.error) throw new Error("expected an error");
    expect(fetched.debug).toContainEqual({ key: "error", value: text });
    expect(describeError(fetched.error, "Copilot", Date.now())).toBe("Provider error 503");
  });

  it.each([
    {
      name: "personal AI Credit usage without a limit as text",
      pat: { token: "github_pat_personal", tier: "pro", username: "alice" },
      replies: () => billingApi(),
      rows: [
        [
          "copilot.allowance",
          "personal",
          "Credits",
          "usage",
          "provider_reported",
          "Used 100 | Included 80 | Billed 20 ($0.20)",
          null,
          null,
          null,
        ],
      ],
    },
    {
      name: "premium interactions with used and limit, rounded as shown",
      replies: () => fakeHttp(() => copilotUser()),
      rows: [
        [
          "copilot.allowance",
          "enterprise",
          "Premium interactions",
          "quota",
          "locally_derived",
          40,
          "600.51 interaction",
          "1000 interaction",
          RESET,
        ],
      ],
    },
    {
      name: "over-limit AI credits with a clamped percentage",
      replies: () =>
        fakeHttp(() =>
          copilotUser({
            copilot_plan: "business",
            ...snapshot({
              entitlement: 3000,
              remaining: -740,
              quota_remaining: -739.5,
              percent_remaining: 0,
              unlimited: false,
              credits_used: 3739,
            }),
          }),
        ),
      rows: [
        [
          "copilot.allowance",
          "business",
          "Credits",
          "quota",
          "provider_reported",
          0,
          "3739 credit",
          "3000 credit",
          RESET,
        ],
      ],
    },
    {
      name: "legacy premium requests",
      pat: {
        token: "github_pat_legacy",
        tier: "pro+",
        billingModel: "legacy_premium_requests",
        username: "alice",
      },
      replies: () =>
        billingApi({
          usageItems: [
            {
              product: "Copilot",
              sku: "Copilot Premium Request",
              unitType: "requests",
              grossQuantity: 150,
            },
          ],
        }),
      rows: [
        [
          "copilot.allowance",
          "pro+",
          "Premium requests",
          "quota",
          "locally_derived",
          90,
          "150 request",
          "1500 request",
          RESET,
        ],
      ],
    },
    {
      name: "unlimited premium interactions as text",
      replies: () =>
        fakeHttp(() => copilotUser({ copilot_plan: "pro", ...snapshot({ unlimited: true }) })),
      rows: [
        [
          "copilot.allowance",
          "pro",
          "Premium interactions",
          "quota",
          "provider_reported",
          "Unlimited",
          null,
          null,
          RESET,
        ],
      ],
    },
    {
      name: "the plan alone when usage needs a billing token",
      replies: () =>
        fakeHttp(() =>
          copilotUser({
            copilot_plan: "business",
            ...snapshot({ entitlement: 0, remaining: 0, percent_remaining: 0, unlimited: false }),
          }),
        ),
      rows: [
        [
          "copilot.allowance",
          "business",
          "Plan",
          "quota",
          "provider_reported",
          "business | usage needs billing token",
          null,
          null,
          RESET,
        ],
      ],
    },
    {
      name: "pooled organization credits plus an additional-usage budget",
      pat: { token: "github_pat_org", tier: "business", organization: "acme", username: "alice" },
      replies: () =>
        billingApi(
          { ...aiUsage(), organization: "acme" },
          aiCreditBudget("user", 1, { budget_entity_name: "alice" }),
        ),
      rows: [
        [
          "copilot.allowance",
          "business",
          "Credits",
          "usage",
          "provider_reported",
          "Used 100 | Included 80 | Billed 20 ($0.20) | 2026-01 | org=acme | user=alice",
          null,
          null,
          null,
        ],
        [
          "copilot.additional_budget",
          "business",
          "Budget",
          "budget",
          "locally_derived",
          80,
          "0.2 USD",
          "1 USD",
          null,
        ],
      ],
    },
    {
      name: "a zero budget as text",
      pat: { token: "ghp_classic", tier: "enterprise", enterprise: "octo" },
      replies: () =>
        billingApi(
          aiUsage({ grossQuantity: 10, discountQuantity: 0, netQuantity: 10, netAmount: 0.1 }),
          aiCreditBudget("enterprise", 0),
        ),
      rows: [
        [
          "copilot.allowance",
          "business",
          "Credits",
          "usage",
          "provider_reported",
          "Used 10 | Included 0 | Billed 10 ($0.10) | 2026-01 | enterprise=octo",
          null,
          null,
          null,
        ],
        [
          "copilot.additional_budget",
          "business",
          "Budget",
          "budget",
          "provider_reported",
          "$0.10 spent | $0.00 budget | scope=enterprise",
          null,
          null,
          null,
        ],
      ],
    },
  ])("shows $name", async ({ pat, replies, rows }) => {
    if (pat) patConfig(pat);
    else world.storeLogins([oauthLogin()]);
    replies();

    const fetched = await fetchRows(copilotProvider);

    expect(fetched.error).toBeUndefined();
    expect(summary(fetched.rows)).toEqual(rows);
  });

  it("keeps a failed budget read next to the usage it has", async () => {
    patConfig({ token: "github_pat_org", tier: "business", organization: "acme" });
    fakeHttp((url) => (new URL(url).pathname.endsWith("/budgets") ? forbidden() : aiUsage()));

    const fetched = await fetchRows(copilotProvider);

    expect(fetched.rows.map((row) => [row.id, row.account])).toEqual([
      ["copilot.allowance", "business"],
    ]);
    expect(fetched.error).toMatchObject({ code: "provider_error", status: 403 });
    expect(fetched.debug).toContainEqual({
      key: "error",
      value:
        "Copilot: AI Credit usage loaded, but the budget report failed: GitHub API error 403: Forbidden",
    });
  });

  it("queries each OpenCode login and shows one it could not read as an error", async () => {
    const integration = createFakeIntegration([
      {
        integrationId: "github-copilot",
        id: "copilot-alice",
        label: "alice",
        registered: true,
        method: "oauth",
        value: { type: "oauth", access: "alice-token" },
        resolveError: "Token refresh failed: HTTP 401",
      },
      {
        integrationId: "github-copilot",
        id: "copilot-bob",
        label: "bob",
        registered: true,
        method: "oauth",
        value: { type: "oauth", access: "bob-token", metadata: { enterpriseUrl: "acme.ghe.com" } },
      },
    ]);
    const unbind = bindCredentialSource(createIntegrationCredentialSource(integration as never));
    notifyCredentialsChanged();
    const http = fakeHttp(() => copilotUser());

    const fetched = await fetchRows(copilotProvider);
    unbind();

    expect(
      http.mock.calls.map(([url, init]) => [url, new Headers(init.headers).get("Authorization")]),
    ).toEqual([["https://api.acme.ghe.com/copilot_internal/user", "token bob-token"]]);
    expect(fetched.rows.map((row) => [row.id, row.account])).toEqual([
      ["copilot.allowance", "bob (enterprise)"],
    ]);
    expect(fetched.rowLogins).toEqual(["copilot-bob"]);
    expect(fetched.debug).toEqual(
      expect.arrayContaining([
        { key: "billing_scope", value: "user" },
        {
          key: "error",
          value:
            "[Copilot alice] (active): Copilot sign-in could not be read: refresh_failed: Token refresh failed: HTTP 401. Run `opencode auth login github-copilot`.",
        },
      ]),
    );
  });

  it("uses runtime provider ids or trusted local billing auth for availability", async () => {
    await expect(
      copilotProvider.isAvailable(
        createProviderAvailabilityContext({ providerIds: ["github-copilot"] }),
      ),
    ).resolves.toBe(true);

    const openAiOnly = createProviderAvailabilityContext({ providerIds: ["openai"] });
    await expect(copilotProvider.isAvailable(openAiOnly)).resolves.toBe(false);
    patConfig({ token: "github_pat_personal", tier: "pro", username: "alice" });
    await expect(copilotProvider.isAvailable(openAiOnly)).resolves.toBe(true);
  });

  it("does not claim availability when provider lookup throws", async () => {
    await expect(
      copilotProvider.isAvailable(
        createProviderAvailabilityContext({ providersError: new Error("boom") }),
      ),
    ).resolves.toBe(false);
  });
});
