import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readAuthFileCached: vi.fn(),
  fetchWithTimeout: vi.fn(),
  getCachedAccessToken: vi.fn(),
  makeAccountCacheKey: vi.fn(),
  setCachedAccessToken: vi.fn(),
  inspectGeminiCliCompanionPresence: vi.fn(),
  resolveGeminiCliClientCredentials: vi.fn(),
  clearGeminiCliCompanionCacheForTests: vi.fn(),
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

vi.mock("../src/lib/google-gemini-cli-companion.js", () => ({
  inspectGeminiCliCompanionPresence: mocks.inspectGeminiCliCompanionPresence,
  resolveGeminiCliClientCredentials: mocks.resolveGeminiCliClientCredentials,
  clearGeminiCliCompanionCacheForTests: mocks.clearGeminiCliCompanionCacheForTests,
}));

import {
  DEFAULT_GEMINI_CLI_AUTH_CACHE_MAX_AGE_MS,
  inspectGeminiCliAuthPresence,
  parseGeminiCliRefreshParts,
  queryGeminiCliQuota,
  resolveGeminiCliAccounts,
  resolveGeminiCliConfiguredProjectId,
} from "../src/lib/google-gemini-cli.js";

function mockJsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

describe("gemini cli auth resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readAuthFileCached.mockResolvedValue(null);
    mocks.fetchWithTimeout.mockResolvedValue(mockJsonResponse({ buckets: [] }));
    mocks.getCachedAccessToken.mockResolvedValue({ accessToken: "cached-access-token" });
    mocks.makeAccountCacheKey.mockReturnValue("test-cache-key");
    mocks.resolveGeminiCliClientCredentials.mockResolvedValue({
      state: "configured",
      clientId: "client-id",
      clientSecret: "client-secret",
    });
    delete process.env.OPENCODE_GEMINI_PROJECT_ID;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GOOGLE_CLOUD_PROJECT_ID;
  });

  it("parses opencode-gemini-auth packed refresh strings", () => {
    expect(parseGeminiCliRefreshParts("refresh-token|project-1|managed-project")).toEqual({
      refreshToken: "refresh-token",
      projectId: "project-1",
      managedProjectId: "managed-project",
    });
  });

  it("resolves the canonical Gemini CLI auth entry before compatibility keys", () => {
    expect(
      resolveGeminiCliAccounts({
        "google-gemini-cli": {
          type: "oauth",
          refresh: "canonical-refresh|canonical-project|",
          email: "alice@example.com",
        },
        google: {
          type: "oauth",
          refresh: "google-refresh|google-project|",
          email: "bob@example.com",
        },
      })[0],
    ).toEqual({
      sourceKey: "google-gemini-cli",
      refreshToken: "canonical-refresh",
      projectId: "canonical-project",
      email: "alice@example.com",
    });
  });

  it("supports the upstream opencode-gemini-auth google auth key", () => {
    expect(
      resolveGeminiCliAccounts({
        google: {
          type: "oauth",
          refresh: "refresh-token|project-1|managed-project",
          email: "user@example.com",
          access: "access-token",
          expires: 123,
        },
      }),
    ).toEqual([
      {
        sourceKey: "google",
        refreshToken: "refresh-token",
        projectId: "project-1",
        email: "user@example.com",
        accessToken: "access-token",
        expiresAt: 123,
      },
    ]);
  });

  it("deduplicates identical credentials stored under compatibility keys", () => {
    expect(
      resolveGeminiCliAccounts({
        "gemini-cli": { type: "oauth", refresh: "refresh-token|project-1|", email: "a@example.com" },
        google: { type: "oauth", refresh: "refresh-token|project-1|", email: "a@example.com" },
      }),
    ).toEqual([
      {
        sourceKey: "gemini-cli",
        refreshToken: "refresh-token",
        projectId: "project-1",
        email: "a@example.com",
      },
    ]);
  });

  it("uses configured project id fallback when auth refresh has only a token", () => {
    expect(
      resolveGeminiCliAccounts(
        {
          "gemini-cli": { type: "oauth", refresh: "refresh-token" },
        },
        "configured-project",
      ),
    ).toEqual([
      {
        sourceKey: "gemini-cli",
        refreshToken: "refresh-token",
        projectId: "configured-project",
      },
    ]);
  });

  it("prefers explicit OpenCode provider config over generic Google project env vars", async () => {
    process.env.GOOGLE_CLOUD_PROJECT = "generic-shell-project";

    await expect(
      resolveGeminiCliConfiguredProjectId({
        config: {
          get: async () => ({
            data: {
              provider: {
                google: { options: { projectId: "configured-opencode-project" } },
              },
            },
          }),
        },
      }),
    ).resolves.toBe("configured-opencode-project");
  });

  it("keeps OPENCODE_GEMINI_PROJECT_ID as the highest-priority project override", async () => {
    process.env.OPENCODE_GEMINI_PROJECT_ID = "explicit-gemini-project";
    process.env.GOOGLE_CLOUD_PROJECT = "generic-shell-project";

    await expect(
      resolveGeminiCliConfiguredProjectId({
        config: {
          get: async () => ({
            data: {
              provider: {
                google: { options: { projectId: "configured-opencode-project" } },
              },
            },
          }),
        },
      }),
    ).resolves.toBe("explicit-gemini-project");
  });

  it("reports invalid auth when OAuth exists but no project id can be resolved", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      google: { type: "oauth", refresh: "refresh-token" },
    });

    await expect(inspectGeminiCliAuthPresence()).resolves.toMatchObject({
      state: "invalid",
      sourceKey: "google",
      accountCount: 1,
      validAccountCount: 0,
    });
    expect(mocks.readAuthFileCached).toHaveBeenCalledWith({
      maxAgeMs: DEFAULT_GEMINI_CLI_AUTH_CACHE_MAX_AGE_MS,
    });
  });

  it("aggregates known Gemini CLI buckets by quality tier and keeps unknown models", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      google: {
        type: "oauth",
        refresh: "refresh-token|project-1|",
        email: "alice@example.com",
      },
    });
    mocks.fetchWithTimeout.mockResolvedValueOnce(
      mockJsonResponse({
        buckets: [
          {
            modelId: "gemini-3.1-pro-preview",
            remainingFraction: 0.8,
            resetTime: "2026-01-01T10:00:00.000Z",
            remainingAmount: "100",
            tokenType: "REQUESTS",
          },
          {
            modelId: "gemini-2.5-pro",
            remainingFraction: 0.2,
            resetTime: "2026-01-01T12:00:00.000Z",
            remainingAmount: "50",
            tokenType: "TOKENS",
          },
          {
            modelId: "gemini-2.5-flash",
            remainingFraction: 0.5,
            resetTime: "2026-01-01T08:00:00.000Z",
            remainingAmount: "1000",
            tokenType: "REQUESTS",
          },
          {
            modelId: "gemini_2_5_flash_lite",
            remainingFraction: 0.1,
            remainingAmount: "25",
          },
          {
            modelId: "gemini-experimental-foo",
            remainingFraction: 0.7,
          },
          {
            remainingFraction: 0.01,
          },
        ],
      }),
    );

    const result = await queryGeminiCliQuota();

    expect(result).toMatchObject({ success: true });
    if (!result || !result.success) {
      throw new Error("expected successful Gemini CLI quota result");
    }
    expect(result.buckets).toEqual([
      {
        modelId: "gemini-2.5-pro",
        displayName: "Gemini Pro",
        percentRemaining: 20,
        resetTimeIso: "2026-01-01T12:00:00.000Z",
        remainingAmount: "50",
        tokenType: "TOKENS",
        accountEmail: "alice@example.com",
        sourceKey: "google",
      },
      {
        modelId: "gemini-2.5-flash",
        displayName: "Gemini Flash",
        percentRemaining: 50,
        resetTimeIso: "2026-01-01T08:00:00.000Z",
        remainingAmount: "1000",
        tokenType: "REQUESTS",
        accountEmail: "alice@example.com",
        sourceKey: "google",
      },
      {
        modelId: "gemini_2_5_flash_lite",
        displayName: "Gemini Flash Lite",
        percentRemaining: 10,
        remainingAmount: "25",
        accountEmail: "alice@example.com",
        sourceKey: "google",
      },
      {
        modelId: "gemini-experimental-foo",
        displayName: "Gemini Experimental Foo",
        percentRemaining: 70,
        accountEmail: "alice@example.com",
        sourceKey: "google",
      },
    ]);
  });

  it("does not merge Gemini CLI tier buckets across accounts", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      "google-gemini-cli": {
        type: "oauth",
        refresh: "refresh-a|project-a|",
        email: "alice@example.com",
      },
      google: {
        type: "oauth",
        refresh: "refresh-b|project-b|",
        email: "bob@example.com",
      },
    });
    mocks.fetchWithTimeout.mockImplementation(async (_url: string, options: { body?: unknown }) => {
      const body = JSON.parse(String(options.body)) as { project: string };
      return mockJsonResponse({
        buckets: [
          {
            modelId: "gemini-2.5-pro",
            remainingFraction: body.project === "project-a" ? 0.9 : 0.1,
          },
        ],
      });
    });

    const result = await queryGeminiCliQuota();

    expect(result).toMatchObject({ success: true });
    if (!result || !result.success) {
      throw new Error("expected successful Gemini CLI quota result");
    }
    expect(result.buckets).toEqual([
      {
        modelId: "gemini-2.5-pro",
        displayName: "Gemini Pro",
        percentRemaining: 90,
        accountEmail: "alice@example.com",
        sourceKey: "google-gemini-cli",
      },
      {
        modelId: "gemini-2.5-pro",
        displayName: "Gemini Pro",
        percentRemaining: 10,
        accountEmail: "bob@example.com",
        sourceKey: "google",
      },
    ]);
  });
});
