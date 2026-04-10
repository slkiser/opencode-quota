import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
} from "../src/lib/openai.js";

describe("openai auth resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
                  limit_window_seconds: 3600,
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
                  limit_window_seconds: 3600,
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
                  limit_window_seconds: 3600,
                  reset_after_seconds: 3600,
                },
                secondary_window: {
                  used_percent: 70,
                  limit_window_seconds: 60,
                  reset_after_seconds: 60,
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
