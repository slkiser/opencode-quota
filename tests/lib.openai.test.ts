import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import businessIndividualLimitUsage from "./fixtures/openai/business-individual-limit.sanitized.json";
import businessTeamMonthlyUsage from "./fixtures/openai/business-team-monthly.sanitized.json";

const mocks = vi.hoisted(() => ({
  readCredentialRows: vi.fn(),
  deriveResolvedAuthIdentity: vi.fn(async () => "rai1_test-opaque-identity"),
}));

vi.mock("../src/lib/opencode-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-auth.js")>()),
  readCredentialRows: mocks.readCredentialRows,
}));

vi.mock("../src/lib/resolved-auth-identity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/resolved-auth-identity.js")>()),
  deriveResolvedAuthIdentity: mocks.deriveResolvedAuthIdentity,
}));

import {
  type OpenAIOAuthLogin,
  openaiLoginsIdentity,
  queryOpenAIQuota,
  readOpenAILogins,
  resolveOpenAIOAuth,
} from "../src/lib/openai.js";

const POSIX_IDENTITY_STORAGE = process.platform !== "win32" && typeof process.getuid === "function";
const LOGIN: OpenAIOAuthLogin = { state: "configured", sourceKey: "openai", accessToken: "a.b.c" };

/** A JWT-shaped token with this payload. */
function jwt(payload: object): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

const PROFILE_JWT = jwt({
  "https://api.openai.com/profile": { email: "user@example.com" },
  "https://api.openai.com/auth": { chatgpt_account_id: "acct_jwt" },
});

/** Queries a valid login that gets `usage` as its JSON reply. */
function queryUsage(usage: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(usage)),
  );
  return queryOpenAIQuota({ auth: LOGIN });
}

const HOURLY_80 = {
  percentRemaining: 80,
  resetTimeIso: "2026-01-01T01:00:00.000Z",
  fixedWindow: { startedAtIso: "2025-12-31T20:00:00.000Z" },
};
/** A rate-limit window as ChatGPT reports it. */
function rateWindow(
  usedPercent: unknown,
  limitWindowSeconds: number,
  reset: { reset_at?: number; reset_after_seconds?: number },
) {
  return { used_percent: usedPercent, limit_window_seconds: limitWindowSeconds, ...reset };
}

const HOURLY_20_USED = rateWindow(20, 18_000, { reset_after_seconds: 3_600 });
const BUSINESS_MONTHLY = {
  percentRemaining: 67,
  resetTimeIso: new Date(1_786_262_548_000).toISOString(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("resolveOpenAIOAuth", () => {
  it.each([
    ["no supported entry", {}, { state: "none" }],
    [
      // OpenCode 2 imports a legacy console login as `methodID: "device"`, often without an orgID.
      "the Console login under opencode, an API key or a blank token",
      {
        codex: { type: "oauth", access: "   " },
        openai: { type: "api", access: "ignored" },
        chatgpt: { type: "oauth", access: "   " },
        opencode: { type: "oauth", methodID: "device", access: "console-token" },
      },
      { state: "none" },
    ],
    [
      "openai before legacy compatibility keys",
      {
        codex: { type: "oauth", access: "codex-token" },
        openai: { type: "oauth", access: "openai-token" },
        chatgpt: { type: "oauth", access: "chatgpt-token" },
        opencode: { type: "oauth", access: "opencode-token" },
      },
      { state: "configured", sourceKey: "openai", accessToken: "openai-token" },
    ],
    [
      "chatgpt when codex and openai are absent",
      { chatgpt: { type: "oauth", access: "a.b.c" } },
      { state: "configured", sourceKey: "chatgpt", accessToken: "a.b.c" },
    ],
    [
      "a failed openai login over a later compatibility key, as a configured one would",
      {
        openai: { type: "oauth", resolveError: "resolve_empty: no value" },
        codex: { type: "oauth", access: "codex-token" },
      },
      { state: "failed", sourceKey: "openai", error: "resolve_empty: no value" },
    ],
    [
      "the account id from the JWT, refresh token and expiry from the entry",
      {
        openai: {
          type: "oauth",
          access: PROFILE_JWT,
          refresh: "refresh-token",
          expires: 5,
          accountId: "acct_stored",
        },
      },
      {
        state: "configured",
        sourceKey: "openai",
        accessToken: PROFILE_JWT,
        refreshToken: "refresh-token",
        expiresAt: 5,
        accountId: "acct_jwt",
      },
    ],
    [
      "the stored account id without one in the JWT, and no blank refresh token",
      { openai: { type: "oauth", access: jwt({}), refresh: "  ", accountId: "acct_stored" } },
      {
        state: "configured",
        sourceKey: "openai",
        accessToken: jwt({}),
        accountId: "acct_stored",
      },
    ],
  ])("resolves %s", (_name, auth, expected) => {
    expect(resolveOpenAIOAuth(auth as never)).toEqual(expected);
  });
});

describe("OpenAI login identity", () => {
  /** The identity of one stored `openai` login with this value. */
  async function identityOf(value: Record<string, unknown>, resolveError?: string) {
    mocks.readCredentialRows.mockResolvedValue([
      { id: "login-1", integrationId: "openai", label: "", active: true, value, resolveError },
    ]);
    return openaiLoginsIdentity(await readOpenAILogins());
  }

  it.runIf(POSIX_IDENTITY_STORAGE)(
    "prefers the resolved stable account id for opaque cache identity",
    async () => {
      const identity = await identityOf({
        type: "oauth",
        access: "access-secret",
        refresh: "refresh-secret",
        accountId: "account-stable-id",
      });

      expect(identity).toMatch(/^rai1_/u);
      expect(mocks.deriveResolvedAuthIdentity).toHaveBeenCalledWith({
        providerId: "openai",
        principal: { kind: "stable-id", value: "account-stable-id" },
      });
    },
  );

  it("uses the login's credential rather than advisory email when no account id exists", async () => {
    const access = jwt({ email: "shared@example.com" });
    for (const refresh of ["refresh-secret-one", "refresh-secret-two"]) {
      await identityOf({ type: "oauth", access, refresh });
      expect(mocks.deriveResolvedAuthIdentity).toHaveBeenLastCalledWith({
        providerId: "openai",
        principal: { kind: "credential", value: refresh },
      });
    }
  });

  it("gives a login OpenCode could not return no identity", async () => {
    await expect(identityOf({ type: "oauth" }, "refresh_failed: HTTP 400")).resolves.toBeNull();
    expect(mocks.deriveResolvedAuthIdentity).not.toHaveBeenCalled();
  });
});

describe("queryOpenAIQuota", () => {
  it.each([
    [
      undefined,
      "refresh_failed: HTTP 400",
      "OpenAI sign-in could not be refreshed: refresh_failed: HTTP 400. Run `opencode auth login openai`.",
    ],
    // #316: name the logout command only for a shell-safe label.
    [
      "default",
      "refresh_failed: Request failed: 401",
      "OpenAI sign-in could not be refreshed: refresh_failed: Request failed: 401. Run `opencode auth logout openai default`, then `opencode auth login openai`.",
    ],
    ...["My work; rm", " Work ", "--help"].map((label) => [
      label,
      "refresh_failed: Request failed: 401",
      "OpenAI sign-in could not be refreshed: refresh_failed: Request failed: 401. Run `opencode auth login openai`.",
    ]),
  ])("reports a failed login (label %j) without a request", async (loginLabel, error, expected) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      queryOpenAIQuota({ auth: { state: "failed", sourceKey: "openai", error }, loginLabel }),
    ).resolves.toEqual({ success: false, error: expected });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns token expired error when expires is in the past", async () => {
    await expect(
      queryOpenAIQuota({ auth: { ...LOGIN, expiresAt: Date.now() - 1 } }),
    ).resolves.toEqual({ success: false, error: "Token expired" });
  });

  it("sends the bearer token and the ChatGPT account id", async () => {
    const fetchMock = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", fetchMock);

    await queryOpenAIQuota({ auth: { ...LOGIN, accountId: "acct_1" } });
    expect(fetchMock).toHaveBeenCalledWith("https://chatgpt.com/backend-api/wham/usage", {
      headers: {
        Authorization: "Bearer a.b.c",
        "User-Agent": "OpenCode-Quota-Toast/1.0",
        "ChatGPT-Account-Id": "acct_1",
      },
      signal: expect.any(AbortSignal),
    });
  });

  it.each([
    // The free-text body can echo account details, so it never reaches the error.
    [
      403,
      { error: "account alice@example.com account-id-123 access-secret" },
      "OpenAI API error 403",
      { code: "provider_error", status: 403 },
    ],
    // #316: only OpenAI's short error code is added.
    [
      401,
      {
        error: {
          message: "Unauthorized alice@example.com",
          type: "rejected_by_access_enforcement",
          code: "no_matching_rule",
        },
      },
      "OpenAI API error 401 (no_matching_rule)",
      { code: "login_expired", status: 401 },
    ],
    [
      401,
      { error: { code: "alice@example.com is blocked" } },
      "OpenAI API error 401",
      { code: "login_expired", status: 401 },
    ],
  ])("reports HTTP %i without echoing the body", async (status, body, error, facts) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body), { status })),
    );

    const result = await queryOpenAIQuota({ auth: LOGIN });
    expect(result).toEqual({ success: false, error, facts });
    expect(JSON.stringify(result)).not.toMatch(/alice@example\.com|account-id-123|access-secret/u);
  });

  it.each([
    {
      name: "classifies the sanitized Business window as monthly without inventing absent windows",
      usage: businessTeamMonthlyUsage,
      label: "OpenAI (Business)",
      windows: { monthly: BUSINESS_MONTHLY },
    },
    {
      name: "parses the sanitized Business individual spend limit as monthly quota",
      usage: businessIndividualLimitUsage,
      label: "OpenAI (Business)",
      windows: {
        monthly: { percentRemaining: 100, resetTimeIso: new Date(1_785_542_400_000).toISOString() },
      },
    },
    {
      name: "falls back to individual-limit reset_after_seconds when reset_at is absent",
      usage: {
        ...businessIndividualLimitUsage,
        spend_control: { individual_limit: { remaining_percent: 80, reset_after_seconds: 60 } },
      },
      label: "OpenAI (Business)",
      windows: { monthly: { percentRemaining: 80, resetTimeIso: "2026-01-01T00:01:00.000Z" } },
    },
    ...[
      { name: "zero", value: 0, expected: 0 },
      { name: "negative", value: -25, expected: 0 },
      { name: "above 100", value: 140, expected: 100 },
    ].map(({ name, value, expected }) => ({
      name: `clamps ${name} Business individual-limit percentages`,
      usage: {
        ...businessIndividualLimitUsage,
        spend_control: {
          individual_limit: {
            ...businessIndividualLimitUsage.spend_control.individual_limit,
            remaining_percent: value,
          },
        },
      },
      label: "OpenAI (Business)",
      windows: {
        monthly: {
          percentRemaining: expected,
          resetTimeIso: new Date(1_785_542_400_000).toISOString(),
        },
      },
    })),
    {
      name: "keeps an existing Business monthly rate-limit window authoritative",
      usage: {
        ...businessTeamMonthlyUsage,
        spend_control: { individual_limit: { remaining_percent: 5, reset_at: 1_800_000_000 } },
      },
      label: "OpenAI (Business)",
      windows: { monthly: BUSINESS_MONTHLY },
    },
    {
      name: "classifies known windows by duration when their positions are reversed",
      usage: {
        plan_type: "pro",
        rate_limit: {
          primary_window: rateWindow(10, 604_800, { reset_after_seconds: 604_800 }),
          secondary_window: rateWindow(70, 18_000, { reset_after_seconds: 18_000 }),
        },
      },
      label: "OpenAI (Pro)",
      windows: {
        hourly: { percentRemaining: 30, resetTimeIso: "2026-01-01T05:00:00.000Z" },
        weekly: { percentRemaining: 90, resetTimeIso: "2026-01-08T00:00:00.000Z" },
      },
    },
    {
      name: "omits an unknown duration while preserving a valid sibling",
      usage: {
        plan_type: "pro",
        rate_limit: {
          primary_window: rateWindow(10, 3_600, { reset_after_seconds: 3_600 }),
          secondary_window: rateWindow(70, 604_800, { reset_after_seconds: 604_800 }),
        },
      },
      label: "OpenAI (Pro)",
      windows: { weekly: { percentRemaining: 30, resetTimeIso: "2026-01-08T00:00:00.000Z" } },
    },
    {
      name: "omits a malformed window while preserving a valid sibling",
      usage: {
        plan_type: "team",
        rate_limit: {
          primary_window: rateWindow("33", 2_628_000, { reset_after_seconds: 2_585_763 }),
          secondary_window: rateWindow(25, 18_000, { reset_after_seconds: 18_000 }),
        },
      },
      label: "OpenAI (Business)",
      windows: { hourly: { percentRemaining: 75, resetTimeIso: "2026-01-01T05:00:00.000Z" } },
    },
    {
      name: "collapses equivalent duplicate durations",
      usage: {
        plan_type: "pro",
        rate_limit: {
          primary_window: rateWindow(10, 604_800, { reset_at: 1_768_435_200 }),
          secondary_window: rateWindow(10, 604_800, { reset_at: 1_768_435_200 }),
        },
      },
      label: "OpenAI (Pro)",
      windows: { weekly: { percentRemaining: 90, resetTimeIso: "2026-01-15T00:00:00.000Z" } },
    },
    {
      name: "omits conflicting duplicate durations while preserving an unrelated valid window",
      usage: {
        plan_type: "pro",
        rate_limit: {
          primary_window: rateWindow(10, 604_800, { reset_at: 1_768_435_200 }),
          secondary_window: rateWindow(20, 604_800, { reset_at: 1_768_435_200 }),
        },
        code_review_rate_limit: { primary_window: { used_percent: 5, reset_after_seconds: 60 } },
      },
      label: "OpenAI (Pro)",
      windows: { codeReview: { percentRemaining: 95, resetTimeIso: "2026-01-01T00:01:00.000Z" } },
    },
    {
      name: "isolates unrepresentable reset dates and falls back when possible",
      usage: {
        plan_type: "pro",
        rate_limit: {
          primary_window: { ...HOURLY_20_USED, reset_at: Number.MAX_VALUE },
          secondary_window: rateWindow(70, 604_800, { reset_after_seconds: Number.MAX_VALUE }),
        },
      },
      label: "OpenAI (Pro)",
      windows: { hourly: HOURLY_80, weekly: { percentRemaining: 30, resetTimeIso: undefined } },
    },
  ])("$name", async ({ usage, label, windows }) => {
    await expect(queryUsage(usage)).resolves.toEqual({ success: true, label, windows });
  });

  it.each([
    { name: "missing spend control", spendControl: undefined },
    { name: "missing value", spendControl: { individual_limit: {} } },
    { name: "null value", spendControl: { individual_limit: { remaining_percent: null } } },
    { name: "wrong type", spendControl: { individual_limit: { remaining_percent: "50" } } },
  ])("omits $name while preserving personal and code-review paths", async ({ spendControl }) => {
    const out = await queryUsage({
      plan_type: "plus",
      rate_limit: { primary_window: HOURLY_20_USED, secondary_window: null },
      code_review_rate_limit: { primary_window: { used_percent: 5, reset_after_seconds: 60 } },
      credits: { has_credits: true, unlimited: false, balance: "12.34" },
      ...(spendControl === undefined ? {} : { spend_control: spendControl }),
    });

    expect(out).toEqual({
      success: true,
      label: "OpenAI (Plus)",
      windows: {
        hourly: HOURLY_80,
        codeReview: { percentRemaining: 95, resetTimeIso: "2026-01-01T00:01:00.000Z" },
      },
    });
  });

  it("omits a remaining_percent too large to be a number (1e999 in the reply)", async () => {
    const usage = {
      plan_type: "plus",
      rate_limit: { primary_window: HOURLY_20_USED },
      spend_control: { individual_limit: { remaining_percent: "INFINITE" } },
    };
    const body = JSON.stringify(usage).replace('"INFINITE"', "1e999");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body)),
    );

    await expect(queryOpenAIQuota({ auth: LOGIN })).resolves.toEqual({
      success: true,
      label: "OpenAI (Plus)",
      windows: { hourly: HOURLY_80 },
    });
  });

  it.each([
    ["business", "OpenAI (Business)"],
    [" TEAM ", "OpenAI (Business)"],
    ["business_trial", "OpenAI (business_trial)"],
    ["team_workspace", "OpenAI (team_workspace)"],
    ["plus", "OpenAI (Plus)"],
    ["pro", "OpenAI (Pro)"],
  ])("derives the plan label for %j", async (planType, expectedLabel) => {
    await expect(
      queryUsage({ plan_type: planType, rate_limit: { primary_window: HOURLY_20_USED } }),
    ).resolves.toMatchObject({ success: true, label: expectedLabel });
  });

  it("reports a reply without any quota window", async () => {
    await expect(queryUsage({ plan_type: "plus", rate_limit: null })).resolves.toEqual({
      success: false,
      error: "No quota data",
    });
  });
});
