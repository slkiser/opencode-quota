import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  readAuthFileCached: vi.fn(),
}));

vi.mock("../src/lib/opencode-auth.js", () => ({
  readAuthFileCached: mocks.readAuthFileCached,
}));

import {
  DEFAULT_ANTHROPIC_AUTH_CACHE_MAX_AGE_MS,
  resolveAnthropicOAuth,
  resolveAnthropicOAuthCached,
} from "../src/lib/anthropic-auth.js";

describe("anthropic auth resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves the OpenCode anthropic OAuth entry", () => {
    expect(
      resolveAnthropicOAuth(
        { anthropic: { type: "oauth", access: "opencode-token", expires: 4_000 } },
        { nowMs: 2_000 },
      ),
    ).toEqual({
      state: "configured",
      accessToken: "opencode-token",
      expiresAt: 4_000,
    });
  });

  it("resolves entries without an expiry", () => {
    expect(
      resolveAnthropicOAuth({ anthropic: { type: "oauth", access: "opencode-token" } }),
    ).toEqual({
      state: "configured",
      accessToken: "opencode-token",
    });
  });

  it("ignores API key auth entries because the usage endpoint requires OAuth", () => {
    expect(resolveAnthropicOAuth({ anthropic: { type: "api", access: "opencode-token" } })).toEqual(
      {
        state: "none",
      },
    );
  });

  it("ignores blank access tokens", () => {
    expect(resolveAnthropicOAuth({ anthropic: { type: "oauth", access: "   " } })).toEqual({
      state: "none",
    });
  });

  it("reports expired entries as expired instead of configured", () => {
    expect(
      resolveAnthropicOAuth(
        { anthropic: { type: "oauth", access: "opencode-token", expires: 1_000 } },
        { nowMs: 2_000 },
      ),
    ).toEqual({
      state: "expired",
      expiresAt: 1_000,
    });
  });

  it("returns none when auth data is missing", () => {
    expect(resolveAnthropicOAuth(null)).toEqual({ state: "none" });
    expect(resolveAnthropicOAuth({})).toEqual({ state: "none" });
  });

  it("uses cached auth reads for resolveAnthropicOAuthCached", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      anthropic: { type: "oauth", access: "cached-token" },
    });

    await expect(resolveAnthropicOAuthCached()).resolves.toEqual({
      state: "configured",
      accessToken: "cached-token",
    });
    expect(mocks.readAuthFileCached).toHaveBeenCalledWith({
      maxAgeMs: DEFAULT_ANTHROPIC_AUTH_CACHE_MAX_AGE_MS,
    });
  });

  it("clamps negative cache ages", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce(null);

    await expect(resolveAnthropicOAuthCached({ maxAgeMs: -1 })).resolves.toEqual({ state: "none" });
    expect(mocks.readAuthFileCached).toHaveBeenCalledWith({ maxAgeMs: 0 });
  });
});
