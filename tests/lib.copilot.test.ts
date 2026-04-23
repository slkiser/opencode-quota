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
const realEnv = process.env;

describe("queryCopilotQuota", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z"));
    process.env = { ...realEnv };
    fsMocks.existsSync.mockReset();
    fsMocks.existsSync.mockReturnValue(false);
    fsMocks.readFileSync.mockReset();
    authMocks.readAuthFile.mockReset();
    authMocks.readAuthFile.mockResolvedValue({});
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })) as any);
  });

  afterEach(() => {
    process.env = realEnv;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("returns null when no PAT config and no OpenCode Copilot auth exist", async () => {
    const { queryCopilotQuota } = await import("../src/lib/copilot.js");

    await expect(queryCopilotQuota()).resolves.toBeNull();
  });

  it("prefers PAT billing config over OpenCode auth when both exist", async () => {
    fsMocks.existsSync.mockImplementation((path) => path === patPath);
    fsMocks.readFileSync.mockReturnValue(
      JSON.stringify({
        token: "github_pat_123456789",
        tier: "pro",
        username: "alice",
      }),
    );
    authMocks.readAuthFile.mockResolvedValueOnce({
      "github-copilot": { type: "oauth", access: "oauth_access_token" },
    });

    const fetchMock = vi.fn(async (url: unknown) => {
      const target = String(url);

      if (target.includes("/users/alice/settings/billing/premium_request/usage")) {
        return new Response(
          JSON.stringify({
            usageItems: [
              {
                sku: "Copilot Premium Request",
                grossQuantity: 42,
                limit: 300,
              },
            ],
          }),
          { status: 200 },
        );
      }

      return new Response("not found", { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock as any);

    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    const result = await queryCopilotQuota();

    expect(result).toEqual({
      success: true,
      mode: "user_quota",
      used: 42,
      total: 300,
      percentRemaining: 86,
      resetTimeIso: "2026-02-01T00:00:00.000Z",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/users/alice/settings/billing/premium_request/usage",
    );
  });

  it("uses /copilot_internal/user when OAuth is present and PAT is absent", async () => {
    authMocks.readAuthFile.mockResolvedValueOnce({
      "github-copilot-chat": { type: "oauth", access: "oauth_access_token", refresh: "refresh" },
    });

    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const target = String(url);

      if (target === "https://api.github.com/copilot_internal/user") {
        expect(init?.headers).toMatchObject({
          Authorization: "Bearer oauth_access_token",
        });
        return new Response(
          JSON.stringify({
            quota: {
              used: 12,
              limit: 300,
              reset_at: "2026-02-01T00:00:00.000Z",
            },
          }),
          { status: 200 },
        );
      }

      return new Response("not found", { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock as any);

    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    const result = await queryCopilotQuota();

    expect(result).toEqual({
      success: true,
      mode: "user_quota",
      used: 12,
      total: 300,
      percentRemaining: 96,
      resetTimeIso: "2026-02-01T00:00:00.000Z",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.github.com/copilot_internal/user");
  });

  it("parses premium_interactions from /copilot_internal/user quota_snapshots", async () => {
    authMocks.readAuthFile.mockResolvedValueOnce({
      "github-copilot": { type: "oauth", access: "oauth_access_token", refresh: "refresh" },
    });

    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const target = String(url);

      if (target === "https://api.github.com/copilot_internal/user") {
        expect(init?.headers).toMatchObject({
          Authorization: "Bearer oauth_access_token",
        });
        return new Response(
          JSON.stringify({
            login: "slkiser",
            access_type_sku: "free_educational_quota",
            copilot_plan: "individual",
            quota_reset_date: "2026-04-01",
            quota_reset_date_utc: "2026-04-01T00:00:00.000Z",
            quota_snapshots: {
              premium_interactions: {
                entitlement: 300,
                quota_remaining: 230,
                remaining: 230,
                unlimited: false,
              },
            },
          }),
          { status: 200 },
        );
      }

      return new Response("not found", { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock as any);

    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    const result = await queryCopilotQuota();

    expect(result).toEqual({
      success: true,
      mode: "user_quota",
      used: 70,
      total: 300,
      percentRemaining: 76,
      resetTimeIso: "2026-04-01T00:00:00.000Z",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.github.com/copilot_internal/user");
  });

  it("treats unlimited premium_interactions as unlimited instead of rendering 0/1 quota", async () => {
    authMocks.readAuthFile.mockResolvedValueOnce({
      "github-copilot": { type: "oauth", access: "oauth_access_token", refresh: "refresh" },
    });

    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const target = String(url);

      if (target === "https://api.github.com/copilot_internal/user") {
        expect(init?.headers).toMatchObject({
          Authorization: "Bearer oauth_access_token",
        });
        return new Response(
          JSON.stringify({
            quota_reset_date_utc: "2026-04-01T00:00:00.000Z",
            quota_snapshots: {
              premium_interactions: {
                entitlement: 1,
                remaining: 1,
                percent_remaining: 100,
                unlimited: true,
              },
            },
          }),
          { status: 200 },
        );
      }

      return new Response("not found", { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock as any);

    const { formatCopilotQuota, queryCopilotQuota } = await import("../src/lib/copilot.js");
    const result = await queryCopilotQuota();

    expect(result).toEqual({
      success: true,
      mode: "user_quota",
      used: 0,
      total: 1,
      percentRemaining: 100,
      unlimited: true,
      resetTimeIso: "2026-04-01T00:00:00.000Z",
    });
    expect(formatCopilotQuota(result)).toBe("Copilot Unlimited");
  });

  it("prefers percent_remaining from /copilot_internal/user when present", async () => {
    authMocks.readAuthFile.mockResolvedValueOnce({
      "github-copilot": { type: "oauth", access: "oauth_access_token", refresh: "refresh" },
    });

    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const target = String(url);

      if (target === "https://api.github.com/copilot_internal/user") {
        expect(init?.headers).toMatchObject({
          Authorization: "Bearer oauth_access_token",
        });
        return new Response(
          JSON.stringify({
            quota_reset_date_utc: "2026-05-01T00:00:00.000Z",
            quota_snapshots: {
              premium_interactions: {
                entitlement: 1500,
                remaining: 401,
                percent_remaining: 26.7,
                unlimited: false,
              },
            },
          }),
          { status: 200 },
        );
      }

      return new Response("not found", { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock as any);

    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    const result = await queryCopilotQuota();

    expect(result).toEqual({
      success: true,
      mode: "user_quota",
      used: 1099,
      total: 1500,
      percentRemaining: 26,
      resetTimeIso: "2026-05-01T00:00:00.000Z",
    });
  });

  it("returns a clear error when OAuth auth exists without an access token", async () => {
    authMocks.readAuthFile.mockResolvedValueOnce({
      "github-copilot": { type: "oauth", refresh: "refresh_only" },
    });

    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    const result = await queryCopilotQuota();

    expect(result).toEqual({
      success: false,
      error:
        "Copilot OAuth auth is configured but missing an access token required for GitHub /copilot_internal/user.",
    });
  });

  it("does not fall back to OpenCode auth when PAT config is invalid", async () => {
    fsMocks.existsSync.mockImplementation((path) => path === patPath);
    fsMocks.readFileSync.mockReturnValue(JSON.stringify({ token: "github_pat_123456789" }));
    authMocks.readAuthFile.mockResolvedValueOnce({
      "github-copilot": { type: "oauth", access: "oauth_access_token" },
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as any);

    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    const result = await queryCopilotQuota();

    expect(result && !result.success ? result.error : "").toContain(
      "Invalid copilot-quota-token.json",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("errors when business tier config omits organization", async () => {
    fsMocks.existsSync.mockImplementation((path) => path === patPath);
    fsMocks.readFileSync.mockReturnValue(
      JSON.stringify({
        token: "github_pat_123456789",
        tier: "business",
      }),
    );

    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    const result = await queryCopilotQuota();

    expect(result && !result.success ? result.error : "").toContain(
      'Add "organization": "your-org-slug"',
    );
  });

  it("uses the documented organization billing endpoint with current billing period params when organization is configured", async () => {
    fsMocks.existsSync.mockImplementation((path) => path === patPath);
    fsMocks.readFileSync.mockReturnValue(
      JSON.stringify({
        token: "github_pat_123456789",
        tier: "business",
        organization: "acme-corp",
        username: "alice",
      }),
    );

    const fetchMock = vi.fn(async (url: unknown) => {
      const target = new URL(String(url));

      if (
        target.pathname ===
        "/organizations/acme-corp/settings/billing/premium_request/usage" &&
        target.searchParams.get("year") === "2026" &&
        target.searchParams.get("month") === "1" &&
        target.searchParams.get("user") === "alice" &&
        target.searchParams.get("day") === null
      ) {
        return new Response(
          JSON.stringify({
            organization: "acme-corp",
            usageItems: [
              {
                sku: "Copilot Premium Request",
                grossQuantity: 9,
              },
            ],
          }),
          { status: 200 },
        );
      }

      return new Response("not found", { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock as any);

    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    const result = await queryCopilotQuota();

    expect(result).toEqual({
      success: true,
      mode: "organization_usage",
      organization: "acme-corp",
      username: "alice",
      period: {
        year: 2026,
        month: 1,
      },
      used: 9,
      resetTimeIso: "2026-02-01T00:00:00.000Z",
    });
    const requestUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(requestUrl.pathname).toBe(
      "/organizations/acme-corp/settings/billing/premium_request/usage",
    );
    expect(requestUrl.searchParams.get("year")).toBe("2026");
    expect(requestUrl.searchParams.get("month")).toBe("1");
    expect(requestUrl.searchParams.get("user")).toBe("alice");
    expect(requestUrl.searchParams.get("day")).toBeNull();
  });

  it("treats organization business usage as usage-only when no real limit is available", async () => {
    fsMocks.existsSync.mockImplementation((path) => path === patPath);
    fsMocks.readFileSync.mockReturnValue(
      JSON.stringify({
        token: "github_pat_123456789",
        tier: "business",
        organization: "acme-corp",
      }),
    );

    const fetchMock = vi.fn(async (url: unknown) => {
      const target = new URL(String(url));

      if (
        target.pathname ===
        "/organizations/acme-corp/settings/billing/premium_request/usage" &&
        target.searchParams.get("year") === "2026" &&
        target.searchParams.get("month") === "1" &&
        target.searchParams.get("user") === null
      ) {
        return new Response(
          JSON.stringify({
            organization: "acme-corp",
            usageItems: [
              {
                sku: "Copilot Premium Request",
                grossQuantity: 27,
              },
            ],
          }),
          { status: 200 },
        );
      }

      return new Response("not found", { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock as any);

    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    const result = await queryCopilotQuota();

    expect(result).toEqual({
      success: true,
      mode: "organization_usage",
      organization: "acme-corp",
      username: undefined,
      period: {
        year: 2026,
        month: 1,
      },
      used: 27,
      resetTimeIso: "2026-02-01T00:00:00.000Z",
    });
    expect(result && result.success && "total" in result).toBe(false);
    expect(result && result.success && "percentRemaining" in result).toBe(false);
  });

  it("treats empty organization usageItems as zero usage instead of an error", async () => {
    fsMocks.existsSync.mockImplementation((path) => path === patPath);
    fsMocks.readFileSync.mockReturnValue(
      JSON.stringify({
        token: "github_pat_123456789",
        tier: "business",
        organization: "acme-corp",
      }),
    );

    const fetchMock = vi.fn(async (url: unknown) => {
      const target = new URL(String(url));

      if (
        target.pathname ===
          "/organizations/acme-corp/settings/billing/premium_request/usage" &&
        target.searchParams.get("year") === "2026" &&
        target.searchParams.get("month") === "1"
      ) {
        return new Response(
          JSON.stringify({
            organization: "acme-corp",
            usageItems: [],
          }),
          { status: 200 },
        );
      }

      return new Response("not found", { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock as any);

    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    const result = await queryCopilotQuota();

    expect(result).toEqual({
      success: true,
      mode: "organization_usage",
      organization: "acme-corp",
      username: undefined,
      period: {
        year: 2026,
        month: 1,
      },
      used: 0,
      resetTimeIso: "2026-02-01T00:00:00.000Z",
    });
  });

  it("uses the documented enterprise billing endpoint with optional organization and user filters", async () => {
    fsMocks.existsSync.mockImplementation((path) => path === patPath);
    fsMocks.readFileSync.mockReturnValue(
      JSON.stringify({
        token: "ghp_classic_pat",
        tier: "enterprise",
        enterprise: "acme-enterprise",
        organization: "acme-corp",
        username: "alice",
      }),
    );

    const fetchMock = vi.fn(async (url: unknown) => {
      const target = new URL(String(url));

      if (
        target.pathname ===
          "/enterprises/acme-enterprise/settings/billing/premium_request/usage" &&
        target.searchParams.get("year") === "2026" &&
        target.searchParams.get("month") === "1" &&
        target.searchParams.get("organization") === "acme-corp" &&
        target.searchParams.get("user") === "alice" &&
        target.searchParams.get("day") === null
      ) {
        return new Response(
          JSON.stringify({
            enterprise: "acme-enterprise",
            usageItems: [
              {
                sku: "Copilot Premium Request",
                grossQuantity: 13,
              },
            ],
          }),
          { status: 200 },
        );
      }

      return new Response("not found", { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock as any);

    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    const result = await queryCopilotQuota();

    expect(result).toEqual({
      success: true,
      mode: "enterprise_usage",
      enterprise: "acme-enterprise",
      organization: "acme-corp",
      username: "alice",
      period: {
        year: 2026,
        month: 1,
      },
      used: 13,
      resetTimeIso: "2026-02-01T00:00:00.000Z",
    });
    const requestUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(requestUrl.pathname).toBe(
      "/enterprises/acme-enterprise/settings/billing/premium_request/usage",
    );
    expect(requestUrl.searchParams.get("year")).toBe("2026");
    expect(requestUrl.searchParams.get("month")).toBe("1");
    expect(requestUrl.searchParams.get("organization")).toBe("acme-corp");
    expect(requestUrl.searchParams.get("user")).toBe("alice");
    expect(requestUrl.searchParams.get("day")).toBeNull();
  });

  it("treats empty enterprise usageItems as zero usage instead of an error", async () => {
    fsMocks.existsSync.mockImplementation((path) => path === patPath);
    fsMocks.readFileSync.mockReturnValue(
      JSON.stringify({
        token: "ghp_classic_pat",
        tier: "enterprise",
        enterprise: "acme-enterprise",
      }),
    );

    const fetchMock = vi.fn(async (url: unknown) => {
      const target = new URL(String(url));

      if (
        target.pathname ===
          "/enterprises/acme-enterprise/settings/billing/premium_request/usage" &&
        target.searchParams.get("year") === "2026" &&
        target.searchParams.get("month") === "1"
      ) {
        return new Response(
          JSON.stringify({
            enterprise: "acme-enterprise",
            usageItems: [],
          }),
          { status: 200 },
        );
      }

      return new Response("not found", { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock as any);

    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    const result = await queryCopilotQuota();

    expect(result).toEqual({
      success: true,
      mode: "enterprise_usage",
      enterprise: "acme-enterprise",
      organization: undefined,
      username: undefined,
      period: {
        year: 2026,
        month: 1,
      },
      used: 0,
      resetTimeIso: "2026-02-01T00:00:00.000Z",
    });
  });

  it("rejects fine-grained PATs for enterprise billing before making a request", async () => {
    fsMocks.existsSync.mockImplementation((path) => path === patPath);
    fsMocks.readFileSync.mockReturnValue(
      JSON.stringify({
        token: "github_pat_123456789",
        tier: "enterprise",
        enterprise: "acme-enterprise",
      }),
    );

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as any);

    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    const result = await queryCopilotQuota();

    expect(result && !result.success ? result.error : "").toContain(
      "does not support fine-grained personal access tokens",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("handles snake_case billing response fields", async () => {
    fsMocks.existsSync.mockImplementation((path) => path === patPath);
    fsMocks.readFileSync.mockReturnValue(
      JSON.stringify({
        token: "github_pat_123456789",
        tier: "pro",
        username: "alice",
      }),
    );

    const fetchMock = vi.fn(async (url: unknown) => {
      const target = String(url);

      if (target.includes("/users/alice/settings/billing/premium_request/usage")) {
        return new Response(
          JSON.stringify({
            usage_items: [
              {
                sku: "Copilot Premium Request",
                gross_quantity: 9,
                limit: 300,
              },
            ],
          }),
          { status: 200 },
        );
      }

      return new Response("not found", { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock as any);

    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    const result = await queryCopilotQuota();

    expect(result).toEqual({
      success: true,
      mode: "user_quota",
      used: 9,
      total: 300,
      percentRemaining: 97,
      resetTimeIso: "2026-02-01T00:00:00.000Z",
    });
  });

  it("uses net_quantity when gross_quantity is absent", async () => {
    fsMocks.existsSync.mockImplementation((path) => path === patPath);
    fsMocks.readFileSync.mockReturnValue(
      JSON.stringify({
        token: "github_pat_123456789",
        tier: "business",
        organization: "acme-corp",
      }),
    );

    const fetchMock = vi.fn(async (url: unknown) => {
      const target = String(url);

      if (target.includes("/organizations/acme-corp/settings/billing/premium_request/usage")) {
        return new Response(
          JSON.stringify({
            usage_items: [
              {
                sku: "Copilot Premium Request",
                net_quantity: 11,
              },
            ],
          }),
          { status: 200 },
        );
      }

      return new Response("not found", { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock as any);

    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    const result = await queryCopilotQuota();

    expect(result).toEqual({
      success: true,
      mode: "organization_usage",
      organization: "acme-corp",
      username: undefined,
      period: {
        year: 2026,
        month: 1,
      },
      used: 11,
      resetTimeIso: "2026-02-01T00:00:00.000Z",
    });
  });

  it("errors when billing response contains no premium request SKU", async () => {
    fsMocks.existsSync.mockImplementation((path) => path === patPath);
    fsMocks.readFileSync.mockReturnValue(
      JSON.stringify({
        token: "github_pat_123456789",
        tier: "pro",
        username: "alice",
      }),
    );

    const fetchMock = vi.fn(async (url: unknown) => {
      const target = String(url);

      if (target.includes("/users/alice/settings/billing/premium_request/usage")) {
        return new Response(
          JSON.stringify({
            usageItems: [
              {
                sku: "Some Other SKU",
                grossQuantity: 5,
              },
            ],
          }),
          { status: 200 },
        );
      }

      return new Response("not found", { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock as any);

    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    const result = await queryCopilotQuota();

    expect(result && !result.success ? result.error : "").toContain(
      "No premium-request items found",
    );
  });

  it("surfaces PAT precedence and organization details in diagnostics", async () => {
    fsMocks.existsSync.mockImplementation((path) => path === patPath);
    fsMocks.readFileSync.mockReturnValue(
      JSON.stringify({
        token: "github_pat_123456789",
        tier: "business",
        organization: "acme-corp",
      }),
    );

    const { getCopilotQuotaAuthDiagnostics } = await import("../src/lib/copilot.js");
    const diagnostics = getCopilotQuotaAuthDiagnostics({
      "github-copilot": { type: "oauth", access: "oauth_access_token" },
    });

    expect(diagnostics.pat.state).toBe("valid");
    expect(diagnostics.pat.config?.organization).toBe("acme-corp");
    expect(diagnostics.oauth.configured).toBe(true);
    expect(diagnostics.effectiveSource).toBe("pat");
    expect(diagnostics.override).toBe("pat_overrides_oauth");
    expect(diagnostics.quotaApi).toBe("github_billing_api");
    expect(diagnostics.billingMode).toBe("organization_usage");
    expect(diagnostics.billingScope).toBe("organization");
    expect(diagnostics.billingApiAccessLikely).toBe(true);
    expect(diagnostics.remainingTotalsState).toBe("not_available_from_org_usage");
    expect(diagnostics.queryPeriod).toEqual({ year: 2026, month: 1 });
  });

  it("treats an invalid PAT as blocking even when OAuth auth is configured", async () => {
    fsMocks.existsSync.mockImplementation((path) => path === patPath);
    fsMocks.readFileSync.mockReturnValue(JSON.stringify({ token: "github_pat_123456789" }));

    const { getCopilotQuotaAuthDiagnostics } = await import("../src/lib/copilot.js");
    const diagnostics = getCopilotQuotaAuthDiagnostics({
      "github-copilot": { type: "oauth", access: "oauth_access_token" },
    });

    expect(diagnostics.pat.state).toBe("invalid");
    expect(diagnostics.oauth.configured).toBe(true);
    expect(diagnostics.effectiveSource).toBe("pat");
    expect(diagnostics.override).toBe("pat_overrides_oauth");
    expect(diagnostics.quotaApi).toBe("none");
    expect(diagnostics.billingMode).toBe("none");
    expect(diagnostics.billingScope).toBe("none");
    expect(diagnostics.billingApiAccessLikely).toBe(false);
    expect(diagnostics.remainingTotalsState).toBe("unavailable");
    expect(diagnostics.queryPeriod).toBeUndefined();
  });

  it("surfaces enterprise billing scope and compatibility errors in diagnostics", async () => {
    fsMocks.existsSync.mockImplementation((path) => path === patPath);
    fsMocks.readFileSync.mockReturnValue(
      JSON.stringify({
        token: "github_pat_123456789",
        tier: "enterprise",
        enterprise: "acme-enterprise",
        organization: "acme-corp",
        username: "alice",
      }),
    );

    const { getCopilotQuotaAuthDiagnostics } = await import("../src/lib/copilot.js");
    const diagnostics = getCopilotQuotaAuthDiagnostics(null);

    expect(diagnostics.pat.state).toBe("valid");
    expect(diagnostics.pat.config?.enterprise).toBe("acme-enterprise");
    expect(diagnostics.billingMode).toBe("enterprise_usage");
    expect(diagnostics.billingScope).toBe("enterprise");
    expect(diagnostics.quotaApi).toBe("github_billing_api");
    expect(diagnostics.billingApiAccessLikely).toBe(false);
    expect(diagnostics.remainingTotalsState).toBe(
      "not_available_from_enterprise_usage",
    );
    expect(diagnostics.queryPeriod).toEqual({ year: 2026, month: 1 });
    expect(diagnostics.usernameFilter).toBe("alice");
    expect(diagnostics.tokenCompatibilityError).toContain(
      "does not support fine-grained personal access tokens",
    );
  });
});
