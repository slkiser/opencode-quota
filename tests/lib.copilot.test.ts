import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(),
}));

const authMocks = vi.hoisted(() => ({
  readAuthFile: vi.fn(),
}));

vi.mock("fs", async (importOriginal) => {
  const mod = await importOriginal<typeof import("fs")>();
  return {
    ...mod,
    existsSync: fsMocks.existsSync,
    readFileSync: fsMocks.readFileSync,
  };
});

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirCandidates: () => ({
    dataDirs: ["/home/test/.local/share/opencode"],
    configDirs: ["/home/test/.config/opencode"],
    cacheDirs: ["/home/test/.cache/opencode"],
    stateDirs: ["/home/test/.local/state/opencode"],
  }),
}));

vi.mock("../src/lib/opencode-auth.js", () => ({
  readAuthFile: authMocks.readAuthFile,
}));

const patPath = "/home/test/.config/opencode/copilot-quota-token.json";

function configure(value: Record<string, unknown>): void {
  fsMocks.existsSync.mockImplementation((path) => path === patPath);
  fsMocks.readFileSync.mockReturnValue(JSON.stringify(value));
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

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("GitHub Copilot AI Credit accounting", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z"));
    fsMocks.existsSync.mockReset();
    fsMocks.existsSync.mockReturnValue(false);
    fsMocks.readFileSync.mockReset();
    authMocks.readAuthFile.mockReset();
    authMocks.readAuthFile.mockResolvedValue({});
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })) as any);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("returns null without trusted PAT or OpenCode OAuth auth", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as any);
    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    await expect(queryCopilotQuota()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reuses OpenCode OAuth for GitHub.com personal quota", async () => {
    authMocks.readAuthFile.mockResolvedValue({
      "github-copilot": { type: "oauth", access: "oauth-token" },
    });
    const fetchMock = vi.fn(async () => json(copilotUser()));
    vi.stubGlobal("fetch", fetchMock as any);

    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    await expect(queryCopilotQuota()).resolves.toEqual({
      success: true,
      mode: "user_quota",
      unit: "ai_credits",
      used: 600.5,
      total: 1000,
      percentRemaining: 40,
      plan: "enterprise",
      resetTimeIso: "2026-02-01T00:00:00.000Z",
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/copilot_internal/user");
    expect(init.headers).toMatchObject({
      Authorization: "token oauth-token",
      Accept: "application/json",
      "Editor-Version": "vscode/1.96.2",
    });
  });

  it.each(["acme.ghe.com", "https://acme.ghe.com"])(
    "routes OpenCode OAuth through a validated GHE.com host: %s",
    async (enterpriseUrl) => {
      authMocks.readAuthFile.mockResolvedValue({
        "github-copilot": { type: "oauth", access: "oauth-token", enterpriseUrl },
      });
      const fetchMock = vi.fn(async () => json(copilotUser()));
      vi.stubGlobal("fetch", fetchMock as any);

      const { queryCopilotQuota } = await import("../src/lib/copilot.js");
      await expect(queryCopilotQuota()).resolves.toMatchObject({ success: true });
      expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.acme.ghe.com/copilot_internal/user");
    },
  );

  it("keeps token-based OAuth placeholders plan-only", async () => {
    authMocks.readAuthFile.mockResolvedValue({
      "github-copilot": { type: "oauth", refresh: "oauth-token" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json(
          copilotUser({
            copilot_plan: "business",
            quota_snapshots: {
              premium_interactions: {
                entitlement: 0,
                remaining: 0,
                percent_remaining: 0,
                unlimited: false,
              },
            },
          }),
        ),
      ) as any,
    );

    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    await expect(queryCopilotQuota()).resolves.toEqual({
      success: true,
      mode: "user_plan",
      plan: "business",
      resetTimeIso: "2026-02-01T00:00:00.000Z",
    });
  });

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
    vi.resetModules();
    authMocks.readAuthFile.mockResolvedValue({
      "github-copilot": { type: "oauth", access: "oauth-secret", enterpriseUrl },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as any);

    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    const result = await queryCopilotQuota();
    const error = result && !result.success ? result.error : "";
    expect(error).toContain("Invalid OpenCode Copilot enterpriseUrl");
    expect(error).not.toContain("oauth-secret");
    expect(error).not.toContain(enterpriseUrl);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("routes PAT username, usage, and budget requests through its own GHE.com host", async () => {
    configure({
      token: "github_pat_org",
      tier: "business",
      organization: "acme",
      enterpriseUrl: "https://billing.ghe.com",
    });
    const fetchMock = vi.fn(async (url: unknown) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/ai_credit/usage")) return json(aiUsage());
      return json({ budgets: [], has_next_page: false });
    });
    vi.stubGlobal("fetch", fetchMock as any);

    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    await expect(queryCopilotQuota()).resolves.toMatchObject({
      success: true,
      mode: "organization_usage",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url] of fetchMock.mock.calls) {
      expect(new URL(String(url)).hostname).toBe("api.billing.ghe.com");
    }
  });

  it("routes PAT username resolution and personal usage through its own GHE.com host", async () => {
    configure({ token: "ghp_classic", tier: "pro", enterpriseUrl: "personal.ghe.com" });
    const fetchMock = vi.fn(async (url: unknown) => {
      const path = new URL(String(url)).pathname;
      if (path === "/user") return json({ login: "alice" });
      return json(aiUsage());
    });
    vi.stubGlobal("fetch", fetchMock as any);

    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    await expect(queryCopilotQuota()).resolves.toMatchObject({ success: true });
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).hostname)).toEqual([
      "api.personal.ghe.com",
      "api.personal.ghe.com",
    ]);
  });

  it("rejects an invalid PAT enterprise host without reading or borrowing OAuth", async () => {
    configure({
      token: "github_pat_org",
      tier: "business",
      organization: "acme",
      enterpriseUrl: "https://acme.ghe.com/path?token=pat-secret",
    });
    authMocks.readAuthFile.mockResolvedValue({
      "github-copilot": {
        type: "oauth",
        access: "oauth-token",
        enterpriseUrl: "oauth.ghe.com",
      },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as any);

    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    const result = await queryCopilotQuota();
    const error = result && !result.success ? result.error : "";
    expect(error).toContain("Invalid copilot-quota-token.json");
    expect(error).not.toContain("pat-secret");
    expect(authMocks.readAuthFile).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the trusted billing token authoritative when OpenCode OAuth is also configured", async () => {
    configure({
      token: "github_pat_personal",
      tier: "pro",
      username: "alice",
    });
    authMocks.readAuthFile.mockResolvedValue({
      "github-copilot": {
        type: "oauth",
        access: "oauth-token",
        enterpriseUrl: "oauth.ghe.com",
      },
    });
    const fetchMock = vi.fn(async () => json(aiUsage()));
    vi.stubGlobal("fetch", fetchMock as any);

    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    await expect(queryCopilotQuota()).resolves.toMatchObject({
      success: true,
      mode: "user_quota",
      unit: "ai_credits",
    });

    expect(authMocks.readAuthFile).not.toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).hostname).toBe("api.github.com");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer github_pat_personal",
    });
  });

  it("does not fall back to OpenCode OAuth when the trusted billing config is invalid", async () => {
    configure({ token: "github_pat_invalid" });
    authMocks.readAuthFile.mockResolvedValue({
      "github-copilot": { type: "oauth", access: "oauth-token" },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as any);

    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    const result = await queryCopilotQuota();

    expect(result && !result.success ? result.error : "").toContain(
      "Invalid copilot-quota-token.json",
    );
    expect(authMocks.readAuthFile).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the personal AI Credit endpoint and required 2026-03-10 headers", async () => {
    configure({
      token: "github_pat_personal",
      tier: "max",
      username: "alice",
    });
    const fetchMock = vi.fn(async () => json(aiUsage()));
    vi.stubGlobal("fetch", fetchMock as any);

    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    await expect(queryCopilotQuota()).resolves.toEqual({
      success: true,
      mode: "user_quota",
      unit: "ai_credits",
      used: 100,
      includedUsed: 80,
      billedUsed: 20,
      billedAmountUsd: 0.2,
      total: 20000,
      percentRemaining: 99,
      plan: "max",
      resetTimeIso: "2026-02-01T00:00:00.000Z",
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const target = new URL(String(url));
    expect(target.pathname).toBe("/users/alice/settings/billing/ai_credit/usage");
    expect(target.searchParams.get("year")).toBe("2026");
    expect(target.searchParams.get("month")).toBe("1");
    expect(target.searchParams.get("product")).toBeNull();
    expect(init.headers).toMatchObject({
      Accept: "application/vnd.github+json",
      Authorization: "Bearer github_pat_personal",
      "X-GitHub-Api-Version": "2026-03-10",
    });
  });

  it("resolves the personal username with the same versioned public REST contract", async () => {
    configure({ token: "ghp_classic", tier: "pro" });
    const fetchMock = vi.fn(async (url: unknown) => {
      const path = new URL(String(url)).pathname;
      if (path === "/user") return json({ login: "alice" });
      if (path === "/users/alice/settings/billing/ai_credit/usage") return json(aiUsage());
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock as any);

    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    const result = await queryCopilotQuota();
    expect(result && result.success && result.mode === "user_quota" ? result.total : null).toBe(
      1500,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps Student value-only because GitHub documents no concrete Student allowance", async () => {
    configure({ token: "github_pat_student", tier: "student", username: "student" });
    vi.stubGlobal("fetch", vi.fn(async () => json(aiUsage())) as any);

    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    await expect(queryCopilotQuota()).resolves.toEqual({
      success: true,
      mode: "user_quota",
      unit: "ai_credits",
      used: 100,
      includedUsed: 80,
      billedUsed: 20,
      billedAmountUsd: 0.2,
      total: undefined,
      percentRemaining: undefined,
      plan: "student",
      resetTimeIso: "2026-02-01T00:00:00.000Z",
    });
  });

  it("supports GitHub App user tokens for personal reports but rejects installation tokens", async () => {
    configure({ token: "ghu_user_token", tier: "pro", username: "alice" });
    const fetchMock = vi.fn(async () => json(aiUsage()));
    vi.stubGlobal("fetch", fetchMock as any);

    let module = await import("../src/lib/copilot.js");
    await expect(module.queryCopilotQuota()).resolves.toMatchObject({ success: true });
    expect(fetchMock).toHaveBeenCalledOnce();

    vi.resetModules();
    configure({ token: "ghs_installation_token", tier: "pro", username: "alice" });
    module = await import("../src/lib/copilot.js");
    const rejected = await module.queryCopilotQuota();
    expect(rejected && !rejected.success ? rejected.error : "").toContain(
      "not GitHub App installation access tokens",
    );
  });

  it("rejects Business accounting without the required organization scope", async () => {
    configure({ token: "github_pat_business", tier: "business" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as any);

    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    const result = await queryCopilotQuota();

    expect(result && !result.success ? result.error : "").toContain(
      'Copilot Business AI Credit usage requires "organization"',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses organization AI Credit and budget endpoints for fine-grained PATs and App installations", async () => {
    for (const token of ["github_pat_org", "ghs_installation"]) {
      vi.resetModules();
      configure({
        token,
        tier: "business",
        organization: "acme",
        username: "alice",
      });
      const fetchMock = vi.fn(async (url: unknown) => {
        const target = new URL(String(url));
        if (target.pathname === "/organizations/acme/settings/billing/ai_credit/usage") {
          return json({ ...aiUsage(), organization: "acme" });
        }
        if (target.pathname === "/organizations/acme/settings/billing/budgets") {
          return json({
            budgets: [
              {
                id: "budget-1",
                budget_type: "BundlePricing",
                budget_product_skus: ["ai_credits"],
                budget_scope: "user",
                budget_entity_name: "alice",
                budget_amount: 1,
              },
            ],
            has_next_page: false,
          });
        }
        return new Response("not found", { status: 404 });
      });
      vi.stubGlobal("fetch", fetchMock as any);

      const { queryCopilotQuota } = await import("../src/lib/copilot.js");
      await expect(queryCopilotQuota()).resolves.toEqual({
        success: true,
        mode: "organization_usage",
        organization: "acme",
        username: "alice",
        period: { year: 2026, month: 1 },
        unit: "ai_credits",
        used: 100,
        includedUsed: 80,
        billedUsed: 20,
        billedAmountUsd: 0.2,
        budget: {
          amountUsd: 1,
          spentUsd: 0.2,
          scope: "user",
          percentRemaining: 80,
        },
        warnings: undefined,
        resetTimeIso: "2026-02-01T00:00:00.000Z",
      });

      const usageUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
      expect(usageUrl.searchParams.get("user")).toBe("alice");
      const budgetUrl = new URL(String(fetchMock.mock.calls[1]?.[0]));
      expect(budgetUrl.searchParams.get("user")).toBe("alice");
      expect(budgetUrl.searchParams.get("per_page")).toBe("100");
    }
  });

  it("treats empty organization AI Credit usage as zero instead of an error", async () => {
    configure({ token: "github_pat_org", tier: "business", organization: "acme" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/ai_credit/usage")) {
          return json({
            timePeriod: { year: 2026, month: 1 },
            organization: "acme",
            usageItems: [],
          });
        }
        return json({ budgets: [], has_next_page: false });
      }) as any,
    );

    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    await expect(queryCopilotQuota()).resolves.toMatchObject({
      success: true,
      mode: "organization_usage",
      organization: "acme",
      unit: "ai_credits",
      used: 0,
      includedUsed: 0,
      billedUsed: 0,
    });
  });

  it("keeps a zero-dollar budget value-only instead of inventing a percentage", async () => {
    configure({ token: "github_pat_org", tier: "business", organization: "acme" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/ai_credit/usage")) return json(aiUsage());
        return json({
          budgets: [
            {
              budget_type: "BundlePricing",
              budget_product_skus: ["ai_credits"],
              budget_scope: "organization",
              budget_amount: 0,
            },
          ],
          has_next_page: false,
        });
      }) as any,
    );

    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    const result = await queryCopilotQuota();
    expect(
      result && result.success && result.mode === "organization_usage" ? result.budget : null,
    ).toEqual({
      amountUsd: 0,
      spentUsd: 0.2,
      scope: "organization",
      percentRemaining: undefined,
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
    const fetchMock = vi.fn(async (url: unknown) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/ai_credit/usage")) return json(aiUsage());
      return json({
        budgets: [
          {
            budget_type: "BundlePricing",
            budget_product_skus: ["ai_credits"],
            budget_scope: "enterprise",
            budget_amount: 5,
          },
        ],
        has_next_page: false,
      });
    });
    vi.stubGlobal("fetch", fetchMock as any);

    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    const result = await queryCopilotQuota();
    expect(result).toMatchObject({
      success: true,
      mode: "enterprise_usage",
      enterprise: "octo",
      organization: "acme",
      username: "alice",
      budget: { amountUsd: 5, spentUsd: 0.2, percentRemaining: 96 },
    });
    const usageUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(usageUrl.hostname).toBe("api.enterprise.ghe.com");
    expect(usageUrl.pathname).toBe("/enterprises/octo/settings/billing/ai_credit/usage");
    expect(new URL(String(fetchMock.mock.calls[1]?.[0])).hostname).toBe("api.enterprise.ghe.com");
    expect(usageUrl.searchParams.get("organization")).toBe("acme");
    expect(usageUrl.searchParams.get("user")).toBe("alice");
  });

  it("treats empty enterprise AI Credit usage as zero instead of an error", async () => {
    configure({ token: "ghp_classic", tier: "enterprise", enterprise: "octo" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/ai_credit/usage")) {
          return json({
            timePeriod: { year: 2026, month: 1 },
            enterprise: "octo",
            usageItems: [],
          });
        }
        return json({ budgets: [], has_next_page: false });
      }) as any,
    );

    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    await expect(queryCopilotQuota()).resolves.toMatchObject({
      success: true,
      mode: "enterprise_usage",
      enterprise: "octo",
      unit: "ai_credits",
      used: 0,
      includedUsed: 0,
      billedUsed: 0,
    });
  });

  it.each(["github_pat_enterprise", "ghu_enterprise", "ghs_enterprise"])(
    "rejects unsupported fine-grained/App token type %s for enterprise reports",
    async (token) => {
      configure({ token, tier: "enterprise", enterprise: "octo" });
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock as any);

      const { queryCopilotQuota } = await import("../src/lib/copilot.js");
      const result = await queryCopilotQuota();
      expect(result && !result.success ? result.error : "").toContain(
        "do not support fine-grained PATs or GitHub App access tokens",
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("allows legacy PRUs only for explicitly selected Pro/Pro+ annual-plan eligibility", async () => {
    configure({
      token: "github_pat_legacy",
      tier: "pro+",
      billingModel: "legacy_premium_requests",
      username: "alice",
    });
    const fetchMock = vi.fn(async () =>
      json({
        usageItems: [
          {
            product: "Copilot",
            sku: "Copilot Premium Request",
            unitType: "requests",
            grossQuantity: 150,
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock as any);

    let module = await import("../src/lib/copilot.js");
    await expect(module.queryCopilotQuota()).resolves.toEqual({
      success: true,
      mode: "user_quota",
      unit: "premium_requests",
      used: 150,
      total: 1500,
      percentRemaining: 90,
      plan: "pro+",
      resetTimeIso: "2026-02-01T00:00:00.000Z",
    });
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).pathname).toBe(
      "/users/alice/settings/billing/premium_request/usage",
    );

    vi.resetModules();
    configure({
      token: "github_pat_legacy",
      tier: "max",
      billingModel: "legacy_premium_requests",
      username: "alice",
    });
    module = await import("../src/lib/copilot.js");
    const rejected = await module.queryCopilotQuota();
    expect(rejected && !rejected.success ? rejected.error : "").toContain(
      "only available to Copilot Pro or Pro+",
    );
  });

  it("keeps successful AI Credit usage when the optional budget response is forbidden", async () => {
    configure({ token: "github_pat_org", tier: "business", organization: "acme" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/ai_credit/usage")) return json(aiUsage());
        return json(
          { message: "Resource not accessible by personal access token" },
          { status: 403 },
        );
      }) as any,
    );

    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    const result = await queryCopilotQuota();
    expect(result).toMatchObject({
      success: true,
      mode: "organization_usage",
      used: 100,
      budget: undefined,
    });
    expect(
      result && result.success && result.mode === "organization_usage" ? result.warnings?.[0] : "",
    ).toContain("usage loaded, but the budget report failed");
  });

  it("surfaces auth, permission, rate-limit, and malformed-response failures explicitly", async () => {
    configure({ token: "github_pat_personal", tier: "pro", username: "alice" });
    const scenarios = [
      {
        response: json({ message: "Bad credentials" }, { status: 401 }),
        expected: "GitHub API error 401: Bad credentials",
      },
      {
        response: json(
          { message: "API rate limit exceeded" },
          { status: 403, headers: { "x-ratelimit-remaining": "0" } },
        ),
        expected: "GitHub API rate limit exhausted",
      },
      {
        response: json({ message: "Resource not accessible" }, { status: 403 }),
        expected: "GitHub API error 403: Resource not accessible",
      },
      {
        response: new Response("{", { status: 200 }),
        expected: "malformed JSON",
      },
    ];

    for (const scenario of scenarios) {
      vi.resetModules();
      vi.stubGlobal("fetch", vi.fn(async () => scenario.response) as any);
      const { queryCopilotQuota } = await import("../src/lib/copilot.js");
      const result = await queryCopilotQuota();
      expect(result && !result.success ? result.error : "").toContain(scenario.expected);
    }
  });

  it("rejects malformed and wrong-SKU usage responses", async () => {
    configure({ token: "github_pat_personal", tier: "pro", username: "alice" });

    vi.stubGlobal("fetch", vi.fn(async () => json({ usageItems: {} })) as any);
    let module = await import("../src/lib/copilot.js");
    let result = await module.queryCopilotQuota();
    expect(result && !result.success ? result.error : "").toContain("usageItems array");

    vi.resetModules();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({ usageItems: [{ product: "Actions", sku: "Actions Linux", grossQuantity: 1 }] }),
      ) as any,
    );
    module = await import("../src/lib/copilot.js");
    result = await module.queryCopilotQuota();
    expect(result && !result.success ? result.error : "").toContain(
      "did not contain an AI Credit usage item",
    );
  });

  it("keeps invalid trusted billing config blocking in diagnostics when OAuth exists", async () => {
    configure({ token: "github_pat_invalid" });
    const { getCopilotQuotaAuthDiagnostics } = await import("../src/lib/copilot.js");
    const diagnostics = getCopilotQuotaAuthDiagnostics({
      "github-copilot": { type: "oauth", access: "oauth-token" },
    });

    expect(diagnostics).toMatchObject({
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
    });
    expect(diagnostics.queryPeriod).toBeUndefined();
  });

  it("reports current scope, API, token compatibility, denominator, budget, and OAuth state", async () => {
    configure({
      token: "github_pat_org",
      tier: "business",
      organization: "acme",
      username: "alice",
    });
    const { getCopilotQuotaAuthDiagnostics } = await import("../src/lib/copilot.js");
    const diagnostics = getCopilotQuotaAuthDiagnostics({
      "github-copilot": { type: "oauth", access: "oauth-token" },
    });

    expect(diagnostics).toMatchObject({
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
      usernameFilter: "alice",
    });
    expect(diagnostics.queryPeriod).toEqual({ year: 2026, month: 1 });
  });

  it("reports bounded OAuth GHE.com deployment diagnostics without URLs or tokens", async () => {
    const { getCopilotQuotaAuthDiagnostics } = await import("../src/lib/copilot.js");
    const diagnostics = getCopilotQuotaAuthDiagnostics({
      "github-copilot": {
        type: "oauth",
        access: "oauth-secret",
        enterpriseUrl: "https://acme.ghe.com",
      },
    });

    expect(diagnostics).toMatchObject({
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
    });
    expect(JSON.stringify(diagnostics)).not.toContain("oauth-secret");
    expect(JSON.stringify(diagnostics)).not.toContain("https://");
  });

  it("reports an invalid OAuth host safely without exposing its URL or query", async () => {
    const { getCopilotQuotaAuthDiagnostics } = await import("../src/lib/copilot.js");
    const diagnostics = getCopilotQuotaAuthDiagnostics({
      "github-copilot": {
        type: "oauth",
        access: "oauth-secret",
        enterpriseUrl: "https://acme.ghe.com/path?token=oauth-secret",
      },
    });

    expect(diagnostics).toMatchObject({
      effectiveSource: "oauth",
      deployment: "invalid",
      apiHost: null,
      enterpriseHostSource: "none",
      billingApiAccessLikely: false,
      oauthAccountingState: "invalid_enterprise_host",
    });
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain("oauth-secret");
    expect(serialized).not.toContain("https://");
    expect(serialized).not.toContain("?token=");
  });
});
