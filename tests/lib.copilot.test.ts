/**
 * The Copilot query, diagnostics and cache identity as one module: the PAT config file in the
 * temp config folder, OpenCode logins in a temp `opencode.db` (or a fake integration for a login
 * OpenCode could not return), and GitHub's replies through fake HTTP.
 */

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vite-plus/test";

import {
  copilotLoginsIdentity,
  getCopilotQuotaAuthDiagnostics,
  queryCopilotQuota,
  readCopilotLogins,
} from "../src/lib/copilot.js";
import {
  bindCredentialSource,
  createIntegrationCredentialSource,
  notifyCredentialsChanged,
} from "../src/lib/opencode-auth.js";
import {
  __resetResolvedAuthIdentityForTests,
  deriveResolvedAuthIdentity,
  loginListIdentity,
} from "../src/lib/resolved-auth-identity.js";
import type { CopilotResult } from "../src/lib/types.js";
import { createFakeIntegration } from "./helpers/fake-integration.js";
import { useProviderWorld } from "./helpers/provider-fetch.js";

const world = useProviderWorld();
const POSIX_IDENTITY_STORAGE = process.platform !== "win32" && typeof process.getuid === "function";

/** Writes `copilot-quota-token.json`, the PAT config Copilot prefers over OAuth. */
function configure(value: Record<string, unknown>): void {
  world.writeConfigFile("copilot-quota-token.json", JSON.stringify(value));
}

/** One stored Copilot OAuth login. */
function signIn(entry: Record<string, unknown> = {}): void {
  world.storeLogins([
    {
      id: "login-1",
      integrationId: "github-copilot",
      active: 1,
      updated: 1,
      value: { type: "oauth", access: "oauth-token", ...entry },
    },
  ]);
}

/** The Copilot query of the first stored login, as the provider asks it. */
async function query(options: { requestTimeoutMs?: number } = {}): Promise<CopilotResult> {
  const [login] = (await readCopilotLogins()).oauth;
  return queryCopilotQuota({
    ...options,
    ...(login ? { login } : {}),
  });
}

async function identity() {
  return copilotLoginsIdentity(await readCopilotLogins());
}

type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function stubFetch(handler: FetchHandler = () => new Response("not found", { status: 404 })) {
  const fetchMock = vi.fn(handler);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Answers `/user`, budgets, and billing usage like GitHub. */
function billingApi(usage: unknown = aiUsage(), budgets: unknown = { budgets: [] }) {
  return stubFetch((url) => {
    const path = new URL(url).pathname;
    if (path === "/user") return json({ login: "alice" });
    return json(path.endsWith("/budgets") ? budgets : usage);
  });
}

function requestedUrls(fetchMock: ReturnType<typeof stubFetch>): URL[] {
  return fetchMock.mock.calls.map(([url]) => new URL(url));
}

async function errorOf(result: Promise<CopilotResult>): Promise<string> {
  const settled = await result;
  return settled && !settled.success ? settled.error : "";
}

function aiUsage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

function copilotUser(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    copilot_plan: "enterprise",
    quota_reset_date_utc: "2026-02-01T00:00:00.000Z",
    token_based_billing: true,
    quota_snapshots: {
      premium_interactions: {
        entitlement: 1000,
        remaining: 400,
        quota_remaining: 399.5,
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

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), init);
}

function stalledResponse(signal: AbortSignal | null | undefined, status = 200): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener("abort", () => {
          controller.error(new Error("private stalled body failure"));
        });
      },
    }),
    { status },
  );
}

const overLimit = {
  entitlement: 3000,
  remaining: -740,
  quota_remaining: -739.5,
  percent_remaining: 0,
  unlimited: false,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z"));
  stubFetch();
});

afterEach(() => {
  vi.useRealTimers();
  __resetResolvedAuthIdentityForTests();
});

describe("Copilot credential sources", () => {
  it("returns null without trusted PAT or OpenCode OAuth auth", async () => {
    const fetchMock = stubFetch();
    await expect(query()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.runIf(POSIX_IDENTITY_STORAGE)(
    "derives OAuth cache identity from the login's token and API host",
    async () => {
      signIn({ access: "copilot-oauth-secret", enterpriseUrl: "example.ghe.com" });
      const [row] = (await readCopilotLogins()).oauth;
      if (!row) throw new Error("expected a stored login");

      const resolved = await identity();

      const login = await deriveResolvedAuthIdentity({
        providerId: "copilot:oauth",
        principal: { kind: "credential", value: "copilot-oauth-secret" },
        qualifiers: ["api=https://api.example.ghe.com"],
      });
      expect(resolved).toBe(await loginListIdentity("copilot", [{ row, identity: login }]));
      expect(resolved).toMatch(/^rai1_/u);
      expect(JSON.stringify(resolved)).not.toContain("copilot-oauth-secret");
    },
  );

  it.runIf(POSIX_IDENTITY_STORAGE)(
    "scopes PAT cache identity to the resolved billing target and UTC period",
    async () => {
      configure({
        token: "copilot-pat-secret",
        tier: "business",
        organization: "example-org",
        username: "alice",
      });

      const resolved = await identity();

      expect(resolved).toMatch(/^rai1_/u);
      expect(resolved).toBe(
        await deriveResolvedAuthIdentity({
          providerId: "copilot:pat",
          principal: { kind: "credential", value: "copilot-pat-secret" },
          qualifiers: [
            "api=https://api.github.com",
            "billingModel=ai_credits",
            "tier=business",
            "scope=organization",
            "username=alice",
            "organization=example-org",
            "enterprise=",
            "period=2026-01",
          ],
        }),
      );
    },
  );

  it("shows a login OpenCode could not read as an error, present but without identity", async () => {
    const integration = createFakeIntegration([
      {
        integrationId: "github-copilot",
        id: "login-1",
        label: "",
        registered: true,
        method: "oauth",
        value: { type: "oauth" },
        resolveError: "HTTP 401",
      },
    ]);
    onTestFinished(bindCredentialSource(createIntegrationCredentialSource(integration as never)));
    notifyCredentialsChanged();
    const fetchMock = stubFetch();

    await expect(query()).resolves.toEqual({
      success: false,
      error:
        "Copilot sign-in could not be read: refresh_failed: HTTP 401. Run `opencode auth login github-copilot`.",
    });
    const logins = await readCopilotLogins();
    expect(getCopilotQuotaAuthDiagnostics(logins).billingApiAccessLikely).toBe(true);
    await expect(identity()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { token: "", tier: "pro" },
    { token: "github_pat_invalid" },
    {
      token: "github_pat_org",
      tier: "business",
      organization: "acme",
      enterpriseUrl: "https://acme.ghe.com/path?token=pat-secret",
    },
  ])(
    "rejects invalid trusted billing config %o without reading or borrowing OAuth",
    async (config) => {
      configure(config);
      signIn({ enterpriseUrl: "oauth.ghe.com" });
      const fetchMock = stubFetch();

      const error = await errorOf(query());

      expect(error).toContain("Invalid copilot-quota-token.json");
      expect(error).not.toContain("pat-secret");
      await expect(identity()).resolves.toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe("Copilot OAuth internal user quota", () => {
  it.each([{ access: "oauth-token" }, { access: undefined, refresh: "oauth-token" }])(
    "reuses OpenCode OAuth %o for GitHub.com personal quota",
    async (credential) => {
      signIn(credential);
      const fetchMock = stubFetch(() => json(copilotUser()));

      await expect(query()).resolves.toEqual({
        success: true,
        mode: "user_quota",
        unit: "premium_interactions",
        used: 600.5,
        authority: "locally_derived",
        total: 1000,
        percentRemaining: 40,
        plan: "enterprise",
        resetTimeIso: "2026-02-01T00:00:00.000Z",
      });
      const [url, init] = fetchMock.mock.calls[0] ?? [];
      expect(url).toBe("https://api.github.com/copilot_internal/user");
      expect(init?.headers).toMatchObject({
        Authorization: "token oauth-token",
        Accept: "application/json",
        "Editor-Version": "vscode/1.96.2",
      });
    },
  );

  it.each<[string, Record<string, unknown>, unknown]>([
    [
      "derives an absent percentage",
      snapshot({ entitlement: 1000, remaining: 250, unlimited: false }),
      expect.objectContaining({ percentRemaining: 25 }),
    ],
    [
      "keeps a reported 0 percentage",
      snapshot({ entitlement: 1000, remaining: 250, percent_remaining: 0, unlimited: false }),
      expect.objectContaining({ percentRemaining: 0 }),
    ],
    [
      "drops an out-of-range reported percentage",
      snapshot({ entitlement: 1000, remaining: 250, percent_remaining: 140, unlimited: false }),
      expect.objectContaining({ percentRemaining: undefined }),
    ],
    [
      "drops a non-numeric reported percentage",
      snapshot({ entitlement: 1000, remaining: 250, percent_remaining: "25", unlimited: false }),
      expect.objectContaining({ percentRemaining: undefined }),
    ],
    [
      "keeps unlimited premium interactions provider-reported",
      snapshot({ unlimited: true }),
      expect.objectContaining({
        success: true,
        mode: "user_quota",
        unit: "premium_interactions",
        authority: "provider_reported",
        unlimited: true,
      }),
    ],
    [
      "does not derive a percentage from zero entitlement",
      snapshot({ entitlement: 0, remaining: 0, unlimited: false }),
      expect.objectContaining({ success: true, mode: "user_plan" }),
    ],
    [
      "keeps token-based placeholders plan-only",
      {
        copilot_plan: "business",
        ...snapshot({ entitlement: 0, remaining: 0, percent_remaining: 0, unlimited: false }),
      },
      {
        success: true,
        mode: "user_plan",
        authority: "provider_reported",
        plan: "business",
        resetTimeIso: "2026-02-01T00:00:00.000Z",
      },
    ],
    [
      // A Copilot Business token-billing response after the included pool is exhausted.
      "renders token-based over-limit AI credits with the reported percentage",
      { copilot_plan: "business", ...snapshot({ ...overLimit, credits_used: 3739 }) },
      {
        success: true,
        mode: "user_quota",
        unit: "ai_credits",
        used: 3739,
        authority: "provider_reported",
        total: 3000,
        percentRemaining: 0,
        plan: "business",
        resetTimeIso: "2026-02-01T00:00:00.000Z",
      },
    ],
    ...[undefined, -1, "3739"].map((creditsUsed): [string, Record<string, unknown>, unknown] => [
      `derives over-limit premium interactions when credits_used is ${String(creditsUsed)}`,
      { copilot_plan: "business", ...snapshot({ ...overLimit, credits_used: creditsUsed }) },
      expect.objectContaining({
        success: true,
        mode: "user_quota",
        unit: "premium_interactions",
        used: 3739.5,
        authority: "locally_derived",
        total: 3000,
        percentRemaining: 0,
      }),
    ]),
    [
      "rejects a negative remaining without token billing",
      { token_based_billing: false, ...snapshot(overLimit) },
      {
        success: false,
        error: expect.stringContaining("did not include a usable quota snapshot"),
      },
    ],
    [
      "keeps a negative remaining with an out-of-range percentage plan-only",
      snapshot({ ...overLimit, percent_remaining: 140 }),
      expect.objectContaining({ success: true, mode: "user_plan" }),
    ],
    [
      "keeps a negative remaining without a percentage plan-only",
      snapshot({ ...overLimit, percent_remaining: undefined }),
      expect.objectContaining({ success: true, mode: "user_plan" }),
    ],
  ])("%s", async (_name, overrides, expected) => {
    signIn();
    stubFetch(() => json(copilotUser(overrides)));
    await expect(query()).resolves.toEqual(expected);
  });

  it.each(["acme.ghe.com", "https://acme.ghe.com"])(
    "routes OpenCode OAuth through a validated GHE.com host: %s",
    async (enterpriseUrl) => {
      signIn({ enterpriseUrl });
      const fetchMock = stubFetch(() => json(copilotUser()));

      await expect(query()).resolves.toMatchObject({ success: true });
      expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.acme.ghe.com/copilot_internal/user");
    },
  );

  it.each([
    "http://acme.ghe.com",
    "https://user@acme.ghe.com",
    "https://acme.ghe.com/path",
    "https://acme.ghe.com?token=oauth-secret",
    "https://acme.ghe.com#fragment",
    "https://acme.ghe.com:443",
    "127.0.0.1",
    "localhost",
    "*.ghe.com",
    "api.acme.ghe.com",
    "github.com",
    "acme.ghe.com.evil.example",
    "not a host",
  ])("rejects unsafe explicit OAuth enterprise host %s before requests", async (enterpriseUrl) => {
    signIn({ access: "oauth-secret", enterpriseUrl });
    const fetchMock = stubFetch();

    const error = await errorOf(query());

    expect(error).toContain("Invalid OpenCode Copilot enterpriseUrl");
    expect(error).not.toContain("oauth-secret");
    expect(error).not.toContain(enterpriseUrl);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Copilot PAT billing reports", () => {
  it.each([
    ["max", "github_pat_personal"],
    ["pro", "ghu_user_token"],
  ])(
    "uses the personal AI Credit endpoint and 2026-03-10 headers for %s %s over OpenCode OAuth",
    async (tier, token) => {
      configure({ token, tier, username: "alice" });
      signIn({ enterpriseUrl: "oauth.ghe.com" });
      const fetchMock = billingApi();

      await expect(query()).resolves.toEqual({
        success: true,
        mode: "user_quota",
        unit: "ai_credits",
        period: { year: 2026, month: 1 },
        used: 100,
        includedUsed: 80,
        billedUsed: 20,
        billedAmountUsd: 0.2,
        authority: "provider_reported",
      });
      const [target] = requestedUrls(fetchMock);
      expect(target?.hostname).toBe("api.github.com");
      expect(target?.pathname).toBe("/users/alice/settings/billing/ai_credit/usage");
      expect(target?.searchParams.get("year")).toBe("2026");
      expect(target?.searchParams.get("month")).toBe("1");
      expect(target?.searchParams.get("product")).toBeNull();
      expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2026-03-10",
      });
    },
  );

  it("resolves the personal username through the PAT's own GHE.com host", async () => {
    configure({ token: "ghp_classic", tier: "pro", enterpriseUrl: "personal.ghe.com" });
    const fetchMock = billingApi();

    const result = await query();

    expect(result).toMatchObject({
      success: true,
      mode: "user_quota",
      period: { year: 2026, month: 1 },
      authority: "provider_reported",
    });
    expect(result).not.toHaveProperty("total");
    expect(result).not.toHaveProperty("percentRemaining");
    expect(result).not.toHaveProperty("resetTimeIso");
    expect(requestedUrls(fetchMock).map((url) => url.href.split("?")[0])).toEqual([
      "https://api.personal.ghe.com/user",
      "https://api.personal.ghe.com/users/alice/settings/billing/ai_credit/usage",
    ]);
  });

  it.each([
    [
      { token: "ghs_installation_token", tier: "pro", username: "alice" },
      "not GitHub App installation access tokens",
    ],
    [
      { token: "github_pat_business", tier: "business" },
      'Copilot Business AI Credit usage requires "organization"',
    ],
    ...["github_pat_enterprise", "ghu_enterprise", "ghs_enterprise"].map((token) => [
      { token, tier: "enterprise", enterprise: "octo" },
      "do not support fine-grained PATs or GitHub App access tokens",
    ]),
    [
      {
        token: "github_pat_legacy",
        tier: "max",
        billingModel: "legacy_premium_requests",
        username: "alice",
      },
      "only available to Copilot Pro or Pro+",
    ],
  ] as Array<[Record<string, unknown>, string]>)(
    "rejects %o before any request",
    async (config, expected) => {
      configure(config);
      const fetchMock = stubFetch();

      expect(await errorOf(query())).toContain(expected);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each(["github_pat_org", "ghs_installation"])(
    "uses organization AI Credit and budget endpoints for %s",
    async (token) => {
      configure({ token, tier: "business", organization: "acme", username: "alice" });
      const fetchMock = billingApi(
        { ...aiUsage(), organization: "acme" },
        aiCreditBudget("user", 1, { budget_entity_name: "alice" }),
      );

      await expect(query()).resolves.toEqual({
        success: true,
        mode: "organization_usage",
        organization: "acme",
        username: "alice",
        period: { year: 2026, month: 1 },
        unit: "ai_credits",
        used: 100,
        authority: "provider_reported",
        includedUsed: 80,
        billedUsed: 20,
        billedAmountUsd: 0.2,
        budget: {
          amountUsd: 1,
          spentUsd: 0.2,
          scope: "user",
          percentRemaining: 80,
          authority: "locally_derived",
        },
        warnings: undefined,
      });
      const [usageUrl, budgetUrl] = requestedUrls(fetchMock);
      expect(usageUrl?.pathname).toBe("/organizations/acme/settings/billing/ai_credit/usage");
      expect(usageUrl?.searchParams.get("user")).toBe("alice");
      expect(budgetUrl?.pathname).toBe("/organizations/acme/settings/billing/budgets");
      expect(budgetUrl?.searchParams.get("user")).toBe("alice");
      expect(budgetUrl?.searchParams.get("per_page")).toBe("100");
    },
  );

  it.each([
    [
      { token: "github_pat_org", tier: "business", organization: "acme" },
      { mode: "organization_usage", organization: "acme" },
    ],
    [
      { token: "ghp_classic", tier: "enterprise", enterprise: "octo" },
      { mode: "enterprise_usage", enterprise: "octo" },
    ],
  ])(
    "treats empty managed AI Credit usage %o as zero instead of an error",
    async (config, scope) => {
      configure(config);
      billingApi({ timePeriod: { year: 2026, month: 1 }, ...scope, usageItems: [] });

      await expect(query()).resolves.toMatchObject({
        success: true,
        ...scope,
        unit: "ai_credits",
        used: 0,
        includedUsed: 0,
        billedUsed: 0,
      });
    },
  );

  it("keeps a zero-dollar budget value-only instead of inventing a percentage", async () => {
    configure({ token: "github_pat_org", tier: "business", organization: "acme" });
    billingApi(aiUsage(), aiCreditBudget("organization", 0));

    await expect(query()).resolves.toMatchObject({
      budget: {
        amountUsd: 0,
        spentUsd: 0.2,
        scope: "organization",
        percentRemaining: undefined,
        authority: "provider_reported",
      },
    });
  });

  it("uses the enterprise AI Credit path with optional organization and user filters for classic PATs", async () => {
    configure({
      token: "ghp_classic",
      tier: "enterprise",
      enterprise: "octo",
      organization: "acme",
      username: "alice",
      enterpriseUrl: "enterprise.ghe.com",
    });
    const fetchMock = billingApi(aiUsage(), aiCreditBudget("enterprise", 5));

    await expect(query()).resolves.toMatchObject({
      success: true,
      mode: "enterprise_usage",
      enterprise: "octo",
      organization: "acme",
      username: "alice",
      budget: { amountUsd: 5, spentUsd: 0.2, percentRemaining: 96 },
    });
    const [usageUrl, budgetUrl] = requestedUrls(fetchMock);
    expect(usageUrl?.hostname).toBe("api.enterprise.ghe.com");
    expect(usageUrl?.pathname).toBe("/enterprises/octo/settings/billing/ai_credit/usage");
    expect(usageUrl?.searchParams.get("organization")).toBe("acme");
    expect(usageUrl?.searchParams.get("user")).toBe("alice");
    expect(budgetUrl?.hostname).toBe("api.enterprise.ghe.com");
  });

  it("allows legacy PRUs for explicitly selected Pro/Pro+ annual-plan eligibility", async () => {
    configure({
      token: "github_pat_legacy",
      tier: "pro+",
      billingModel: "legacy_premium_requests",
      username: "alice",
    });
    const fetchMock = billingApi({
      usageItems: [
        {
          product: "Copilot",
          sku: "Copilot Premium Request",
          unitType: "requests",
          grossQuantity: 150,
        },
      ],
    });

    await expect(query()).resolves.toEqual({
      success: true,
      mode: "user_quota",
      unit: "premium_requests",
      used: 150,
      authority: "locally_derived",
      total: 1500,
      percentRemaining: 90,
      plan: "pro+",
      resetTimeIso: "2026-02-01T00:00:00.000Z",
    });
    expect(requestedUrls(fetchMock)[0]?.pathname).toBe(
      "/users/alice/settings/billing/premium_request/usage",
    );
  });

  it("accepts documented managed fields, aggregates valid rows, and ignores other products", async () => {
    configure({ token: "github_pat_personal", tier: "pro", username: "alice" });
    billingApi({
      time_period: { year: 2026, month: 1 },
      usage_items: [
        {
          product: "Copilot",
          sku: "Copilot AI Credits",
          unit_type: "credits",
          gross_quantity: 100,
          discount_quantity: 80,
          net_quantity: 20,
          net_amount: 0.2,
        },
        {
          product: "Copilot AI Credits",
          sku: "AI Credit",
          unitType: "ai-credits",
          grossQuantity: 50,
          discountQuantity: 50,
          netQuantity: 0,
          netAmount: 0,
        },
        {
          product: "Actions",
          sku: "AI Credit",
          unitType: "ai-credits",
          grossQuantity: 999,
          discountQuantity: 0,
          netQuantity: 999,
        },
      ],
    });

    await expect(query()).resolves.toMatchObject({
      success: true,
      mode: "user_quota",
      period: { year: 2026, month: 1 },
      used: 150,
      includedUsed: 130,
      billedUsed: 20,
      billedAmountUsd: 0.2,
      authority: "provider_reported",
    });
  });

  it.each([
    [
      { discountQuantity: undefined, netQuantity: undefined },
      { used: 100, includedUsed: 0, billedUsed: 100 },
    ],
    [
      { grossQuantity: 100, discountQuantity: 80, netQuantity: undefined },
      { used: 100, includedUsed: 80, billedUsed: 20 },
    ],
    [
      { grossQuantity: 100, discountQuantity: undefined, netQuantity: 20 },
      { used: 100, includedUsed: 80, billedUsed: 20 },
    ],
    [
      { grossQuantity: undefined, discountQuantity: 80, netQuantity: 20 },
      { used: 100, includedUsed: 80, billedUsed: 20 },
    ],
  ])("derives missing AI Credit quantities %o as locally derived", async (overrides, expected) => {
    configure({ token: "github_pat_personal", tier: "pro", username: "alice" });
    billingApi(aiUsage(overrides));

    await expect(query()).resolves.toMatchObject({
      success: true,
      mode: "user_quota",
      ...expected,
      authority: "locally_derived",
    });
  });

  it.each([
    [{ usageItems: {} }, "usageItems array"],
    [
      { usageItems: [{ product: "Actions", sku: "AI Credit", grossQuantity: 1 }] },
      "did not contain a Copilot AI Credit usage item",
    ],
    [
      aiUsage({ grossQuantity: 100, discountQuantity: 120, netQuantity: undefined }),
      "inconsistent quantities",
    ],
    [
      aiUsage({ grossQuantity: 100, discountQuantity: undefined, netQuantity: 120 }),
      "inconsistent quantities",
    ],
    [
      aiUsage({ grossQuantity: 100, discountQuantity: 80, netQuantity: 30 }),
      "inconsistent quantities",
    ],
    [aiUsage({ grossQuantity: -1, discountQuantity: 0, netQuantity: 0 }), "negative quantity"],
    [aiUsage({ netAmount: -0.2 }), "negative net amount"],
  ])("rejects malformed usage %j", async (usage, expected) => {
    configure({ token: "github_pat_personal", tier: "pro", username: "alice" });
    billingApi(usage);

    expect(await errorOf(query())).toContain(expected);
  });
});

describe("Copilot HTTP failures", () => {
  it.each([
    [
      json({ message: "Bad credentials" }, { status: 401 }),
      "GitHub API error 401: Bad credentials",
    ],
    [
      json(
        { message: "API rate limit exceeded" },
        { status: 403, headers: { "x-ratelimit-remaining": "0" } },
      ),
      "GitHub API rate limit exhausted",
    ],
    [
      json({ message: "Resource not accessible" }, { status: 403 }),
      "GitHub API error 403: Resource not accessible",
    ],
    [new Response("{", { status: 200 }), "malformed JSON"],
  ])(
    "surfaces auth, permission, rate-limit, and malformed-response failures: %#",
    async (response, expected) => {
      configure({ token: "github_pat_personal", tier: "pro", username: "alice" });
      stubFetch(() => response);

      expect(await errorOf(query())).toContain(expected);
    },
  );

  it.each([
    ["an OAuth internal-user body", "oauth-timeout-canary", 200, "Request timeout after 1s"],
    ["a PAT billing body", "github_pat_timeout_canary", 200, "Request timeout after 1s"],
    // A stalled error body still has its status.
    ["a PAT error body", "github_pat_timeout_canary", 503, "GitHub API error 503"],
  ])("times out %s without exposing its token", async (_name, token, status, expected) => {
    if (token.startsWith("github_pat_")) configure({ token, tier: "pro", username: "alice" });
    else signIn({ access: token });
    stubFetch((_url, init) => stalledResponse(init?.signal, status));

    const pending = errorOf(query({ requestTimeoutMs: 1_000 }));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await pending).toBe(expected);
  });

  it.each([
    ["PAT echoed by a GitHub REST error", "github_pat_error_canary"],
    ["OAuth token echoed by the Copilot internal API", "oauth-error-canary"],
  ])("redacts a %s", async (_name, token) => {
    if (token.startsWith("github_pat_")) configure({ token, tier: "pro", username: "alice" });
    else signIn({ access: token });
    stubFetch(() => json({ message: `Rejected Authorization: Bearer ${token}` }, { status: 401 }));

    const error = await errorOf(query());

    expect(error).toContain("[redacted]");
    expect(error).not.toContain(token);
  });

  it.each([
    [
      "times out",
      (init?: RequestInit) => stalledResponse(init?.signal),
      "Request timeout after 1s",
    ],
    [
      "is forbidden",
      () => json({ message: "Resource not accessible by personal access token" }, { status: 403 }),
      "Resource not accessible by personal access token",
    ],
  ])(
    "keeps successful AI Credit usage and warns when the optional budget report %s",
    async (_name, budgetResponse, reason) => {
      const patToken = "github_pat_budget_canary";
      configure({ token: patToken, tier: "business", organization: "acme" });
      stubFetch((url, init) =>
        new URL(url).pathname.endsWith("/budgets") ? budgetResponse(init) : json(aiUsage()),
      );

      const pending = query({ requestTimeoutMs: 1_000 });
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await pending;

      expect(result).toMatchObject({
        success: true,
        mode: "organization_usage",
        used: 100,
        budget: undefined,
        warnings: [expect.stringContaining("usage loaded, but the budget report failed")],
      });
      expect(JSON.stringify(result)).toContain(reason);
      expect(JSON.stringify(result)).not.toContain(patToken);
    },
  );
});

describe("Copilot quota diagnostics", () => {
  it.each([
    {
      name: "keeps invalid trusted billing config blocking when OAuth exists",
      pat: { token: "github_pat_invalid" },
      oauth: { access: "oauth-token" },
      expected: {
        pat: { state: "invalid" },
        oauth: { configured: true, hasAccessToken: true },
        effectiveSource: "pat",
        override: "pat_overrides_oauth",
        quotaApi: "none",
        billingMode: "none",
        billingScope: "none",
        billingApiAccessLikely: false,
        deployment: "none",
        apiHost: null,
        enterpriseHostSource: "none",
        remainingTotalsState: "unavailable",
        oauthAccountingState: "available_via_copilot_internal_user",
        queryPeriod: undefined,
      },
    },
    {
      name: "reports current scope, API, denominator, budget, and OAuth state",
      pat: { token: "github_pat_org", tier: "business", organization: "acme", username: "alice" },
      oauth: { access: "oauth-token" },
      expected: {
        effectiveSource: "pat",
        override: "pat_overrides_oauth",
        deployment: "github.com",
        apiHost: "api.github.com",
        enterpriseHostSource: "none",
        quotaApi: "github_ai_credit_api",
        billingModel: "ai_credits",
        billingMode: "organization_usage",
        billingScope: "organization",
        billingApiAccessLikely: true,
        remainingTotalsState: "not_available_from_org_usage",
        budgetApi: "organization_budgets",
        oauthAccountingState: "available_via_copilot_internal_user",
        queryPeriod: { year: 2026, month: 1 },
      },
    },
    {
      name: "reports an incompatible enterprise token without claiming billing access",
      pat: { token: "github_pat_enterprise", tier: "enterprise", enterprise: "octo" },
      oauth: null,
      expected: {
        billingMode: "enterprise_usage",
        billingApiAccessLikely: false,
        remainingTotalsState: "not_available_from_enterprise_usage",
        budgetApi: "enterprise_budgets",
        oauthAccountingState: "not_configured",
      },
    },
    {
      name: "reports the legacy premium-request denominator",
      pat: { token: "ghp_legacy", tier: "pro", billingModel: "legacy_premium_requests" },
      oauth: null,
      expected: {
        quotaApi: "github_legacy_premium_request_api",
        billingMode: "user_quota",
        remainingTotalsState: "available",
        budgetApi: "not_available",
      },
    },
    {
      name: "reports bounded OAuth GHE.com deployment without URLs or tokens",
      pat: null,
      oauth: { access: "oauth-secret", enterpriseUrl: "https://acme.ghe.com" },
      expected: {
        effectiveSource: "oauth",
        deployment: "ghe.com",
        apiHost: "api.acme.ghe.com",
        enterpriseHostSource: "oauth",
        quotaApi: "copilot_internal_user",
        billingMode: "user_quota",
        billingScope: "user",
        billingApiAccessLikely: true,
        remainingTotalsState: "reported_by_copilot_internal_user",
        oauthAccountingState: "available_via_copilot_internal_user",
      },
    },
    {
      name: "reports an invalid OAuth host safely without exposing its URL or query",
      pat: null,
      oauth: {
        access: "oauth-secret",
        enterpriseUrl: "https://acme.ghe.com/path?token=oauth-secret",
      },
      expected: {
        effectiveSource: "oauth",
        deployment: "invalid",
        apiHost: null,
        enterpriseHostSource: "none",
        billingApiAccessLikely: false,
        oauthAccountingState: "invalid_enterprise_host",
      },
    },
  ])("$name", async ({ pat, oauth, expected }) => {
    if (pat) configure(pat);
    if (oauth) signIn(oauth);
    const diagnostics = getCopilotQuotaAuthDiagnostics(await readCopilotLogins());

    expect(diagnostics).toMatchObject(expected);
    const serialized = JSON.stringify(diagnostics);
    for (const hidden of ["oauth-secret", "https://", "?token="]) {
      expect(serialized).not.toContain(hidden);
    }
  });
});
