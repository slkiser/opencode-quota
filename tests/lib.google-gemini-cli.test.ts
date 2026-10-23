// Gemini CLI quota parsing, with the companion plugin installed in a temp package cache and each
// login's own unexpired token. The OAuth flow it shares with Google AGY is in
// lib.google-agy.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { geminiCliCompanion } from "../src/lib/google-companion-credentials.js";
import { GEMINI_CLI_FLAVOR } from "../src/lib/google-gemini-cli.js";
import { queryGoogleQuota } from "../src/lib/google-oauth-quota.js";
import { NO_PROJECT_DIRECTORY } from "./helpers/opencode-folders.js";
import { useProviderWorld } from "./helpers/provider-fetch.js";

const world = useProviderWorld();
/**
 * The Gemini CLI query of the one login in `logins`, written as `{ integration id: value }`; the
 * login holds an unexpired access token, so no token refresh is asked.
 */
function queryGeminiCliQuota(logins: Record<string, Record<string, unknown>>) {
  const [[integrationId, stored]] = Object.entries(logins);
  const value = { access: "login-access-token", expires: Date.now() + 3_600_000, ...stored };
  return queryGoogleQuota(GEMINI_CLI_FLAVOR, {
    login: { id: "login", integrationId, label: "", active: true, value },
    directory: NO_PROJECT_DIRECTORY,
  });
}

/** The quota reply, as each `fetch` answers. */
const fetchResponse = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();

function quotaResponse(buckets: unknown[]) {
  return Response.json({ buckets });
}

describe("Gemini CLI quota buckets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    world.writeCacheFile(
      "node_modules/opencode-gemini-auth/src/constants.ts",
      'export const GEMINI_CLIENT_ID = "client-id";\nexport const GEMINI_CLIENT_SECRET = "client-secret";\n',
    );
    geminiCliCompanion.clearCacheForTests();
    vi.stubGlobal(
      "fetch",
      vi.fn((url: RequestInfo | URL, init: RequestInit = {}) => fetchResponse(String(url), init)),
    );
    // Set, so the configured-project lookup never reads a real OpenCode config.
    vi.stubEnv("OPENCODE_GEMINI_PROJECT_ID", "env-project");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it("aggregates known Gemini CLI buckets by quality tier and keeps unknown models", async () => {
    const auth = {
      google: {
        type: "oauth",
        refresh: "refresh-token|project-1|",
        email: "alice@example.com",
      },
    };
    fetchResponse.mockResolvedValueOnce(
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
    fetchResponse.mockResolvedValueOnce(Response.json({ buckets: {} }));

    await expect(queryGeminiCliQuota(auth)).resolves.toEqual({
      success: false,
      error: "buckets.filter is not a function",
    });
  });

  it("reports no data when the account answers without buckets", async () => {
    const auth = {
      google: { type: "oauth", refresh: "refresh-token|project-1" },
    };
    fetchResponse.mockResolvedValueOnce(quotaResponse([]));

    await expect(queryGeminiCliQuota(auth)).resolves.toEqual({
      success: false,
      error: "No Gemini CLI quota data available",
    });
  });
});
