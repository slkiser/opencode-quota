import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

vi.mock("../src/lib/opencode-auth.js", () => ({
  readAuthFile: vi.fn(),
}));

describe("queryNanoGptQuota", () => {
  const originalEnv = process.env;
  const originalCwd = process.cwd();
  let tempDir: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));

    tempDir = mkdtempSync(join(tmpdir(), "opencode-quota-nanogpt-"));

    vi.stubEnv("XDG_CONFIG_HOME", tempDir);
    vi.stubEnv("XDG_DATA_HOME", join(tempDir, "data"));
    vi.stubEnv("HOME", tempDir);

    process.chdir(tempDir);

    vi.clearAllMocks();

    await vi.resetModules();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.unstubAllEnvs();
    vi.useRealTimers();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns null when not configured", async () => {
    const { queryNanoGptQuota } = await import("../src/lib/nanogpt.js");
    const { readAuthFile } = await import("../src/lib/opencode-auth.js");
    (readAuthFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce({});

    vi.stubEnv("NANOGPT_API_KEY", "");

    const result = await queryNanoGptQuota();
    expect(result).toBeNull();
  });

  it("returns quota data from API via env var", async () => {
    vi.stubEnv("NANOGPT_API_KEY", "test-key");

    const { queryNanoGptQuota } = await import("../src/lib/nanogpt.js");

    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            active: true,
            limits: { weeklyInputTokens: 60000000, dailyInputTokens: null, dailyImages: 100 },
            weeklyInputTokens: {
              used: 59650170,
              remaining: 349830,
              percentUsed: 0.9941695,
              resetAt: 1774224000000,
            },
            dailyInputTokens: null,
            dailyImages: {
              used: 0,
              remaining: 100,
              percentUsed: 0,
              resetAt: 1774224000000,
            },
            state: "active",
          }),
          { status: 200 },
        ),
    ) as ReturnType<typeof vi.fn>;
    vi.stubGlobal("fetch", fetchMock);

    const out = await queryNanoGptQuota();
    expect(out && out.success ? out.label : "").toBe("NanoGPT");
    expect(out && out.success ? out.windows.weeklyTokens?.percentRemaining : -1).toBe(1);
    expect(out && out.success ? out.windows.dailyImages?.percentRemaining : -1).toBe(100);
  });

  it("handles API errors", async () => {
    vi.stubEnv("NANOGPT_API_KEY", "test-key");

    const { queryNanoGptQuota } = await import("../src/lib/nanogpt.js");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Unauthorized", { status: 401 })) as ReturnType<typeof vi.fn>,
    );

    const out = await queryNanoGptQuota();
    expect(out && !out.success ? out.error : "").toContain("NanoGPT API error 401");
  });

  it("handles inactive subscription", async () => {
    vi.stubEnv("NANOGPT_API_KEY", "test-key");

    const { queryNanoGptQuota } = await import("../src/lib/nanogpt.js");

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              active: false,
              state: "inactive",
            }),
            { status: 200 },
          ),
      ) as ReturnType<typeof vi.fn>,
    );

    const out = await queryNanoGptQuota();
    expect(out && !out.success ? out.error : "").toContain("subscription inactive");
  });

  it("sanitizes API error text before returning it", async () => {
    vi.stubEnv("NANOGPT_API_KEY", "test-key");

    const { queryNanoGptQuota } = await import("../src/lib/nanogpt.js");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Unauthorized\u001b[31m", { status: 401 })) as ReturnType<
        typeof vi.fn
      >,
    );

    const out = await queryNanoGptQuota();
    expect(out && !out.success ? out.error : "").toBe("NanoGPT API error 401: Unauthorized");
  });

  it("reads auth.json nano-gpt key", async () => {
    const { queryNanoGptQuota } = await import("../src/lib/nanogpt.js");
    const { readAuthFile } = await import("../src/lib/opencode-auth.js");
    (readAuthFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      "nano-gpt": {
        type: "api",
        key: "auth-json-key",
      },
    });

    vi.stubEnv("NANOGPT_API_KEY", "");

    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            active: true,
            weeklyInputTokens: {
              used: 0,
              remaining: 60000000,
              percentUsed: 0,
              resetAt: 1738540800000,
            },
            state: "active",
          }),
          { status: 200 },
        ),
    ) as ReturnType<typeof vi.fn>;
    vi.stubGlobal("fetch", fetchMock);

    const out = await queryNanoGptQuota();
    expect(out && out.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://nano-gpt.com/api/subscription/v1/usage",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer auth-json-key",
        }),
      }),
    );
  });

  it("reads nanogpt api keys from trusted global config", async () => {
    mkdirSync(join(tempDir, "opencode"), { recursive: true });
    writeFileSync(
      join(tempDir, "opencode", "opencode.json"),
      JSON.stringify({
        provider: {
          nanogpt: {
            options: {
              apiKey: "global-config-key",
            },
          },
        },
      }),
      "utf-8",
    );

    const { queryNanoGptQuota } = await import("../src/lib/nanogpt.js");
    const { readAuthFile } = await import("../src/lib/opencode-auth.js");
    (readAuthFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce({});

    vi.stubEnv("NANOGPT_API_KEY", "");

    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            active: true,
            weeklyInputTokens: {
              used: 0,
              remaining: 60000000,
              percentUsed: 0,
              resetAt: 1738540800000,
            },
            state: "active",
          }),
          { status: 200 },
        ),
    ) as ReturnType<typeof vi.fn>;
    vi.stubGlobal("fetch", fetchMock);

    const out = await queryNanoGptQuota();
    expect(out && out.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://nano-gpt.com/api/subscription/v1/usage",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer global-config-key",
        }),
      }),
    );
  });

  it("reads nanogpt-custom provider from config", async () => {
    mkdirSync(join(tempDir, "opencode"), { recursive: true });
    writeFileSync(
      join(tempDir, "opencode", "opencode.json"),
      JSON.stringify({
        provider: {
          "nanogpt-custom": {
            options: {
              apiKey: "custom-provider-key",
            },
          },
        },
      }),
      "utf-8",
    );

    const { queryNanoGptQuota } = await import("../src/lib/nanogpt.js");
    const { readAuthFile } = await import("../src/lib/opencode-auth.js");
    (readAuthFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce({});

    vi.stubEnv("NANOGPT_API_KEY", "");

    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            active: true,
            weeklyInputTokens: {
              used: 0,
              remaining: 60000000,
              percentUsed: 0,
              resetAt: 1738540800000,
            },
            state: "active",
          }),
          { status: 200 },
        ),
    ) as ReturnType<typeof vi.fn>;
    vi.stubGlobal("fetch", fetchMock);

    const out = await queryNanoGptQuota();
    expect(out && out.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://nano-gpt.com/api/subscription/v1/usage",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer custom-provider-key",
        }),
      }),
    );
  });

  it("rejects arbitrary env templates in trusted global config", async () => {
    vi.stubEnv("GITHUB_TOKEN", "github-secret");
    mkdirSync(join(tempDir, "opencode"), { recursive: true });
    writeFileSync(
      join(tempDir, "opencode", "opencode.json"),
      JSON.stringify({
        provider: {
          nanogpt: {
            options: {
              apiKey: "{env:GITHUB_TOKEN}",
            },
          },
        },
      }),
      "utf-8",
    );

    const { queryNanoGptQuota } = await import("../src/lib/nanogpt.js");
    const { readAuthFile } = await import("../src/lib/opencode-auth.js");
    (readAuthFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce({});

    vi.stubEnv("NANOGPT_API_KEY", "");

    const out = await queryNanoGptQuota();
    expect(out).toBeNull();
  });
});
