import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const runtime = vi.hoisted(() => ({ cacheDir: "" }));

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirs: () => ({ cacheDir: runtime.cacheDir }),
}));

function entry(accessToken: string, expiresAt = Date.now() + 60_000) {
  return { accessToken, expiresAt };
}

describe("google-token-cache", () => {
  let legacyCachePath: string;

  beforeEach(async () => {
    vi.resetModules();
    runtime.cacheDir = await mkdtemp(join(tmpdir(), "opencode-quota-google-token-cache-"));
    legacyCachePath = join(runtime.cacheDir, "opencode-quota", "google-access-tokens.json");
  });

  afterEach(async () => {
    await rm(runtime.cacheDir, { recursive: true, force: true });
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
    await mkdir(dirname(legacyCachePath), { recursive: true });
    await writeFile(
      legacyCachePath,
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

    await expect(access(legacyCachePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(cache.getCachedAccessToken({ key: "opaque-account", skewMs: 0 })).resolves.toEqual(
      cachedEntry,
    );
    expect(await readdir(dirname(legacyCachePath))).toEqual([]);
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
    await expect(access(legacyCachePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps both accounts when two updates run at once", async () => {
    const cache = await import("../src/lib/google-token-cache.js");
    await Promise.all([
      cache.setCachedAccessToken({ key: "first", entry: entry("first-token") }),
      cache.setCachedAccessToken({ key: "second", entry: entry("second-token") }),
    ]);

    for (const key of ["first", "second"]) {
      await expect(cache.getCachedAccessToken({ key, skewMs: 0 })).resolves.toMatchObject({
        accessToken: `${key}-token`,
      });
    }
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
    await mkdir(legacyCachePath, { recursive: true });
    const cache = await import("../src/lib/google-token-cache.js");

    await cache.setCachedAccessToken({ key: "account", entry: entry("token") });
    expect((await readdir(legacyCachePath)).length).toBe(0);

    await rm(legacyCachePath, { recursive: true, force: true });
    await mkdir(dirname(legacyCachePath), { recursive: true });
    await writeFile(legacyCachePath, "legacy-pii-after-transient-failure", "utf8");
    await expect(cache.getCachedAccessToken({ key: "account", skewMs: 0 })).resolves.toMatchObject({
      accessToken: "token",
    });
    await expect(access(legacyCachePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
