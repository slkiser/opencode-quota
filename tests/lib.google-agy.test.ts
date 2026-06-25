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
} from "../src/lib/google-agy.js";

function mockJsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

const SUMMARY_RESPONSE = {
  groups: [
    {
      displayName: "Gemini Models",
      description: "Gemini model family",
      buckets: [
        { bucketId: "gemini-weekly", displayName: "Weekly", window: "weekly", remainingFraction: 0.58, resetTime: "2026-06-22T00:00:00Z" },
        { bucketId: "gemini-5h", displayName: "5 Hour", window: "5h", remainingFraction: 0.25, remainingAmount: "1234" },
      ],
    },
    {
      displayName: "Claude and GPT models",
      description: "Third-party model family",
      buckets: [
        { bucketId: "3p-weekly", displayName: "Weekly", window: "weekly", remainingFraction: 1, resetTime: "2026-06-22T00:00:00Z" },
        { bucketId: "3p-5h", displayName: "5 Hour", window: "5h", remainingFraction: 0.9, remainingAmount: "50" },
      ],
    },
  ],
};

describe("google agy logic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readAuthFileCached.mockResolvedValue(null);
    mocks.fetchWithTimeout.mockResolvedValue(mockJsonResponse({ groups: [] }));
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

    let resolved = resolveAgyAccounts(auth, "configured-project");
    expect(resolved[0].projectId).toBe("managed-project-entry");

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

  it("calls retrieveUserQuotaSummary and returns merged summaryGroups", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      "google-agy": {
        type: "oauth",
        refresh: "refresh-token-1|project-1",
        email: "alice@example.com",
      },
    });
    mocks.getCachedAccessToken.mockResolvedValueOnce({ accessToken: "cached-token" });
    mocks.fetchWithTimeout.mockResolvedValueOnce(
      mockJsonResponse(SUMMARY_RESPONSE),
    );

    const result = await queryGoogleAgyQuota();
    expect(result).toMatchObject({ success: true });
    if (!result || !result.success) {
      throw new Error("expected success");
    }
    expect(result.summaryGroups).toHaveLength(2);
    expect(result.summaryGroups[0].displayName).toBe("Gemini Models");
    expect(result.summaryGroups[1].displayName).toBe("Claude and GPT models");
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
        groups: [
          {
            displayName: "Gemini Models",
            buckets: [
              { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.5 },
              { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.5 },
            ],
          },
        ],
      })
    );

    const result = await queryGoogleAgyQuota();
    expect(result).toMatchObject({ success: true });
    if (!result || !result.success) {
      throw new Error("expected success");
    }
    expect(result.summaryGroups).toHaveLength(1);
    expect(result.summaryGroups[0].buckets[0].remainingFraction).toBe(0.5);
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
    mocks.fetchWithTimeout.mockResolvedValueOnce(mockJsonResponse({ groups: [] }));

    await queryGoogleAgyQuota();

    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
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

  it("merges summaryGroups across accounts keeping minimum remainingFraction", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      "google-agy": {
        type: "oauth",
        refresh: "refresh-token-1|project-1",
        email: "alice@example.com",
      },
      "google-agy-auth": {
        type: "oauth",
        refresh: "refresh-token-2|project-2",
        email: "bob@example.com",
      },
    });
    mocks.getCachedAccessToken.mockResolvedValue({ accessToken: "cached-token" });

    mocks.fetchWithTimeout.mockResolvedValueOnce(
      mockJsonResponse({
        groups: [
          {
            displayName: "Gemini Models",
            buckets: [
              { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.8, resetTime: "2026-06-22T00:00:00Z" },
              { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.6 },
            ],
          },
        ],
      }),
    );
    mocks.fetchWithTimeout.mockResolvedValueOnce(
      mockJsonResponse({
        groups: [
          {
            displayName: "Gemini Models",
            buckets: [
              { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.3, resetTime: "2026-06-21T00:00:00Z" },
              { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.9 },
            ],
          },
        ],
      }),
    );

    const result = await queryGoogleAgyQuota();
    expect(result).toMatchObject({ success: true });
    if (!result || !result.success) {
      throw new Error("expected success");
    }
    expect(result.summaryGroups).toHaveLength(1);
    const geminiWeekly = result.summaryGroups[0].buckets.find((b) => b.bucketId === "gemini-weeky") || result.summaryGroups[0].buckets[0];
    expect(geminiWeekly.remainingFraction).toBeLessThanOrEqual(0.3);
  });
});
