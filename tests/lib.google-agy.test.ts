// The OAuth quota flow shared by Google AGY and Gemini CLI (src/lib/google-oauth-quota.ts),
// run for both flavors, plus the AGY quota-summary parsing.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => {
  const fetchResponse = vi.fn();
  const companion = () => ({
    inspect: vi.fn(),
    resolveCredentials: vi.fn(),
    clearCacheForTests: vi.fn(),
  });
  return {
    fetchResponse,
    getCachedAccessToken: vi.fn(),
    setCachedAccessToken: vi.fn(),
    agyCompanion: companion(),
    geminiCliCompanion: companion(),
  };
});

vi.mock("../src/lib/google-token-cache.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/google-token-cache.js")>()),
  getCachedAccessToken: mocks.getCachedAccessToken,
  setCachedAccessToken: mocks.setCachedAccessToken,
}));
vi.mock("../src/lib/google-companion-credentials.js", () => ({
  agyCompanion: mocks.agyCompanion,
  geminiCliCompanion: mocks.geminiCliCompanion,
}));

import { AGY_FLAVOR } from "../src/lib/google-agy.js";
import { GEMINI_CLI_FLAVOR } from "../src/lib/google-gemini-cli.js";
import {
  inspectGoogleAuthPresence,
  queryGoogleQuota,
  resolveGoogleAccounts,
  resolveGoogleConfiguredProjectId,
} from "../src/lib/google-oauth-quota.js";
import type { CredentialRow } from "../src/lib/opencode-auth.js";
import type { AuthData } from "../src/lib/types.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** A reply that never comes: the request times out. */
const NO_REPLY = Symbol("no reply");

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status });
}

function notJsonResponse(status: number) {
  return new Response("Unexpected token", { status });
}

/** Each `fetch` takes the next `mocks.fetchResponse` answer; NO_REPLY waits for the abort. */
function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL, init: RequestInit = {}) => {
      const answer = await mocks.fetchResponse(String(url), init);
      if (answer !== NO_REPLY) return answer;
      return await new Promise<Response>((_resolve, reject) =>
        init.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    }),
  );
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

/** One stored login of `integrationId`, as the login list holds it. */
function login(
  integrationId: string,
  value: Record<string, unknown>,
  resolveError?: string,
): CredentialRow {
  return {
    id: `${integrationId}-login`,
    integrationId,
    label: "",
    active: true,
    value,
    ...(resolveError ? { resolveError } : {}),
  };
}

function queryAgy(authData: unknown, options: { requestTimeoutMs?: number } = {}) {
  return queryGoogleQuota(AGY_FLAVOR, { ...options, authData: authData as AuthData });
}

function queryGeminiCli(authData: unknown, options: { requestTimeoutMs?: number } = {}) {
  return queryGoogleQuota(GEMINI_CLI_FLAVOR, { ...options, authData: authData as AuthData });
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

const FLAVORS = [
  {
    name: "Google AGY",
    providerId: "google-agy",
    // First, a middle compatibility key, and the last key, in lookup order.
    keys: ["google-agy", "opencode-agy-auth", "google-agy-auth"],
    projectEnvVar: "OPENCODE_AGY_PROJECT_ID",
    configProvider: "google-agy",
    quotaUrl: "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
    quotaHeaders: {
      "User-Agent": "antigravity/cli/1.3.5 darwin/amd64",
      "x-activity-request-id": expect.stringMatching(/^[0-9a-f-]{36}$/),
    },
    quotaResponse: summaryResponse(),
    companion: mocks.agyCompanion,
    missingCompanionError: "Companion plugin is missing",
    failedLoginState: "invalid",
    query: queryAgy,
    resolveProjectId: () => resolveGoogleConfiguredProjectId(AGY_FLAVOR),
    inspectAuth: (rows: CredentialRow[]) =>
      inspectGoogleAuthPresence(AGY_FLAVOR, { rows, configuredProjectId: undefined }),
  },
  {
    name: "Gemini CLI",
    providerId: "google-gemini-cli",
    keys: ["google-gemini-cli", "opencode-gemini-auth", "google"],
    projectEnvVar: "OPENCODE_GEMINI_PROJECT_ID",
    configProvider: "google",
    quotaUrl: "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
    quotaHeaders: {
      "User-Agent": `GeminiCLI/opencode-quota (${process.platform}; ${process.arch})`,
    },
    quotaResponse: { buckets: [{ modelId: "gemini-2.5-pro", remainingFraction: 0.5 }] },
    companion: mocks.geminiCliCompanion,
    missingCompanionError: "Gemini CLI requires the opencode-gemini-auth plugin",
    failedLoginState: "present",
    query: queryGeminiCli,
    resolveProjectId: () => resolveGoogleConfiguredProjectId(GEMINI_CLI_FLAVOR),
    inspectAuth: (rows: CredentialRow[]) =>
      inspectGoogleAuthPresence(GEMINI_CLI_FLAVOR, { rows, configuredProjectId: undefined }),
  },
] as const;

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "opencode-quota-google-config-"));
  vi.stubEnv("OPENCODE_CONFIG_DIR", configDir);
  for (const name of [
    "OPENCODE_AGY_PROJECT_ID",
    "OPENCODE_GEMINI_PROJECT_ID",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_PROJECT_ID",
  ]) {
    vi.stubEnv(name, undefined);
  }
  vi.clearAllMocks();
  stubFetch();
  mocks.getCachedAccessToken.mockResolvedValue({ accessToken: "cached-access-token" });
  for (const companion of [mocks.agyCompanion, mocks.geminiCliCompanion]) {
    companion.inspect.mockResolvedValue({ state: "present", resolvedPath: "/plugin" });
    companion.resolveCredentials.mockResolvedValue({
      state: "configured",
      clientId: "client-id",
      clientSecret: "client-secret",
    });
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(configDir, { recursive: true, force: true });
});

function writeGlobalConfig(config: unknown) {
  writeFileSync(join(configDir, "opencode.json"), JSON.stringify(config));
}

describe.each(FLAVORS)("$name OAuth quota flow", (flavor) => {
  const [firstKey, , lastKey] = flavor.keys;

  it("resolves the project id: env override, OpenCode config (native over legacy), GCP env", async () => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT_ID", "generic-gcp-project-id");
    await expect(flavor.resolveProjectId()).resolves.toBe("generic-gcp-project-id");

    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "generic-gcp-project");
    await expect(flavor.resolveProjectId()).resolves.toBe("generic-gcp-project");

    writeGlobalConfig({
      provider: { [flavor.configProvider]: { options: { projectId: "legacy-project" } } },
    });
    await expect(flavor.resolveProjectId()).resolves.toBe("legacy-project");

    writeGlobalConfig({
      provider: { [flavor.configProvider]: { options: { projectId: "legacy-project" } } },
      providers: { [flavor.configProvider]: { settings: { projectId: "native-project" } } },
    });
    await expect(flavor.resolveProjectId()).resolves.toBe("native-project");

    vi.stubEnv(flavor.projectEnvVar, "explicit-project");
    await expect(flavor.resolveProjectId()).resolves.toBe("explicit-project");
  });

  it("reports missing, invalid, and failed-login auth presence", async () => {
    expect(flavor.inspectAuth([])).toEqual({
      state: "missing",
      accountCount: 0,
      validAccountCount: 0,
    });

    expect(
      flavor.inspectAuth([login(lastKey, { type: "oauth", refresh: "refresh-token" })]),
    ).toEqual({
      state: "invalid",
      sourceKey: lastKey,
      accountCount: 1,
      validAccountCount: 0,
      error: `${flavor.name} OAuth auth is missing a refresh token or project id`,
    });

    // A login OpenCode could not return never becomes an account.
    const failed = login(firstKey, { type: "oauth" }, "refresh_failed: HTTP 400");
    expect(
      flavor.inspectAuth([failed, login(lastKey, authAccount("refresh-token", "project-id"))]),
    ).toEqual({ state: "present", sourceKey: lastKey, accountCount: 2, validAccountCount: 1 });

    expect(flavor.inspectAuth([failed])).toMatchObject({
      state: flavor.failedLoginState,
      sourceKey: firstKey,
      accountCount: 1,
      validAccountCount: 0,
    });
    await expect(
      flavor.query({ [firstKey]: { type: "oauth", resolveError: "refresh_failed: HTTP 400" } }),
    ).resolves.toBeNull();
    expect(mocks.fetchResponse).not.toHaveBeenCalled();
  });

  it("counts the login OpenCode uses for each auth key", () => {
    // The first login of a key is the one OpenCode uses; later ones do not change the state.
    expect(
      flavor.inspectAuth([
        login(firstKey, { type: "oauth", refresh: "refresh-token" }),
        login(firstKey, authAccount("refresh-token", "project-id")),
      ]),
    ).toMatchObject({ state: "invalid", accountCount: 1, validAccountCount: 0 });
  });

  it("returns an actionable error when companion credentials are unavailable", async () => {
    const auth = {
      [firstKey]: authAccount("refresh-token", "project-1", "alice@example.com"),
    };
    flavor.companion.resolveCredentials.mockResolvedValueOnce({
      state: "missing",
      error: "Companion plugin is missing",
    });
    await expect(flavor.query(auth)).resolves.toEqual({
      success: false,
      error: flavor.missingCompanionError,
    });

    flavor.companion.resolveCredentials.mockResolvedValueOnce({
      state: "invalid",
      error: "Companion plugin is incompatible",
    });
    await expect(flavor.query(auth)).resolves.toEqual({
      success: false,
      error: "Companion plugin is incompatible",
    });
  });

  it("requests the fixed quota endpoint with the existing request contract", async () => {
    vi.stubEnv("OPENCODE_AGY_ENDPOINT", "https://untrusted.example");
    const auth = {
      [firstKey]: authAccount("refresh-token", "project-1", "alice@example.com"),
    };
    mocks.fetchResponse.mockResolvedValueOnce(jsonResponse(flavor.quotaResponse));

    await expect(flavor.query(auth, { requestTimeoutMs: 12_345 })).resolves.toMatchObject({
      success: true,
    });
    expect(mocks.fetchResponse).toHaveBeenCalledWith(flavor.quotaUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer cached-access-token",
        ...flavor.quotaHeaders,
      },
      body: JSON.stringify({ project: "project-1" }),
      signal: expect.any(AbortSignal),
    });
  });

  it("reuses an unexpired login token, else refreshes and retries once after a 401", async () => {
    mocks.getCachedAccessToken.mockResolvedValue(null);
    const auth = {
      [firstKey]: authAccount("refresh-token", "project-1", "alice@example.com", {
        access: "auth-entry-access",
        expires: Date.now() + 60 * 60_000,
      }),
    };
    mocks.fetchResponse.mockResolvedValueOnce(jsonResponse(flavor.quotaResponse));
    await expect(flavor.query(auth)).resolves.toMatchObject({ success: true });
    expect(mocks.fetchResponse).toHaveBeenCalledOnce();
    expect(mocks.fetchResponse.mock.calls[0]?.[1].headers.Authorization).toBe(
      "Bearer auth-entry-access",
    );

    mocks.fetchResponse.mockClear();
    const auth2 = {
      [firstKey]: authAccount("refresh-token", "project-1", "alice@example.com"),
    };
    mocks.fetchResponse
      .mockResolvedValueOnce(jsonResponse({ access_token: "new-access-token", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(jsonResponse({ access_token: "retry-access-token", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse(flavor.quotaResponse));
    await expect(flavor.query(auth2)).resolves.toMatchObject({ success: true });
    expect(mocks.fetchResponse.mock.calls.map(([url]) => url)).toEqual([
      TOKEN_URL,
      flavor.quotaUrl,
      TOKEN_URL,
      flavor.quotaUrl,
    ]);
    expect(mocks.fetchResponse.mock.calls[3]?.[1].headers.Authorization).toBe(
      "Bearer retry-access-token",
    );
    expect(mocks.setCachedAccessToken).toHaveBeenLastCalledWith({
      key: expect.stringMatching(/^gat1_/),
      entry: { accessToken: "retry-access-token", expiresAt: expect.any(Number) },
    });
  });

  it.each([
    [
      "revoked grant",
      jsonResponse({ error: "invalid_grant" }, 400),
      "Token revoked",
      { code: "login_expired", status: 400 },
    ],
    [
      "error description",
      jsonResponse({ error_description: "Bad client" }, 401),
      "Bad client",
      { code: "login_expired", status: 401 },
    ],
    ["non-JSON error", notJsonResponse(500), "HTTP 500", { code: "provider_error", status: 500 }],
    ["timeout", NO_REPLY, "Token refresh timeout", { code: "timeout" }],
    ["network error", new Error("socket hang up"), "Token refresh failed", undefined],
  ])(
    "reports a failed token refresh (%s) as an account error",
    async (_case, outcome, error, facts) => {
      mocks.getCachedAccessToken.mockResolvedValue(null);
      const auth = {
        [firstKey]: authAccount("refresh", "project"),
      };
      if (outcome instanceof Error) mocks.fetchResponse.mockRejectedValueOnce(outcome);
      else mocks.fetchResponse.mockResolvedValueOnce(outcome);

      await expect(flavor.query(auth, { requestTimeoutMs: 20 })).resolves.toEqual({
        success: false,
        error,
        ...(facts ? { facts } : {}),
      });
    },
  );

  it.each([
    [
      "server error",
      [jsonResponse({}, 500)],
      `${flavor.name} quota API error: 500`,
      { code: "provider_error", status: 500 },
    ],
    [
      "auth error after the retry",
      [
        jsonResponse({}, 403),
        jsonResponse({ access_token: "retry-access-token", expires_in: 3600 }),
        jsonResponse({}, 403),
      ],
      `${flavor.name} quota auth error: 403`,
      { code: "login_expired", status: 403 },
    ],
    ["timeout", [NO_REPLY], "API timeout", { code: "timeout" }],
  ])(
    "reports a failed quota request (%s) as an account error",
    async (_case, outcomes, error, facts) => {
      const auth = {
        [firstKey]: authAccount("refresh", "project"),
      };
      for (const outcome of outcomes) {
        mocks.fetchResponse.mockResolvedValueOnce(outcome);
      }

      await expect(flavor.query(auth, { requestTimeoutMs: 20 })).resolves.toEqual({
        success: false,
        error,
        facts,
      });
    },
  );
});

const AGY_AUTH_KEYS = ["google-agy", "opencode-agy-auth", "google-agy-auth"] as const;

function resolveAgyAccounts(auth: Parameters<typeof resolveGoogleAccounts>[1], project: string) {
  return resolveGoogleAccounts({ authKeys: AGY_AUTH_KEYS }, auth, project);
}

describe("Google account resolution", () => {
  it("preserves auth-key order, packed refresh parts, login tokens, and duplicate suppression", () => {
    expect(
      resolveAgyAccounts(
        {
          "google-agy-auth": authAccount("refresh-token-2", "project-2", undefined, {
            login: "bob@example.com",
          }),
          "opencode-agy-auth": {
            type: "oauth",
            refresh: "refresh-token-1|packed-project|packed-managed",
            managedProjectId: "entry-managed",
            email: "duplicate@example.com",
          },
          "google-agy": {
            type: "oauth",
            refresh: " refresh-token-1 |packed-project|packed-managed",
            managedProjectId: "entry-managed",
            accountEmail: "alice@example.com",
            access: " access-token ",
            expires: 123,
          },
        },
        "configured-project",
      ),
    ).toEqual([
      {
        sourceKey: "google-agy",
        refreshToken: "refresh-token-1",
        projectId: "entry-managed",
        email: "alice@example.com",
        accessToken: "access-token",
        expiresAt: 123,
      },
      {
        sourceKey: "google-agy-auth",
        refreshToken: "refresh-token-2",
        projectId: "project-2",
        email: "bob@example.com",
      },
    ]);
  });

  it.each([
    [
      { refresh: "refresh|packed-project|packed-managed", managedProjectId: "entry-managed" },
      "entry-managed",
    ],
    [
      { refresh: "refresh|packed-project|packed-managed", quotaProjectId: "entry-quota" },
      "entry-quota",
    ],
    [
      { refresh: "refresh|packed-project|packed-managed", projectId: "entry-project" },
      "packed-managed",
    ],
    [{ refresh: "refresh|packed-project", projectId: "entry-project" }, "entry-project"],
    [{ refresh: "refresh|packed-project", projectID: "entry-project-id" }, "entry-project-id"],
    [{ refresh: "refresh|packed-project" }, "packed-project"],
    [{ refresh: "refresh" }, "configured-project"],
  ])("picks the project id by precedence: %o → %s", (entry, projectId) => {
    expect(
      resolveAgyAccounts({ "google-agy": { type: "oauth", ...entry } }, "configured-project")[0]
        ?.projectId,
    ).toBe(projectId);
  });
});

describe("Google AGY quota summary", () => {
  /** Answers the next quota request with `summary`; returns the one login to query. */
  function mockSummary(summary: unknown) {
    mocks.fetchResponse.mockResolvedValueOnce(jsonResponse(summary));
    return { "google-agy": authAccount("refresh-token", "project-1") };
  }

  it("normalizes grouped weekly and five-hour buckets with canonical family labels", async () => {
    const auth = {
      "google-agy": authAccount("refresh-token", "project-1", "alice@example.com"),
    };
    mocks.fetchResponse.mockResolvedValueOnce(jsonResponse(summaryResponse()));

    const result = await queryAgy(auth);
    if (!result?.success) throw new Error("expected success");
    expect(result.buckets[0]).toEqual({
      family: "Gemini Models",
      window: "weekly",
      windowLabel: "Weekly",
      bucketId: "gemini-weekly",
      bucketLabel: "Weekly",
      remainingFraction: 0.58,
      percentRemaining: 58,
      resetTimeIso: "2026-06-22T00:00:00.000Z",
      accountEmail: "alice@example.com",
      sourceKey: "google-agy",
    });
    expect(
      result.buckets.map(({ family, window, windowLabel, percentRemaining, remainingAmount }) => [
        family,
        window,
        windowLabel,
        percentRemaining,
        remainingAmount,
      ]),
    ).toEqual([
      ["Gemini Models", "weekly", "Weekly", 58, undefined],
      ["Gemini Models", "five_hour", "5h", 25, "1234"],
      ["Claude and GPT models", "weekly", "Weekly", 100, undefined],
      ["Claude and GPT models", "five_hour", "5h", 90, "50"],
    ]);
  });

  it("keeps a model-specific group such as Gemini 4 Argon as its own family", async () => {
    const auth = mockSummary({
      groups: [
        ...summaryResponse().groups,
        {
          displayName: "Gemini 4 Argon",
          description: "For paid Pro plans, Argon quota is separate.",
          buckets: [
            {
              bucketId: "gemini-argon-wtu-weekly",
              displayName: "Gemini 4 Argon Weekly Limit",
              window: "weekly",
              remainingFraction: 0.95,
              resetTime: "2026-10-23T05:24:42Z",
            },
          ],
        },
      ],
    });

    const result = await queryAgy(auth);
    if (!result?.success) throw new Error("expected success");
    expect(
      result.buckets.map(({ family, window, percentRemaining }) => [
        family,
        window,
        percentRemaining,
      ]),
    ).toEqual([
      ["Gemini Models", "weekly", 58],
      ["Gemini Models", "five_hour", 25],
      ["Claude and GPT models", "weekly", 100],
      ["Claude and GPT models", "five_hour", 90],
      ["Gemini 4 Argon", "weekly", 95],
    ]);
  });

  it("uses top-level buckets only when grouped buckets are not usable", async () => {
    const auth = mockSummary({
      description: "Fallback family",
      groups: [{ displayName: "Gemini Models", buckets: [{ window: "DAILY" }] }],
      buckets: [
        { bucketId: "fallback-weekly", window: "weekly", remainingFraction: 0.4 },
        { bucketId: "fallback-five-hour", window: "5h", remainingFraction: 0.7 },
      ],
    });

    const result = await queryAgy(auth);
    if (!result?.success) throw new Error("expected success");
    expect(result.buckets.map((bucket) => [bucket.family, bucket.window])).toEqual([
      ["Fallback family", "weekly"],
      ["Fallback family", "five_hour"],
    ]);
  });

  it("reports a summary without usable rows as an account error", async () => {
    const auth = mockSummary({
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [
            { bucketId: "disabled", window: "WEEKLY", remainingFraction: 0.1, disabled: true },
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
    });

    await expect(queryAgy(auth)).resolves.toEqual({
      success: false,
      error: "Quota summary API unavailable",
    });
  });

  it("keeps the most constrained duplicate, an explicit zero, and drops an invalid reset", async () => {
    const auth = mockSummary({
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
              bucketId: "zero-weekly",
              window: "WEEKLY",
              remainingFraction: 0,
              resetTime: "not-a-date",
            },
          ],
        },
      ],
    });

    const result = await queryAgy(auth);
    if (!result?.success) throw new Error("expected success");
    expect(result.buckets).toHaveLength(2);
    expect(result.buckets.find((bucket) => bucket.bucketId === "same-weekly")).toMatchObject({
      percentRemaining: 30,
      resetTimeIso: "2026-06-21T00:00:00.000Z",
    });
    const zero = result.buckets.find((bucket) => bucket.bucketId === "zero-weekly");
    expect(zero).toMatchObject({ percentRemaining: 0 });
    expect(zero).not.toHaveProperty("resetTimeIso");
  });
});
