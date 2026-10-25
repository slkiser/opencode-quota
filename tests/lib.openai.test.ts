import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import businessTeamMonthlyUsage from "./fixtures/openai/business-team-monthly.sanitized.json";

const mocks = vi.hoisted(() => ({
  readAuthFileCached: vi.fn(),
}));

vi.mock("../src/lib/opencode-auth.js", () => ({
  readAuthFileCached: mocks.readAuthFileCached,
}));

import {
  DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS,
  hasOpenAIOAuthCached,
  queryOpenAIQuota,
  resolveOpenAIOAuth,
  resolveOpenAIOAuthWithCodexCli,
} from "../src/lib/openai.js";

let codexHome: string;

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.sig`;
}

function writeCodexAuth(value: unknown): void {
  writeFileSync(join(codexHome, "auth.json"), JSON.stringify(value));
}

describe("openai auth resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    // Never read the developer's real Codex login.
    codexHome = mkdtempSync(join(tmpdir(), "openai-codex-home-"));
    vi.stubEnv("CODEX_HOME", codexHome);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(codexHome, { recursive: true, force: true });
  });

  describe("Codex CLI login fallback", () => {
    const access = jwt({
      exp: Date.parse("2026-01-01T01:00:00.000Z") / 1000,
      "https://api.openai.com/profile": { email: "dev@example.com" },
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-jwt" },
    });

    it("uses the Codex CLI ChatGPT login when OpenCode has no OpenAI OAuth", async () => {
      writeCodexAuth({
        auth_mode: "chatgpt",
        OPENAI_API_KEY: null,
        tokens: { access_token: access, refresh_token: "refresh", account_id: "acct-file" },
      });

      await expect(resolveOpenAIOAuthWithCodexCli({})).resolves.toEqual({
        state: "configured",
        sourceKey: "codex-cli",
        accessToken: access,
        refreshToken: "refresh",
        expiresAt: Date.parse("2026-01-01T01:00:00.000Z"),
        email: "dev@example.com",
        accountId: "acct-jwt",
      });
    });

    it("prefers OpenCode auth over the Codex CLI login", async () => {
      writeCodexAuth({ tokens: { access_token: access } });

      await expect(
        resolveOpenAIOAuthWithCodexCli({ openai: { type: "oauth", access: "opencode-token" } }),
      ).resolves.toMatchObject({ sourceKey: "openai", accessToken: "opencode-token" });
    });

    it("ignores missing, malformed and API-key-only Codex auth files", async () => {
      await expect(resolveOpenAIOAuthWithCodexCli({})).resolves.toEqual({ state: "none" });
      writeFileSync(join(codexHome, "auth.json"), "{not json");
      await expect(resolveOpenAIOAuthWithCodexCli({})).resolves.toEqual({ state: "none" });
      writeCodexAuth({ auth_mode: "apikey", OPENAI_API_KEY: "sk-test", tokens: null });
      await expect(resolveOpenAIOAuthWithCodexCli({})).resolves.toEqual({ state: "none" });
    });

    it("queries usage with the Codex token and account header without refreshing it", async () => {
      mocks.readAuthFileCached.mockResolvedValue({});
      writeCodexAuth({ tokens: { access_token: access, account_id: "acct-file" } });
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              plan_type: "pro",
              rate_limit: {
                limit_reached: false,
                primary_window: {
                  used_percent: 30,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 3600,
                },
              },
            }),
            { status: 200 },
          ),
      );
      vi.stubGlobal("fetch", fetchMock as any);

      await expect(hasOpenAIOAuthCached()).resolves.toBe(true);
      const out = await queryOpenAIQuota();

      expect(out && out.success ? out.windows.hourly?.percentRemaining : -1).toBe(70);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("https://chatgpt.com/backend-api/wham/usage");
      expect(init.headers).toMatchObject({
        Authorization: `Bearer ${access}`,
        "ChatGPT-Account-Id": "acct-jwt",
      });
    });

    it("reports an expired Codex token instead of calling the API", async () => {
      mocks.readAuthFileCached.mockResolvedValue({});
      writeCodexAuth({ tokens: { access_token: jwt({ exp: Date.now() / 1000 - 1 }) } });
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock as any);

      const out = await queryOpenAIQuota();

      expect(out && !out.success ? out.error : "").toContain("Token expired");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it("returns none when no supported native OpenCode auth entry exists", () => {
    expect(resolveOpenAIOAuth({})).toEqual({ state: "none" });
  });

  it("prefers openai before legacy compatibility keys", () => {
    expect(
      resolveOpenAIOAuth({
        codex: { type: "oauth", access: "codex-token" },
        openai: { type: "oauth", access: "openai-token" },
        chatgpt: { type: "oauth", access: "chatgpt-token" },
        opencode: { type: "oauth", access: "opencode-token" },
      }),
    ).toMatchObject({
      state: "configured",
      sourceKey: "openai",
      accessToken: "openai-token",
    });
  });

  it("returns null when quota is not configured", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({});

    await expect(queryOpenAIQuota()).resolves.toBeNull();
    expect(mocks.readAuthFileCached).toHaveBeenCalledWith({
      maxAgeMs: DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS,
    });
  });

  it("returns token expired error when expires is in the past", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      openai: { type: "oauth", access: "tok", expires: Date.now() - 1 },
    });

    const out = await queryOpenAIQuota();
    expect(out && !out.success ? out.error : "").toContain("Token expired");
  });

  it("reads auth from chatgpt when codex and openai are absent", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      chatgpt: { type: "oauth", access: "a.b.c", expires: Date.now() + 60_000 },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              plan_type: "plus",
              rate_limit: {
                limit_reached: false,
                primary_window: {
                  used_percent: 20,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 3600,
                },
                secondary_window: null,
              },
            }),
            { status: 200 },
          ),
      ) as any,
    );

    const out = await queryOpenAIQuota();
    expect(out && out.success ? out.windows.hourly?.percentRemaining : -1).toBe(80);
  });

  it("reads auth from opencode when higher-priority keys are unusable", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      codex: { type: "oauth", access: "   " },
      openai: { type: "api", access: "ignored" },
      chatgpt: { type: "oauth", access: "   " },
      opencode: { type: "oauth", access: "a.b.c", expires: Date.now() + 60_000 },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              plan_type: "free",
              rate_limit: {
                limit_reached: false,
                primary_window: {
                  used_percent: 50,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 3600,
                },
                secondary_window: null,
              },
            }),
            { status: 200 },
          ),
      ) as any,
    );

    const out = await queryOpenAIQuota();
    expect(out && out.success ? out.windows.hourly?.percentRemaining : -1).toBe(50);
  });

  it("uses cached auth reads for hasOpenAIOAuthCached", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      openai: { type: "oauth", access: "cached-token" },
    });

    await expect(hasOpenAIOAuthCached()).resolves.toBe(true);
    expect(mocks.readAuthFileCached).toHaveBeenCalledWith({
      maxAgeMs: DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS,
    });
  });

  it("classifies the sanitized Business window as monthly without inventing absent windows", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      openai: { type: "oauth", access: "a.b.c", expires: Date.now() + 60_000 },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify(businessTeamMonthlyUsage), { status: 200 }),
      ) as any,
    );

    const out = await queryOpenAIQuota();
    expect(out && out.success ? out.label : "").toBe("OpenAI (Business)");
    expect(out && out.success ? out.windows : {}).toEqual({
      monthly: {
        percentRemaining: 67,
        resetTimeIso: new Date(1_786_262_548_000).toISOString(),
      },
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
    mocks.readAuthFileCached.mockResolvedValueOnce({
      openai: { type: "oauth", access: "a.b.c", expires: Date.now() + 60_000 },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              plan_type: planType,
              rate_limit: {
                limit_reached: false,
                primary_window: {
                  used_percent: 20,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 3_600,
                },
                secondary_window: null,
              },
            }),
            { status: 200 },
          ),
      ) as any,
    );

    const out = await queryOpenAIQuota();
    expect(out && out.success ? out.label : "").toBe(expectedLabel);
  });

  it("classifies known windows by duration when their positions are reversed", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      openai: { type: "oauth", access: "a.b.c", expires: Date.now() + 60_000 },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              plan_type: "pro",
              rate_limit: {
                limit_reached: false,
                primary_window: {
                  used_percent: 10,
                  limit_window_seconds: 604_800,
                  reset_after_seconds: 604_800,
                },
                secondary_window: {
                  used_percent: 70,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 18_000,
                },
              },
            }),
            { status: 200 },
          ),
      ) as any,
    );

    const out = await queryOpenAIQuota();
    expect(out && out.success ? out.windows.hourly?.percentRemaining : -1).toBe(30);
    expect(out && out.success ? out.windows.weekly?.percentRemaining : -1).toBe(90);
  });

  it("omits an unknown duration while preserving a valid sibling", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      openai: { type: "oauth", access: "a.b.c", expires: Date.now() + 60_000 },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              plan_type: "pro",
              rate_limit: {
                limit_reached: false,
                primary_window: {
                  used_percent: 10,
                  limit_window_seconds: 3_600,
                  reset_after_seconds: 3_600,
                },
                secondary_window: {
                  used_percent: 70,
                  limit_window_seconds: 604_800,
                  reset_after_seconds: 604_800,
                },
              },
            }),
            { status: 200 },
          ),
      ) as any,
    );

    const out = await queryOpenAIQuota();
    expect(out && out.success ? out.windows : {}).toEqual({
      weekly: {
        percentRemaining: 30,
        resetTimeIso: "2026-01-08T00:00:00.000Z",
      },
    });
  });

  it("omits a malformed window while preserving a valid sibling", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      openai: { type: "oauth", access: "a.b.c", expires: Date.now() + 60_000 },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              plan_type: "team",
              rate_limit: {
                limit_reached: false,
                primary_window: {
                  used_percent: "33",
                  limit_window_seconds: 2_628_000,
                  reset_after_seconds: 2_585_763,
                },
                secondary_window: {
                  used_percent: 25,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 18_000,
                },
              },
            }),
            { status: 200 },
          ),
      ) as any,
    );

    const out = await queryOpenAIQuota();
    expect(out && out.success ? out.windows : {}).toEqual({
      hourly: {
        percentRemaining: 75,
        resetTimeIso: "2026-01-01T05:00:00.000Z",
      },
    });
  });

  it("collapses equivalent duplicate durations", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      openai: { type: "oauth", access: "a.b.c", expires: Date.now() + 60_000 },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              plan_type: "pro",
              rate_limit: {
                limit_reached: false,
                primary_window: {
                  used_percent: 10,
                  limit_window_seconds: 604_800,
                  reset_at: 1_768_435_200,
                },
                secondary_window: {
                  used_percent: 10,
                  limit_window_seconds: 604_800,
                  reset_at: 1_768_435_200,
                },
              },
            }),
            { status: 200 },
          ),
      ) as any,
    );

    const out = await queryOpenAIQuota();
    expect(out && out.success ? out.windows : {}).toEqual({
      weekly: {
        percentRemaining: 90,
        resetTimeIso: "2026-01-15T00:00:00.000Z",
      },
    });
  });

  it("omits conflicting duplicate durations while preserving an unrelated valid window", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      openai: { type: "oauth", access: "a.b.c", expires: Date.now() + 60_000 },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              plan_type: "pro",
              rate_limit: {
                limit_reached: false,
                primary_window: {
                  used_percent: 10,
                  limit_window_seconds: 604_800,
                  reset_at: 1_768_435_200,
                },
                secondary_window: {
                  used_percent: 20,
                  limit_window_seconds: 604_800,
                  reset_at: 1_768_435_200,
                },
              },
              code_review_rate_limit: {
                primary_window: {
                  used_percent: 5,
                  reset_after_seconds: 60,
                },
              },
            }),
            { status: 200 },
          ),
      ) as any,
    );

    const out = await queryOpenAIQuota();
    expect(out && out.success ? out.windows : {}).toEqual({
      codeReview: {
        percentRemaining: 95,
        resetTimeIso: "2026-01-01T00:01:00.000Z",
      },
    });
  });

  it("isolates unrepresentable reset dates and falls back when possible", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      openai: { type: "oauth", access: "a.b.c", expires: Date.now() + 60_000 },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              plan_type: "pro",
              rate_limit: {
                limit_reached: false,
                primary_window: {
                  used_percent: 20,
                  limit_window_seconds: 18_000,
                  reset_at: Number.MAX_VALUE,
                  reset_after_seconds: 3_600,
                },
                secondary_window: {
                  used_percent: 70,
                  limit_window_seconds: 604_800,
                  reset_after_seconds: Number.MAX_VALUE,
                },
              },
            }),
            { status: 200 },
          ),
      ) as any,
    );

    const out = await queryOpenAIQuota();
    expect(out && out.success ? out.windows : {}).toEqual({
      hourly: {
        percentRemaining: 80,
        resetTimeIso: "2026-01-01T01:00:00.000Z",
      },
      weekly: {
        percentRemaining: 30,
        resetTimeIso: undefined,
      },
    });
  });

  it("returns separate hourly and weekly windows", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      openai: { type: "oauth", access: "a.b.c", expires: Date.now() + 60_000 },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              plan_type: "pro",
              rate_limit: {
                limit_reached: false,
                primary_window: {
                  used_percent: 10,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 3600,
                },
                secondary_window: {
                  used_percent: 70,
                  limit_window_seconds: 604_800,
                  reset_after_seconds: 604_800,
                },
              },
            }),
            { status: 200 },
          ),
      ) as any,
    );

    const out = await queryOpenAIQuota();
    expect(out && out.success ? out.windows.hourly?.percentRemaining : -1).toBe(90);
    expect(out && out.success ? out.windows.weekly?.percentRemaining : -1).toBe(30);
  });
});
