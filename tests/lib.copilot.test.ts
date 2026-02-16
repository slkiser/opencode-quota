import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("fs", async (importOriginal) => {
  const mod = await importOriginal<typeof import("fs")>();
  return {
    ...mod,
    // Prevent test environment from accidentally using a real local PAT config.
    existsSync: vi.fn(() => false),
  };
});

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

vi.mock("../src/lib/opencode-auth.js", () => ({
  readAuthFile: vi.fn(),
}));

const realEnv = process.env;

describe("queryCopilotQuota", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z"));
    process.env = { ...realEnv };
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    process.env = realEnv;
  });

  it("returns null when not configured and no PAT config", async () => {
    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    const { readAuthFile } = await import("../src/lib/opencode-auth.js");
    (readAuthFile as any).mockResolvedValueOnce({});

    await expect(queryCopilotQuota()).resolves.toBeNull();
  });

  it("uses token exchange when legacy internal call fails", async () => {
    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    const { readAuthFile } = await import("../src/lib/opencode-auth.js");
    (readAuthFile as any).mockResolvedValueOnce({
      "github-copilot": { type: "oauth", refresh: "gho_abc" },
    });

    const fetchMock = vi.fn(async (url: any, _opts: any) => {
      const s = String(url);

      if (s.includes("/copilot_internal/user")) {
        // first attempt: legacy auth call fails, second attempt: bearer works
        const auth = _opts?.headers?.Authorization || _opts?.headers?.authorization;
        if (typeof auth === "string" && auth.startsWith("token ")) {
          return new Response("forbidden", { status: 403 });
        }

        return new Response(
          JSON.stringify({
            copilot_plan: "pro",
            quota_reset_date: "2026-02-01T00:00:00.000Z",
            quota_snapshots: {
              premium_interactions: {
                entitlement: 300,
                remaining: 200,
                percent_remaining: 66.7,
                unlimited: false,
                overage_count: 0,
                overage_permitted: false,
                quota_id: "x",
                quota_remaining: 0,
              },
            },
          }),
          { status: 200 },
        );
      }

      if (s.includes("/copilot_internal/v2/token")) {
        return new Response(
          JSON.stringify({
            token: "cpt_sess",
            expires_at: Date.now() + 60_000,
            refresh_in: 30_000,
            endpoints: { api: "https://api.github.com" },
          }),
          { status: 200 },
        );
      }

      return new Response("not found", { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock as any);

    const out = await queryCopilotQuota();
    expect(out && out.success ? out.total : -1).toBe(300);
    expect(out && out.success ? out.used : -1).toBe(100);
  });
});
