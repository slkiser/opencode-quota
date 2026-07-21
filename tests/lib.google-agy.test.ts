import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readAuthFileCached: vi.fn(),
  fetchWithTimeout: vi.fn(),
  getCachedAccessToken: vi.fn(),
  makeAccountCacheKey: vi.fn(),
  setCachedAccessToken: vi.fn(),
  inspectAgyCompanionPresence: vi.fn(),
  resolveAgyClientCredentials: vi.fn(),
  clearAgyCompanionCacheForTests: vi.fn(),
}));

vi.mock("../src/lib/opencode-auth.js", () => ({
  readAuthFileCached: mocks.readAuthFileCached,
}));

vi.mock("../src/lib/http.js", () => ({
  fetchWithTimeout: mocks.fetchWithTimeout,
}));

vi.mock("../src/lib/google-token-cache.js", () => ({
  getCachedAccessToken: mocks.getCachedAccessToken,
  makeAccountCacheKey: mocks.makeAccountCacheKey,
  setCachedAccessToken: mocks.setCachedAccessToken,
}));

vi.mock("../src/lib/google-agy-companion.js", () => ({
  inspectAgyCompanionPresence: mocks.inspectAgyCompanionPresence,
  resolveAgyClientCredentials: mocks.resolveAgyClientCredentials,
  clearAgyCompanionCacheForTests: mocks.clearAgyCompanionCacheForTests,
}));

import {
  DEFAULT_AGY_AUTH_CACHE_MAX_AGE_MS,
  inspectAgyAuthPresence,
  parseAgyRefreshParts,
  queryGoogleAgyQuota,
  resolveAgyAccounts,
  resolveAgyConfiguredProjectId,
  formatDisplayName,
  detectQuotaWindow,
} from "../src/lib/google-agy.js";

function mockJsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

describe("google agy logic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readAuthFileCached.mockResolvedValue(null);
    mocks.fetchWithTimeout.mockResolvedValue(mockJsonResponse({ buckets: [] }));
    mocks.getCachedAccessToken.mockResolvedValue({ accessToken: "cached-access-token" });
    mocks.makeAccountCacheKey.mockReturnValue("test-cache-key");
    mocks.resolveAgyClientCredentials.mockResolvedValue({
      state: "configured",
      clientId: "client-id",
      clientSecret: "client-secret",
    });
    delete process.env.OPENCODE_AGY_PROJECT_ID;
    delete process.env.OPENCODE_AGY_ENDPOINT;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GOOGLE_CLOUD_PROJECT_ID;
  });

  it("parses opencode-agy-auth packed refresh strings", () => {
    expect(parseAgyRefreshParts("refresh-token|project-1|managed-project")).toEqual({
      refreshToken: "refresh-token",
      projectId: "project-1",
      managedProjectId: "managed-project",
    });
  });

  it("formats model display names correctly", () => {
    expect(formatDisplayName("gemini-3.5-flash")).toBe("Gemini 3.5 Flash");
    expect(formatDisplayName("claude-sonnet-4-6")).toBe("Claude Sonnet 4.6");
    expect(formatDisplayName("gpt-oss-120b-medium")).toBe("GPT-OSS 120B (Medium)");
    expect(formatDisplayName("gpt_oss_120b_medium")).toBe("GPT-OSS 120B (Medium)");
    expect(formatDisplayName("gemini_3_5_flash")).toBe("Gemini 3.5 Flash");
  });

  it("resolves the project id with correct precedence", async () => {
    process.env.GOOGLE_CLOUD_PROJECT = "generic-gcp-project";
    await expect(resolveAgyConfiguredProjectId()).resolves.toBe("generic-gcp-project");

    await expect(
      resolveAgyConfiguredProjectId({
        config: {
          get: async () => ({
            data: {
              provider: {
                "google-agy": { options: { projectId: "configured-agy-project" } },
              },
            },
          }),
        },
      }),
    ).resolves.toBe("configured-agy-project");

    process.env.OPENCODE_AGY_PROJECT_ID = "explicit-agy-project";
    await expect(
      resolveAgyConfiguredProjectId({
        config: {
          get: async () => ({
            data: {
              provider: {
                "google-agy": { options: { projectId: "configured-agy-project" } },
              },
            },
          }),
        },
      }),
    ).resolves.toBe("explicit-agy-project");
  });

  it("resolves accounts correctly and deduplicates them", () => {
    const auth = {
      "google-agy": {
        type: "oauth" as const,
        refresh: "refresh-token-1|project-1",
        email: "alice@example.com",
      },
      "opencode-agy-auth": {
        type: "oauth" as const,
        refresh: "refresh-token-1|project-1",
        email: "alice@example.com",
      },
      "google-agy-auth": {
        type: "oauth" as const,
        refresh: "refresh-token-2|project-2",
        email: "bob@example.com",
      },
    };
    const resolved = resolveAgyAccounts(auth);
    expect(resolved).toHaveLength(2);
    expect(resolved[0]).toEqual({
      sourceKey: "google-agy",
      refreshToken: "refresh-token-1",
      projectId: "project-1",
      email: "alice@example.com",
    });
    expect(resolved[1]).toEqual({
      sourceKey: "google-agy-auth",
      refreshToken: "refresh-token-2",
      projectId: "project-2",
      email: "bob@example.com",
    });
  });

  it("prioritizes managedProjectId and quotaProjectId over developer projectIds in resolveAgyAccounts", () => {
    const auth = {
      "google-agy": {
        type: "oauth" as const,
        refresh: "refresh-token-1|dev-project-part|managed-project-part",
        email: "alice@example.com",
        projectId: "dev-project-entry",
        projectID: "dev-project-entry-2",
        managedProjectId: "managed-project-entry",
        quotaProjectId: "quota-project-entry",
      },
    };

    // Test 1: entry.managedProjectId takes top priority
    let resolved = resolveAgyAccounts(auth, "configured-project");
    expect(resolved[0].projectId).toBe("managed-project-entry");

    // Test 2: entry.quotaProjectId takes priority over entry.projectId/projectID and parts and configuredProjectId
    const auth2 = {
      "google-agy": {
        type: "oauth" as const,
        refresh: "refresh-token-1|dev-project-part|managed-project-part",
        email: "alice@example.com",
        projectId: "dev-project-entry",
        projectID: "dev-project-entry-2",
        quotaProjectId: "quota-project-entry",
      },
    };
    resolved = resolveAgyAccounts(auth2, "configured-project");
    expect(resolved[0].projectId).toBe("quota-project-entry");

    // Test 3: parts.managedProjectId takes priority over entry.projectId/projectID and parts.projectId and configuredProjectId
    const auth3 = {
      "google-agy": {
        type: "oauth" as const,
        refresh: "refresh-token-1|dev-project-part|managed-project-part",
        email: "alice@example.com",
        projectId: "dev-project-entry",
        projectID: "dev-project-entry-2",
      },
    };
    resolved = resolveAgyAccounts(auth3, "configured-project");
    expect(resolved[0].projectId).toBe("managed-project-part");
  });

  it("returns error if companion credentials are missing or invalid", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      "google-agy": {
        type: "oauth",
        refresh: "refresh-token-1|project-1",
        email: "alice@example.com",
      },
    });
    mocks.resolveAgyClientCredentials.mockResolvedValueOnce({
      state: "missing",
      error: "Companion plugin is missing",
    });
    const result = await queryGoogleAgyQuota();
    expect(result).toEqual({
      success: false,
      error: "Companion plugin is missing",
    });
  });

  it("aggregates multiple limits per model ID keeping the lowest remaining percent", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      "google-agy": {
        type: "oauth",
        refresh: "refresh-token-1|project-1",
        email: "alice@example.com",
      },
    });
    mocks.resolveAgyClientCredentials.mockResolvedValueOnce({
      state: "configured",
      clientId: "client-id",
      clientSecret: "client-secret",
    });
    mocks.getCachedAccessToken.mockResolvedValueOnce({ accessToken: "cached-token" });

    mocks.fetchWithTimeout.mockResolvedValueOnce(
      mockJsonResponse({
        buckets: [
          {
            modelId: "gemini-3.5-flash",
            remainingFraction: 0.8,
            tokenType: "REQUESTS",
          },
          {
            modelId: "gemini-3.5-flash",
            remainingFraction: 0.25,
            tokenType: "TOKENS",
          },
          {
            modelId: "claude-sonnet-4-6",
            remainingFraction: 0.9,
          },
        ],
      }),
    );

    const result = await queryGoogleAgyQuota();
    expect(result).toMatchObject({ success: true });
    if (!result || !result.success) {
      throw new Error("expected success");
    }
    expect(result.buckets).toEqual([
      {
        modelId: "gemini-3.5-flash",
        displayName: "Gemini 3.5 Flash",
        percentRemaining: 25,
        tokenType: "TOKENS",
        window: "unknown",
        accountEmail: "alice@example.com",
        accountKey: expect.any(String),
        sourceKey: "google-agy",
      },
      {
        modelId: "claude-sonnet-4-6",
        displayName: "Claude Sonnet 4.6",
        percentRemaining: 90,
        window: "unknown",
        accountEmail: "alice@example.com",
        accountKey: expect.any(String),
        sourceKey: "google-agy",
      },
    ]);
  });

  it("refreshes token when cache is empty and handles force refresh on auth error", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      "google-agy": {
        type: "oauth",
        refresh: "refresh-token-1|project-1",
        email: "alice@example.com",
      },
    });
    mocks.resolveAgyClientCredentials.mockResolvedValueOnce({
      state: "configured",
      clientId: "client-id",
      clientSecret: "client-secret",
    });
    mocks.getCachedAccessToken.mockResolvedValueOnce(null);

    mocks.fetchWithTimeout.mockResolvedValueOnce(
      mockJsonResponse({
        access_token: "new-access-token",
        expires_in: 3600,
      })
    );

    mocks.fetchWithTimeout.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({}),
    });

    mocks.fetchWithTimeout.mockResolvedValueOnce(
      mockJsonResponse({
        access_token: "retry-access-token",
        expires_in: 3600,
      })
    );

    mocks.fetchWithTimeout.mockResolvedValueOnce(
      mockJsonResponse({
        buckets: [
          {
            modelId: "gemini-3.5-flash",
            remainingFraction: 0.5,
          },
        ],
      })
    );

    const result = await queryGoogleAgyQuota();
    expect(result).toMatchObject({ success: true });
    if (!result || !result.success) {
      throw new Error("expected success");
    }
    expect(result.buckets[0]).toMatchObject({
      modelId: "gemini-3.5-flash",
      percentRemaining: 50,
    });
  });

  it("keeps Google AGY quota requests on the fixed Google endpoint", async () => {
    process.env.OPENCODE_AGY_ENDPOINT = "https://evil.example";
    mocks.readAuthFileCached.mockResolvedValueOnce({
      "google-agy": {
        type: "oauth",
        refresh: "refresh-token-1|project-1",
        email: "alice@example.com",
      },
    });
    mocks.getCachedAccessToken.mockResolvedValueOnce({ accessToken: "cached-token" });
    mocks.fetchWithTimeout.mockResolvedValueOnce(mockJsonResponse({ buckets: [] }));

    await queryGoogleAgyQuota();

    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer cached-token",
        }),
      }),
      expect.any(Number),
    );
  });

  it("reports invalid auth when OAuth exists but no project id can be resolved", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      "google-agy": { type: "oauth", refresh: "refresh-token" },
    });

    await expect(inspectAgyAuthPresence()).resolves.toMatchObject({
      state: "invalid",
      sourceKey: "google-agy",
      accountCount: 1,
      validAccountCount: 0,
    });
  });

  describe("detectQuotaWindow", () => {
    it.each([
      ["weekly", "weekly"],
      ["monthly", "monthly"],
      ["daily", "daily"],
      ["session", "session"],
      ["WEEKLY", "weekly"],
      ["Weekly", "weekly"],
      [undefined, "unknown"],
      [null, "unknown"],
      ["", "unknown"],
      ["TOKENS", "unknown"],
      ["REQUESTS", "unknown"],
      ["some-unknown-type", "unknown"],
    ])("maps tokenType=%s to window=%s", (tokenType, expected) => {
      expect(detectQuotaWindow(tokenType)).toBe(expected);
    });
  });
});