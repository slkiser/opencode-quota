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

function summaryResponse(
  params: {
    geminiWeekly?: number;
    geminiFiveHour?: number;
    thirdPartyWeekly?: number;
    thirdPartyFiveHour?: number;
  } = {},
) {
  return {
    groups: [
      {
        displayName: "Gemini Models",
        description: "Gemini model family",
        buckets: [
          {
            bucketId: "gemini-weekly",
            displayName: "Weekly",
            window: "WEEKLY",
            remainingFraction: params.geminiWeekly ?? 0.58,
            resetTime: "2026-06-22T00:00:00Z",
          },
          {
            bucketId: "gemini-five-hour",
            displayName: "Five Hour",
            window: "FIVE_HOUR",
            remainingFraction: params.geminiFiveHour ?? 0.25,
            remainingAmount: "1234",
          },
        ],
      },
      {
        displayName: "Claude and GPT models",
        description: "Third-party model family",
        buckets: [
          {
            bucketId: "third-party-weekly",
            displayName: "Weekly",
            window: "WEEKLY",
            remainingFraction: params.thirdPartyWeekly ?? 1,
            resetTime: "2026-06-23T00:00:00Z",
          },
          {
            bucketId: "third-party-five-hour",
            displayName: "Five Hour",
            window: "FIVE_HOUR",
            remainingFraction: params.thirdPartyFiveHour ?? 0.9,
            remaining: "50",
          },
        ],
      },
    ],
  };
}

function authAccount(
  refreshToken: string,
  projectId: string,
  email?: string,
  extra: Record<string, unknown> = {},
) {
  return {
    type: "oauth",
    refresh: `${refreshToken}|${projectId}`,
    ...(email ? { email } : {}),
    ...extra,
  };
}

describe("google agy logic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readAuthFileCached.mockResolvedValue(null);
    mocks.fetchWithTimeout.mockResolvedValue(mockJsonResponse({ groups: [] }));
    mocks.getCachedAccessToken.mockResolvedValue({ accessToken: "cached-access-token" });
    mocks.makeAccountCacheKey.mockImplementation(
      ({ projectId }: { projectId: string }) => `cache-${projectId}`,
    );
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

  it("parses packed refresh strings", () => {
    expect(parseAgyRefreshParts("refresh-token|project-1|managed-project")).toEqual({
      refreshToken: "refresh-token",
      projectId: "project-1",
      managedProjectId: "managed-project",
    });
  });

  it("resolves the configured project id with existing precedence", async () => {
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

  it("preserves auth-key order, project precedence, and duplicate suppression", () => {
    const auth = {
      "google-agy": {
        type: "oauth" as const,
        refresh: "refresh-token-1|packed-project|packed-managed",
        managedProjectId: "entry-managed",
        quotaProjectId: "entry-quota",
        projectId: "entry-project",
        email: "alice@example.com",
      },
      "opencode-agy-auth": {
        type: "oauth" as const,
        refresh: "refresh-token-1|packed-project|packed-managed",
        managedProjectId: "entry-managed",
        email: "duplicate@example.com",
      },
      "google-agy-auth": authAccount("refresh-token-2", "project-2", "bob@example.com"),
    };

    const resolved = resolveAgyAccounts(auth, "configured-project");
    expect(resolved).toHaveLength(2);
    expect(resolved[0]).toEqual({
      sourceKey: "google-agy",
      refreshToken: "refresh-token-1",
      projectId: "entry-managed",
      email: "alice@example.com",
    });
    expect(resolved[1]).toMatchObject({
      sourceKey: "google-agy-auth",
      refreshToken: "refresh-token-2",
      projectId: "project-2",
    });
  });

  it("preserves every project-id precedence tier", () => {
    const resolveProject = (entry: Record<string, unknown>) =>
      resolveAgyAccounts({ "google-agy": { type: "oauth", ...entry } }, "configured-project")[0]
        ?.projectId;

    expect(
      resolveProject({
        refresh: "refresh|packed-project|packed-managed",
        managedProjectId: "entry-managed",
        quotaProjectId: "entry-quota",
      }),
    ).toBe("entry-managed");
    expect(
      resolveProject({
        refresh: "refresh|packed-project|packed-managed",
        quotaProjectId: "entry-quota",
      }),
    ).toBe("entry-quota");
    expect(resolveProject({ refresh: "refresh|packed-project|packed-managed" })).toBe(
      "packed-managed",
    );
    expect(resolveProject({ refresh: "refresh|packed-project", projectId: "entry-project" })).toBe(
      "entry-project",
    );
    expect(
      resolveProject({ refresh: "refresh|packed-project", projectID: "entry-project-id" }),
    ).toBe("entry-project-id");
    expect(resolveProject({ refresh: "refresh|packed-project" })).toBe("packed-project");
    expect(resolveProject({ refresh: "refresh" })).toBe("configured-project");
  });

  it("returns an actionable error when companion credentials are unavailable", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      "google-agy": authAccount("refresh-token", "project-1", "alice@example.com"),
    });
    mocks.resolveAgyClientCredentials.mockResolvedValueOnce({
      state: "missing",
      error: "Companion plugin is missing",
    });

    await expect(queryGoogleAgyQuota()).resolves.toEqual({
      success: false,
      error: "Companion plugin is missing",
    });
  });

  it("requests the fixed summary endpoint with the existing request contract", async () => {
    process.env.OPENCODE_AGY_ENDPOINT = "https://untrusted.example";
    mocks.readAuthFileCached.mockResolvedValueOnce({
      "google-agy": authAccount("refresh-token", "project-1", "alice@example.com"),
    });
    mocks.fetchWithTimeout.mockResolvedValueOnce(mockJsonResponse(summaryResponse()));

    const result = await queryGoogleAgyQuota(undefined, { requestTimeoutMs: 12_345 });
    expect(result).toMatchObject({ success: true });

    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cached-access-token",
          "User-Agent": "antigravity/cli/1.0.3 darwin/amd64",
          "x-activity-request-id": expect.any(String),
        },
        body: JSON.stringify({ project: "project-1" }),
      },
      12_345,
    );
  });

  it("normalizes grouped weekly and five-hour buckets with canonical family labels", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      "google-agy": authAccount("refresh-token", "project-1", "alice@example.com"),
    });
    mocks.fetchWithTimeout.mockResolvedValueOnce(mockJsonResponse(summaryResponse()));

    const result = await queryGoogleAgyQuota();
    expect(result).toMatchObject({ success: true });
    if (!result || !result.success) throw new Error("expected success");

    expect(
      result.buckets.map(({ family, window, windowLabel, percentRemaining, remainingAmount }) => ({
        family,
        window,
        windowLabel,
        percentRemaining,
        remainingAmount,
      })),
    ).toEqual([
      {
        family: "Gemini Models",
        window: "weekly",
        windowLabel: "Weekly",
        percentRemaining: 58,
        remainingAmount: undefined,
      },
      {
        family: "Gemini Models",
        window: "five_hour",
        windowLabel: "5h",
        percentRemaining: 25,
        remainingAmount: "1234",
      },
      {
        family: "Claude and GPT models",
        window: "weekly",
        windowLabel: "Weekly",
        percentRemaining: 100,
        remainingAmount: undefined,
      },
      {
        family: "Claude and GPT models",
        window: "five_hour",
        windowLabel: "5h",
        percentRemaining: 90,
        remainingAmount: "50",
      },
    ]);
    expect(result.buckets.every((bucket) => bucket.accountEmail === "alice@example.com")).toBe(
      true,
    );
    expect(result.buckets.every((bucket) => bucket.accountKey.length === 64)).toBe(true);
    expect(result.buckets.every((bucket) => bucket.sourceKey === "google-agy")).toBe(true);
  });

  it("uses top-level buckets only when grouped buckets are not usable", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      "google-agy": authAccount("refresh-token", "project-1"),
    });
    mocks.fetchWithTimeout.mockResolvedValueOnce(
      mockJsonResponse({
        description: "Fallback family",
        groups: [{ displayName: "Gemini Models", buckets: [{ window: "DAILY" }] }],
        buckets: [
          {
            bucketId: "fallback-weekly",
            window: "weekly",
            remainingFraction: 0.4,
          },
          {
            bucketId: "fallback-five-hour",
            window: "5h",
            remainingFraction: 0.7,
          },
        ],
      }),
    );

    const result = await queryGoogleAgyQuota();
    expect(result).toMatchObject({ success: true });
    if (!result || !result.success) throw new Error("expected success");
    expect(result.buckets.map((bucket) => [bucket.family, bucket.window])).toEqual([
      ["Fallback family", "weekly"],
      ["Fallback family", "five_hour"],
    ]);
  });

  it("filters disabled, malformed, and unsupported summary rows", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      "google-agy": authAccount("refresh-token", "project-1"),
    });
    mocks.fetchWithTimeout.mockResolvedValueOnce(
      mockJsonResponse({
        groups: [
          {
            displayName: "Gemini Models",
            buckets: [
              {
                bucketId: "disabled",
                window: "WEEKLY",
                remainingFraction: 0.1,
                disabled: true,
              },
              { bucketId: "missing-fraction", window: "FIVE_HOUR" },
              { bucketId: "non-finite", window: "FIVE_HOUR", remainingFraction: Number.NaN },
              { bucketId: "unsupported", window: "DAILY", remainingFraction: 0.5 },
            ],
          },
          {
            displayName: " ",
            buckets: [{ bucketId: "missing-family", window: "WEEKLY", remainingFraction: 0.5 }],
          },
        ],
      }),
    );

    await expect(queryGoogleAgyQuota()).resolves.toEqual({
      success: true,
      buckets: [],
      errors: [{ email: "google-agy", error: "Quota summary API unavailable" }],
    });
  });

  it("keeps the most constrained truly duplicate summary identity", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      "google-agy": authAccount("refresh-token", "project-1"),
    });
    mocks.fetchWithTimeout.mockResolvedValueOnce(
      mockJsonResponse({
        groups: [
          {
            displayName: "Gemini Models",
            buckets: [
              {
                bucketId: "same-weekly",
                window: "WEEKLY",
                remainingFraction: 0.8,
                resetTime: "2026-06-24T00:00:00Z",
              },
              {
                bucketId: "same-weekly",
                window: "WEEKLY",
                remainingFraction: 0.3,
                resetTime: "2026-06-21T00:00:00Z",
              },
              {
                bucketId: "different-weekly",
                window: "WEEKLY",
                remainingFraction: 0.6,
              },
            ],
          },
        ],
      }),
    );

    const result = await queryGoogleAgyQuota();
    expect(result).toMatchObject({ success: true });
    if (!result || !result.success) throw new Error("expected success");
    expect(result.buckets).toHaveLength(2);
    expect(result.buckets.find((bucket) => bucket.bucketId === "same-weekly")).toMatchObject({
      percentRemaining: 30,
      resetTimeIso: "2026-06-21T00:00:00.000Z",
    });
  });

  it("preserves an explicit zero fraction and ignores an invalid reset time", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      "google-agy": authAccount("refresh-token", "project-1"),
    });
    mocks.fetchWithTimeout.mockResolvedValueOnce(
      mockJsonResponse({
        groups: [
          {
            displayName: "Gemini Models",
            buckets: [
              {
                bucketId: "zero-weekly",
                window: "WEEKLY",
                remainingFraction: 0,
                resetTime: "not-a-date",
              },
            ],
          },
        ],
      }),
    );

    const result = await queryGoogleAgyQuota();
    expect(result).toMatchObject({ success: true });
    if (!result || !result.success) throw new Error("expected success");
    expect(result.buckets).toEqual([
      expect.objectContaining({
        bucketId: "zero-weekly",
        percentRemaining: 0,
      }),
    ]);
    expect(result.buckets[0]).not.toHaveProperty("resetTimeIso");
  });

  it("reuses an unexpired auth-entry access token without refreshing it", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      "google-agy": authAccount("refresh-token", "project-1", "alice@example.com", {
        access: "auth-entry-access",
        expires: Date.now() + 60 * 60_000,
      }),
    });
    mocks.getCachedAccessToken.mockResolvedValueOnce(null);
    mocks.fetchWithTimeout.mockResolvedValueOnce(mockJsonResponse(summaryResponse()));

    await expect(queryGoogleAgyQuota()).resolves.toMatchObject({ success: true });
    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(1);
    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      expect.stringContaining("retrieveUserQuotaSummary"),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer auth-entry-access" }),
      }),
      expect.any(Number),
    );
  });

  it("refreshes a missing token and retries exactly once after a 401", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      "google-agy": authAccount("refresh-token", "project-1", "alice@example.com"),
    });
    mocks.getCachedAccessToken.mockResolvedValueOnce(null);
    mocks.fetchWithTimeout
      .mockResolvedValueOnce(
        mockJsonResponse({ access_token: "new-access-token", expires_in: 3600 }),
      )
      .mockResolvedValueOnce(mockJsonResponse({}, 401))
      .mockResolvedValueOnce(
        mockJsonResponse({ access_token: "retry-access-token", expires_in: 3600 }),
      )
      .mockResolvedValueOnce(mockJsonResponse(summaryResponse({ geminiWeekly: 0.5 })));

    const result = await queryGoogleAgyQuota();
    expect(result).toMatchObject({ success: true });
    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(4);
    expect(mocks.fetchWithTimeout.mock.calls.map(([url]) => url)).toEqual([
      "https://oauth2.googleapis.com/token",
      "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
      "https://oauth2.googleapis.com/token",
      "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
    ]);
    expect(mocks.setCachedAccessToken).toHaveBeenCalledTimes(2);
  });

  it("preserves account input order when requests complete in reverse order", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      "google-agy": authAccount("refresh-1", "project-1", "alice@example.com"),
      "google-agy-auth": authAccount("refresh-2", "project-2", "bob@example.com"),
    });
    mocks.fetchWithTimeout.mockImplementation(async (_url: string, init: { body?: string }) => {
      const project = JSON.parse(init.body ?? "{}").project;
      if (project === "project-1") {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return mockJsonResponse(summaryResponse({ geminiWeekly: 0.2 }));
      }
      return mockJsonResponse(summaryResponse({ geminiWeekly: 0.8 }));
    });

    const result = await queryGoogleAgyQuota();
    expect(result).toMatchObject({ success: true });
    if (!result || !result.success) throw new Error("expected success");
    expect([...new Set(result.buckets.map((bucket) => bucket.accountEmail))]).toEqual([
      "alice@example.com",
      "bob@example.com",
    ]);
    expect(result.buckets.map((bucket) => bucket.accountIndex)).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
    const activityIds = mocks.fetchWithTimeout.mock.calls.map(
      ([, init]) => init.headers["x-activity-request-id"],
    );
    expect(new Set(activityIds).size).toBe(2);
  });

  it("limits account quota requests to three in flight", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      "google-agy": authAccount("refresh-1", "project-1"),
      "opencode-agy-auth": authAccount("refresh-2", "project-2"),
      "google-agy-auth": authAccount("refresh-3", "project-3"),
    });
    let inFlight = 0;
    let maxInFlight = 0;
    mocks.fetchWithTimeout.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight -= 1;
      return mockJsonResponse(summaryResponse());
    });

    const result = await queryGoogleAgyQuota();
    expect(result).toMatchObject({ success: true });
    expect(maxInFlight).toBe(3);
  });

  it("returns successful accounts together with sibling account errors", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      "google-agy": authAccount("refresh-1", "project-1", "alice@example.com"),
      "google-agy-auth": authAccount("refresh-2", "project-2", "bob@example.com"),
    });
    mocks.fetchWithTimeout.mockImplementation(async (_url: string, init: { body?: string }) => {
      const project = JSON.parse(init.body ?? "{}").project;
      return project === "project-1"
        ? mockJsonResponse(summaryResponse())
        : mockJsonResponse({}, 500);
    });

    const result = await queryGoogleAgyQuota();
    expect(result).toMatchObject({
      success: true,
      errors: [{ email: "bob@example.com", error: "Google AGY quota API error: 500" }],
    });
    if (!result || !result.success) throw new Error("expected success");
    expect(result.buckets).toHaveLength(4);
  });

  it("reports an empty sibling summary as a partial failure", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      "google-agy": authAccount("refresh-1", "project-1", "alice@example.com"),
      "google-agy-auth": authAccount("refresh-2", "project-2", "bob@example.com"),
    });
    mocks.fetchWithTimeout.mockImplementation(async (_url: string, init: { body?: string }) => {
      const project = JSON.parse(init.body ?? "{}").project;
      return project === "project-1"
        ? mockJsonResponse(summaryResponse())
        : mockJsonResponse({ groups: [] });
    });

    const result = await queryGoogleAgyQuota();
    expect(result).toMatchObject({
      success: true,
      errors: [{ email: "bob@example.com", error: "Quota summary API unavailable" }],
    });
    if (!result || !result.success) throw new Error("expected success");
    expect(result.buckets).toHaveLength(4);
  });

  it("returns an aggregate success containing errors when every account fails", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      "google-agy": authAccount("refresh-1", "project-1", "alice@example.com"),
      "google-agy-auth": authAccount("refresh-2", "project-2", "bob@example.com"),
    });
    mocks.fetchWithTimeout.mockResolvedValue(mockJsonResponse({}, 500));

    await expect(queryGoogleAgyQuota()).resolves.toEqual({
      success: true,
      buckets: [],
      errors: [
        { email: "alice@example.com", error: "Google AGY quota API error: 500" },
        { email: "bob@example.com", error: "Google AGY quota API error: 500" },
      ],
    });
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
});
