import { access, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testPaths = vi.hoisted(() => {
  const separator = process.platform === "win32" ? "\\" : "/";
  const join = (...parts: string[]) => parts.join(separator);
  const root = join(process.cwd(), ".google-token-cache-test");
  return {
    root,
    dataDir: join(root, "data"),
    configDir: join(root, "config"),
    cacheDir: join(root, "cache"),
    stateDir: join(root, "state"),
    cachePath: join(root, "cache", "opencode-quota", "google-access-tokens.json"),
  };
});

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirs: () => ({
    dataDir: testPaths.dataDir,
    configDir: testPaths.configDir,
    cacheDir: testPaths.cacheDir,
    stateDir: testPaths.stateDir,
  }),
}));

const TEST_RUNTIME_ROOT = testPaths.root;
const CACHE_PATH = testPaths.cachePath;

function entry(accessToken: string, expiresAt = Date.now() + 60_000) {
  return { accessToken, expiresAt };
}

describe("google-token-cache", () => {
  beforeEach(async () => {
    vi.resetModules();
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
  });

  afterEach(async () => {
    vi.resetModules();
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
  });

  it("uses opaque process-local account keys without PII or reusable credential verifiers", async () => {
    const { makeAccountCacheKey } = await import("../src/lib/google-token-cache.js");
    const first = makeAccountCacheKey({
      refreshToken: "refresh-secret-one",
      projectId: "private-project-one",
    });
    const repeat = makeAccountCacheKey({
      refreshToken: "refresh-secret-one",
      projectId: "private-project-one",
    });
    const changedToken = makeAccountCacheKey({
      refreshToken: "refresh-secret-two",
      projectId: "private-project-one",
    });
    const changedProject = makeAccountCacheKey({
      refreshToken: "refresh-secret-one",
      projectId: "private-project-two",
    });

    expect(first).toMatch(/^gat1_[A-Za-z0-9_-]{43}$/u);
    expect(first).toBe(repeat);
    expect(changedToken).not.toBe(first);
    expect(changedProject).not.toBe(first);
    expect(JSON.stringify({ first })).not.toMatch(/refresh-secret|private-project/u);
  });

  it("migrates by deleting the legacy PII-bearing disk cache without reading or replacing it", async () => {
    await mkdir(dirname(CACHE_PATH), { recursive: true });
    await writeFile(
      CACHE_PATH,
      JSON.stringify({
        version: 1,
        entries: {
          "alice@example.com::private-project::reusable-unkeyed-verifier": {
            accessToken: "legacy-access-token",
            expiresAt: Date.now() + 60_000,
            projectId: "private-project",
            email: "alice@example.com",
          },
        },
      }),
      "utf8",
    );

    const cache = await import("../src/lib/google-token-cache.js");
    const cachedEntry = entry("new-process-token");
    await cache.setCachedAccessToken({ key: "opaque-account", entry: cachedEntry });

    await expect(access(CACHE_PATH)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(cache.getCachedAccessToken({ key: "opaque-account", skewMs: 0 })).resolves.toEqual(
      cachedEntry,
    );
    expect(await readdir(dirname(CACHE_PATH))).toEqual([]);
  });

  it("keeps valid tokens process-local and removes expired entries", async () => {
    const cache = await import("../src/lib/google-token-cache.js");
    const validEntry = entry("valid-token");
    await cache.setCachedAccessToken({ key: "valid", entry: validEntry });
    await cache.setCachedAccessToken({ key: "expired", entry: entry("expired-token", Date.now()) });

    const valid = await cache.getCachedAccessToken({ key: "valid", skewMs: 0 });
    expect(valid).toEqual(validEntry);
    if (valid) valid.accessToken = "mutated";
    await expect(cache.getCachedAccessToken({ key: "valid", skewMs: 0 })).resolves.toEqual(
      validEntry,
    );
    await expect(cache.getCachedAccessToken({ key: "expired", skewMs: 0 })).resolves.toBeNull();
    await expect(access(CACHE_PATH)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes concurrent updates without losing different accounts", async () => {
    const cache = await import("../src/lib/google-token-cache.js");
    await Promise.all([
      cache.setCachedAccessToken({ key: "first", entry: entry("first-token") }),
      cache.setCachedAccessToken({ key: "second", entry: entry("second-token") }),
    ]);

    await expect(cache.getCachedAccessToken({ key: "first", skewMs: 0 })).resolves.toMatchObject({
      accessToken: "first-token",
    });
    await expect(cache.getCachedAccessToken({ key: "second", skewMs: 0 })).resolves.toMatchObject({
      accessToken: "second-token",
    });
  });

  it("does not reuse memory or opaque account keys across module instances", async () => {
    const firstModule = await import("../src/lib/google-token-cache.js");
    const firstKey = firstModule.makeAccountCacheKey({
      refreshToken: "refresh-secret",
      projectId: "project-id",
    });
    await firstModule.setCachedAccessToken({ key: firstKey, entry: entry("first-token") });

    vi.resetModules();
    const secondModule = await import("../src/lib/google-token-cache.js");
    const secondKey = secondModule.makeAccountCacheKey({
      refreshToken: "refresh-secret",
      projectId: "project-id",
    });

    expect(secondKey).not.toBe(firstKey);
    await expect(
      secondModule.getCachedAccessToken({ key: secondKey, skewMs: 0 }),
    ).resolves.toBeNull();
  });

  it("retries a denied legacy cleanup without using an insecure fallback", async () => {
    await mkdir(CACHE_PATH, { recursive: true });
    const cache = await import("../src/lib/google-token-cache.js");

    await cache.setCachedAccessToken({ key: "account", entry: entry("token") });
    expect((await readdir(CACHE_PATH)).length).toBe(0);

    await rm(CACHE_PATH, { recursive: true, force: true });
    await mkdir(dirname(CACHE_PATH), { recursive: true });
    await writeFile(CACHE_PATH, "legacy-pii-after-transient-failure", "utf8");
    await expect(cache.getCachedAccessToken({ key: "account", skewMs: 0 })).resolves.toMatchObject({
      accessToken: "token",
    });
    await expect(access(CACHE_PATH)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("clears process memory and retries legacy cleanup", async () => {
    const cache = await import("../src/lib/google-token-cache.js");
    await cache.setCachedAccessToken({ key: "account", entry: entry("token") });
    await mkdir(dirname(CACHE_PATH), { recursive: true });
    await writeFile(CACHE_PATH, "legacy-pii", "utf8");
    await cache.clearGoogleTokenCache();

    await expect(cache.getCachedAccessToken({ key: "account", skewMs: 0 })).resolves.toBeNull();
    await expect(access(CACHE_PATH)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
