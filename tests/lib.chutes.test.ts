import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { queryChutesQuota } from "../src/lib/chutes.js";

// Mock auth reader
vi.mock("../src/lib/opencode-auth.js", () => ({
  readAuthFile: vi.fn(),
}));

// Mock config paths
vi.mock("../src/lib/chutes-config.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    getOpencodeConfigCandidatePaths: vi.fn(() => []),
  };
});

describe("queryChutesQuota", () => {
  beforeEach(() => {
    vi.stubGlobal("process", {
      ...process,
      env: { ...process.env },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
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
