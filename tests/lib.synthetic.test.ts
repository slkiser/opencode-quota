import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { querySyntheticQuota } from "../src/lib/synthetic.js";

vi.mock("../src/lib/opencode-auth.js", () => ({
  readAuthFile: vi.fn(),
}));

describe("querySyntheticQuota", () => {
  const originalEnv = process.env;
  const originalCwd = process.cwd();
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "opencode-quota-synthetic-"));
    process.env = { ...originalEnv, XDG_CONFIG_HOME: tempDir };
    process.chdir(tempDir);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.chdir(originalCwd);
    process.env = originalEnv;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns null when not configured", async () => {
    const { readAuthFile } = await import("../src/lib/opencode-auth.js");
    (readAuthFile as any).mockResolvedValueOnce({});

    delete process.env.SYNTHETIC_API_KEY;

    await expect(querySyntheticQuota()).resolves.toBeNull();
  });

  it("returns quota data from API", async () => {
    process.env.SYNTHETIC_API_KEY = "test-key";

    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            subscription: {
              limit: 100,
              requests: 25,
              renewsAt: "2026-01-20T18:12:03.000Z",
            },
          }),
          { status: 200 },
        ),
    ) as any;
    vi.stubGlobal("fetch", fetchMock);

    const out = await querySyntheticQuota();
    expect(out).toEqual({
      success: true,
      requestLimit: 100,
      usedRequests: 25,
      percentRemaining: 75,
      resetTimeIso: "2026-01-20T18:12:03.000Z",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.synthetic.new/v2/quotas",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-key",
        }),
      }),
    );
  });

  it("handles API errors and sanitizes response text", async () => {
    process.env.SYNTHETIC_API_KEY = "test-key";

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Unauthorized\u001b[31m", { status: 401 })) as any,
    );

    const out = await querySyntheticQuota();
    expect(out).toEqual({
      success: false,
      error: "Synthetic API error 401: Unauthorized",
    });
  });

  it("ignores repo-local provider config for secret lookup", async () => {
    writeFileSync(
      join(tempDir, "opencode.json"),
      JSON.stringify({
        provider: {
          synthetic: {
            options: {
              apiKey: "{env:SYNTHETIC_API_KEY}",
            },
          },
        },
      }),
      "utf-8",
    );

    const out = await querySyntheticQuota();
    expect(out).toBeNull();
  });

  it("reads synthetic api keys from trusted global config only", async () => {
    mkdirSync(join(tempDir, "opencode"), { recursive: true });
    writeFileSync(
      join(tempDir, "opencode", "opencode.json"),
      JSON.stringify({
        provider: {
          synthetic: {
            options: {
              apiKey: "global-config-key",
            },
          },
        },
      }),
      "utf-8",
    );

    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            subscription: {
              limit: 100,
              requests: 25,
            },
          }),
          { status: 200 },
        ),
    ) as any;
    vi.stubGlobal("fetch", fetchMock);

    const out = await querySyntheticQuota();
    expect(out).toEqual({
      success: true,
      requestLimit: 100,
      usedRequests: 25,
      percentRemaining: 75,
      resetTimeIso: undefined,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.synthetic.new/v2/quotas",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer global-config-key",
        }),
      }),
    );
  });

  it("rejects arbitrary env templates in trusted global config", async () => {
    process.env.GITHUB_TOKEN = "github-secret";
    mkdirSync(join(tempDir, "opencode"), { recursive: true });
    writeFileSync(
      join(tempDir, "opencode", "opencode.json"),
      JSON.stringify({
        provider: {
          synthetic: {
            options: {
              apiKey: "{env:GITHUB_TOKEN}",
            },
          },
        },
      }),
      "utf-8",
    );

    const out = await querySyntheticQuota();
    expect(out).toBeNull();
  });

  it("clamps over-limit request usage to zero percent remaining", async () => {
    process.env.SYNTHETIC_API_KEY = "test-key";

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              subscription: {
                limit: 100,
                requests: 125,
              },
            }),
            { status: 200 },
          ),
      ) as any,
    );

    const out = await querySyntheticQuota();
    expect(out).toEqual({
      success: true,
      requestLimit: 100,
      usedRequests: 125,
      percentRemaining: 0,
      resetTimeIso: undefined,
    });
  });

  it("returns a provider error for invalid payloads", async () => {
    process.env.SYNTHETIC_API_KEY = "test-key";

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              subscription: {
                requests: 25,
              },
            }),
            { status: 200 },
          ),
      ) as any,
    );

    const out = await querySyntheticQuota();
    expect(out).toEqual({
      success: false,
      error: "Synthetic API response missing subscription.limit",
    });
  });
});
