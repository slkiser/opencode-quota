import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { queryChutesQuota } from "../src/lib/chutes.js";

// Mock auth reader
vi.mock("../src/lib/opencode-auth.js", () => ({
  readAuthFile: vi.fn(),
}));

describe("queryChutesQuota", () => {
  const originalEnv = process.env;
  const originalCwd = process.cwd();
  let tempDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));

    tempDir = mkdtempSync(join(tmpdir(), "opencode-quota-chutes-"));
    process.env = { ...originalEnv, XDG_CONFIG_HOME: tempDir };
    process.chdir(tempDir);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();

    process.chdir(originalCwd);
    process.env = originalEnv;
    rmSync(tempDir, { recursive: true, force: true });

    vi.unstubAllGlobals();
  });

  it("returns null when not configured", async () => {
    const { readAuthFile } = await import("../src/lib/opencode-auth.js");
    (readAuthFile as any).mockResolvedValueOnce({});

    // Ensure env is empty
    delete process.env.CHUTES_API_KEY;

    await expect(queryChutesQuota()).resolves.toBeNull();
  });

  it("returns quota data from API", async () => {
    process.env.CHUTES_API_KEY = "test-key";

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              quota: 1000,
              used: 250,
            }),
            { status: 200 },
          ),
      ) as any,
    );

    const out = await queryChutesQuota();
    expect(out && out.success ? out.percentRemaining : -1).toBe(75);
    expect(out && out.success ? out.resetTimeIso : "").toBe("2026-01-02T00:00:00.000Z");
  });

  it("handles API errors", async () => {
    process.env.CHUTES_API_KEY = "test-key";

    vi.stubGlobal("fetch", vi.fn(async () => new Response("Unauthorized", { status: 401 })) as any);

    const out = await queryChutesQuota();
    expect(out && !out.success ? out.error : "").toContain("Chutes API error 401");
  });

  it("handles zero quota safely", async () => {
    process.env.CHUTES_API_KEY = "test-key";

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              quota: 0,
              used: 0,
            }),
            { status: 200 },
          ),
      ) as any,
    );

    const out = await queryChutesQuota();
    expect(out && out.success ? out.percentRemaining : -1).toBe(0);
  });
});
