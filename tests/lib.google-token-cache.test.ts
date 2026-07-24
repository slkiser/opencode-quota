import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("fs/promises", () => ({
  mkdir: vi.fn(async () => undefined),
  readFile: vi.fn(async () => {
    throw new Error("missing");
  }),
  rename: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
}));

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirs: () => ({
    dataDir: "/tmp/data/opencode",
    configDir: "/tmp/config/opencode",
    cacheDir: "/tmp/cache/opencode",
    stateDir: "/tmp/state/opencode",
  }),
}));

const CACHE_PATH = "/tmp/cache/opencode/opencode-quota/google-access-tokens.json";

function entry(accessToken: string) {
  return {
    accessToken,
    expiresAt: Date.now() + 60_000,
    projectId: "project-1",
    email: "user@example.com",
  };
}

describe("google-token-cache", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("atomically writes version 1 cache files with restrictive permissions", async () => {
    const { mkdir, rename, writeFile } = await import("fs/promises");
    const { setCachedAccessToken } = await import("../src/lib/google-token-cache.js");

    await setCachedAccessToken({ key: "account-key", entry: entry("access-token") });

    expect(mkdir).toHaveBeenCalledWith("/tmp/cache/opencode/opencode-quota", {
      recursive: true,
      mode: 0o700,
    });
    expect(writeFile).toHaveBeenCalledTimes(1);
    const [tmpPath, content, options] = (writeFile as any).mock.calls[0];
    expect(tmpPath).toContain(`${CACHE_PATH}.tmp-`);
    expect(options).toEqual({ encoding: "utf-8", mode: 0o600 });
    expect(JSON.parse(content)).toMatchObject({
      version: 1,
      tokens: { "account-key": { accessToken: "access-token" } },
    });
    expect(rename).toHaveBeenCalledWith(tmpPath, CACHE_PATH);
  });

  it("retains valid disk entries and discards invalid entries", async () => {
    const { readFile, writeFile } = await import("fs/promises");
    const expiresAt = Date.now() + 60_000;
    (readFile as any).mockResolvedValueOnce(
      JSON.stringify({
        version: 1,
        updatedAt: 123,
        tokens: {
          valid: {
            accessToken: "valid-token",
            expiresAt,
            projectId: "project-1",
            email: "user@example.com",
          },
          validWithoutEmail: {
            accessToken: "second-token",
            expiresAt,
            projectId: "project-2",
          },
          emptyAccessToken: { accessToken: " ", expiresAt, projectId: "project-3" },
          emptyProjectId: { accessToken: "token", expiresAt, projectId: "" },
          invalidExpiry: { accessToken: "token", expiresAt: "later", projectId: "project-4" },
          invalidEmail: {
            accessToken: "token",
            expiresAt,
            projectId: "project-5",
            email: 42,
          },
        },
      }),
    );
    const { getCachedAccessToken } = await import("../src/lib/google-token-cache.js");

    await expect(getCachedAccessToken({ key: "valid", skewMs: 0 })).resolves.toEqual({
      accessToken: "valid-token",
      expiresAt,
      projectId: "project-1",
      email: "user@example.com",
    });
    await expect(getCachedAccessToken({ key: "validWithoutEmail", skewMs: 0 })).resolves.toEqual({
      accessToken: "second-token",
      expiresAt,
      projectId: "project-2",
    });
    for (const key of ["emptyAccessToken", "emptyProjectId", "invalidExpiry", "invalidEmail"]) {
      await expect(getCachedAccessToken({ key, skewMs: 0 })).resolves.toBeNull();
    }
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("serializes concurrent updates without losing different accounts", async () => {
    const { writeFile } = await import("fs/promises");
    const { getCachedAccessToken, setCachedAccessToken } =
      await import("../src/lib/google-token-cache.js");

    await Promise.all([
      setCachedAccessToken({ key: "first", entry: entry("first-token") }),
      setCachedAccessToken({ key: "second", entry: entry("second-token") }),
    ]);

    expect(await getCachedAccessToken({ key: "first", skewMs: 0 })).toMatchObject({
      accessToken: "first-token",
    });
    expect(await getCachedAccessToken({ key: "second", skewMs: 0 })).toMatchObject({
      accessToken: "second-token",
    });
    const finalContent = JSON.parse((writeFile as any).mock.calls.at(-1)[1]);
    expect(finalContent.tokens).toMatchObject({
      first: { accessToken: "first-token" },
      second: { accessToken: "second-token" },
    });
  });

  it("applies same-account updates in invocation order", async () => {
    const { setCachedAccessToken, getCachedAccessToken } =
      await import("../src/lib/google-token-cache.js");

    await Promise.all([
      setCachedAccessToken({ key: "account", entry: entry("first-token") }),
      setCachedAccessToken({ key: "account", entry: entry("second-token") }),
    ]);

    expect(await getCachedAccessToken({ key: "account", skewMs: 0 })).toMatchObject({
      accessToken: "second-token",
    });
  });

  it("serializes clear and set operations in invocation order", async () => {
    const { clearGoogleTokenCache, getCachedAccessToken, setCachedAccessToken } =
      await import("../src/lib/google-token-cache.js");

    await setCachedAccessToken({ key: "old", entry: entry("old-token") });
    await Promise.all([
      clearGoogleTokenCache(),
      setCachedAccessToken({ key: "new", entry: entry("new-token") }),
    ]);

    expect(await getCachedAccessToken({ key: "old", skewMs: 0 })).toBeNull();
    expect(await getCachedAccessToken({ key: "new", skewMs: 0 })).toMatchObject({
      accessToken: "new-token",
    });
  });

  it("publishes memory only after persistence and continues after a write failure", async () => {
    const { writeFile } = await import("fs/promises");
    const { getCachedAccessToken, setCachedAccessToken } =
      await import("../src/lib/google-token-cache.js");

    await setCachedAccessToken({ key: "account", entry: entry("committed-token") });
    (writeFile as any).mockRejectedValueOnce(new Error("disk full"));

    await expect(
      setCachedAccessToken({ key: "account", entry: entry("failed-token") }),
    ).rejects.toThrow("disk full");
    expect(await getCachedAccessToken({ key: "account", skewMs: 0 })).toMatchObject({
      accessToken: "committed-token",
    });

    await setCachedAccessToken({ key: "account", entry: entry("recovered-token") });
    expect(await getCachedAccessToken({ key: "account", skewMs: 0 })).toMatchObject({
      accessToken: "recovered-token",
    });
  });
});
