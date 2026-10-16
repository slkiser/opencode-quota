// Gemini CLI quota parsing. The OAuth flow it shares with Google AGY is in lib.google-agy.test.ts.
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ fetchResponse: vi.fn() }));

vi.mock("../src/lib/http.js", () => ({
  fetchWithTimeout: async (
    url: string,
    options: { request: RequestInit; consume: (response: unknown) => Promise<unknown> },
  ) => options.consume(await mocks.fetchResponse(url, options.request)),
}));
vi.mock("../src/lib/google-token-cache.js", () => ({
  makeAccountCacheKey: () => "cache-key",
  getCachedAccessToken: async () => ({ accessToken: "cached-access-token" }),
  setCachedAccessToken: async () => undefined,
}));
vi.mock("../src/lib/google-companion-credentials.js", () => ({
  geminiCliCompanion: {
    resolveCredentials: async () => ({
      state: "configured",
      clientId: "client-id",
      clientSecret: "client-secret",
    }),
  },
}));

import { GEMINI_CLI_FLAVOR } from "../src/lib/google-gemini-cli.js";
import { queryGoogleQuota } from "../src/lib/google-oauth-quota.js";
import type { AuthData } from "../src/lib/types.js";

/** The Gemini CLI query of the logins in `authData`. */
function queryGeminiCliQuota(authData: unknown) {
  return queryGoogleQuota(GEMINI_CLI_FLAVOR, { authData: authData as AuthData });
}

function quotaResponse(buckets: unknown[]) {
  return { ok: true, status: 200, json: async () => ({ buckets }) };
}

describe("Gemini CLI quota buckets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Set, so the configured-project lookup never reads a real OpenCode config.
    vi.stubEnv("OPENCODE_GEMINI_PROJECT_ID", "env-project");
  });

  it("aggregates known Gemini CLI buckets by quality tier and keeps unknown models", async () => {
    const auth = {
      google: {
        type: "oauth",
        refresh: "refresh-token|project-1|",
        email: "alice@example.com",
      },
    };
    mocks.fetchResponse.mockResolvedValueOnce(
      quotaResponse([
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
        { modelId: "gemini_2_5_flash_lite", remainingFraction: 0.1, remainingAmount: "25" },
        { modelId: "gemini-experimental-foo", remainingFraction: 0.7 },
        { remainingFraction: 0.01 },
      ]),
    );

    await expect(queryGeminiCliQuota(auth)).resolves.toEqual({
      success: true,
      buckets: [
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
      ],
    });
  });

  it("reports a bucket object that is not a list as that account's error", async () => {
    const auth = {
      google: { type: "oauth", refresh: "refresh-token|project-1|", email: "alice@example.com" },
    };
    mocks.fetchResponse.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ buckets: {} }),
    });

    await expect(queryGeminiCliQuota(auth)).resolves.toEqual({
      success: false,
      error: "buckets.filter is not a function",
    });
  });

  it("reports no data when the account answers without buckets", async () => {
    const auth = {
      google: { type: "oauth", refresh: "refresh-token|project-1" },
    };
    mocks.fetchResponse.mockResolvedValueOnce(quotaResponse([]));

    await expect(queryGeminiCliQuota(auth)).resolves.toEqual({
      success: false,
      error: "No Gemini CLI quota data available",
    });
  });
});
