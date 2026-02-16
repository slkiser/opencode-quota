import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { queryGoogleQuota } from "../src/lib/google.js";

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
}));

vi.mock("../src/lib/opencode-auth.js", () => ({
  readAuthFile: vi.fn(),
}));

vi.mock("../src/lib/google-token-cache.js", () => ({
  getCachedAccessToken: vi.fn(async () => null),
  makeAccountCacheKey: vi.fn(() => "key"),
  setCachedAccessToken: vi.fn(async () => undefined),
}));

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirCandidates: () => ({
    dataDirs: ["/home/test/.local/share/opencode"],
    configDirs: ["/home/test/.config/opencode"],
    cacheDirs: ["/home/test/.cache/opencode"],
    stateDirs: ["/home/test/.local/state/opencode"],
  }),
  getOpencodeRuntimeDirs: () => ({
    dataDir: "/home/test/.local/share/opencode",
    configDir: "/home/test/.config/opencode",
    cacheDir: "/home/test/.cache/opencode",
    stateDir: "/home/test/.local/state/opencode",
  }),
}));

describe("google approach C", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("falls back to antigravity refresh when OpenCode token expired", async () => {
    const { readFile } = await import("fs/promises");
    const { readAuthFile } = await import("../src/lib/opencode-auth.js");

    // antigravity-accounts.json exists
    (readFile as any).mockResolvedValueOnce(
      JSON.stringify({
        version: 1,
        accounts: [
          {
            email: "a@b.com",
            refreshToken: "rtok",
            projectId: "proj",
            addedAt: 0,
            lastUsed: 0,
          },
        ],
      }),
    );

    // google token exists but expired (no longer used for multi-account quota,
    // but keep this mocked so the test remains backwards compatible)
    (readAuthFile as any).mockResolvedValueOnce({
      google: { type: "oauth", access: "atok", expires: Date.now() - 1 },
    });

    // Mock fetch to simulate successful token refresh and quota fetch
    const fetchSpy = vi.fn();

    // First call: token refresh
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ access_token: "new_token", expires_in: 3600 }),
    });

    // Second call: quota API
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          models: {
            "claude-opus-4-5-thinking": {
              quotaInfo: { remainingFraction: 0.75, resetTime: "2026-01-01T01:00:00Z" },
            },
          },
        }),
    });

    vi.stubGlobal("fetch", fetchSpy as any);

    const out = await queryGoogleQuota(["CLAUDE"] as any);

    // Should have called fetch for token refresh (fallback path)
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0][0]).toBe("https://oauth2.googleapis.com/token");

    // Should return successful quota data
    expect(out).not.toBeNull();
    expect(out!.success).toBe(true);
    if (out!.success) {
      expect(out!.models.length).toBe(1);
      expect(out!.models[0].percentRemaining).toBe(75);
    }

    vi.unstubAllGlobals();
  });
});
