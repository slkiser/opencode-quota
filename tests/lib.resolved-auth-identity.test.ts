import { chmod, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_RUNTIME_ROOT = "/tmp/opencode-quota-resolved-auth-identity-tests";
const TEST_SYMLINK_TARGET = `${TEST_RUNTIME_ROOT}-symlink-target`;
const POSIX_IDENTITY_STORAGE = process.platform !== "win32" && typeof process.getuid === "function";

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirs: () => ({
    dataDir: `${TEST_RUNTIME_ROOT}/data`,
    configDir: `${TEST_RUNTIME_ROOT}/config`,
    cacheDir: `${TEST_RUNTIME_ROOT}/cache`,
    stateDir: `${TEST_RUNTIME_ROOT}/state`,
  }),
}));

describe("resolved-auth identity", () => {
  beforeEach(async () => {
    vi.resetModules();
    await Promise.all([
      rm(TEST_RUNTIME_ROOT, { recursive: true, force: true }),
      rm(TEST_SYMLINK_TARGET, { recursive: true, force: true }),
    ]);
  });

  afterEach(async () => {
    vi.resetModules();
    await Promise.all([
      rm(TEST_RUNTIME_ROOT, { recursive: true, force: true }),
      rm(TEST_SYMLINK_TARGET, { recursive: true, force: true }),
    ]);
  });

  it.runIf(POSIX_IDENTITY_STORAGE)(
    "derives stable provider-scoped opaque identities without exposing principal material",
    async () => {
      const identity = await import("../src/lib/resolved-auth-identity.js");
      const first = await identity.deriveResolvedAuthIdentity({
        providerId: "zai",
        principal: { kind: "credential", value: "account-one-secret" },
      });
      const repeat = await identity.deriveResolvedAuthIdentity({
        providerId: "zai",
        principal: { kind: "credential", value: "account-one-secret" },
      });
      const changedAccount = await identity.deriveResolvedAuthIdentity({
        providerId: "zai",
        principal: { kind: "credential", value: "account-two-secret" },
      });
      const changedProvider = await identity.deriveResolvedAuthIdentity({
        providerId: "zhipu",
        principal: { kind: "credential", value: "account-one-secret" },
      });

      expect(identity.isResolvedAuthIdentity(first)).toBe(true);
      expect(first).toBe(repeat);
      expect(changedAccount).not.toBe(first);
      expect(changedProvider).not.toBe(first);
      expect(first).not.toContain("account-one-secret");
    },
  );

  it.runIf(POSIX_IDENTITY_STORAGE)(
    "composes multi-account identities in deterministic order",
    async () => {
      const identity = await import("../src/lib/resolved-auth-identity.js");
      const first = await identity.deriveResolvedAuthIdentity({
        providerId: "google-agy",
        principal: { kind: "stable-id", value: "project-a\0one@example.com" },
      });
      const second = await identity.deriveResolvedAuthIdentity({
        providerId: "google-agy",
        principal: { kind: "stable-id", value: "project-b\0two@example.com" },
      });
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      if (!first || !second) throw new Error("Expected durable test identities");

      const ordered = await identity.composeResolvedAuthIdentities({
        providerId: "google-agy",
        identities: [first, second],
      });
      const repeat = await identity.composeResolvedAuthIdentities({
        providerId: "google-agy",
        identities: [first, second],
      });
      const reversed = await identity.composeResolvedAuthIdentities({
        providerId: "google-agy",
        identities: [second, first],
      });

      expect(ordered).toBe(repeat);
      expect(reversed).not.toBe(ordered);
      expect(JSON.stringify({ ordered })).not.toContain("one@example.com");
      expect(JSON.stringify({ ordered })).not.toContain("project-a");
    },
  );

  it.runIf(POSIX_IDENTITY_STORAGE)(
    "creates one private durable key during concurrent first use",
    async () => {
      const identity = await import("../src/lib/resolved-auth-identity.js");
      const values = await Promise.all(
        Array.from({ length: 12 }, () =>
          identity.deriveResolvedAuthIdentity({
            providerId: "synthetic",
            principal: { kind: "credential", value: "shared-secret" },
          }),
        ),
      );

      expect(new Set(values).size).toBe(1);
      const keyPath = identity.getResolvedAuthIdentityKeyPath();
      const raw = await readFile(keyPath, "utf8");
      expect(raw).toMatch(/^v1:[A-Za-z0-9_-]{43}\n$/u);
      expect(raw).not.toContain("shared-secret");
      if (process.platform !== "win32") {
        expect((await stat(dirname(keyPath))).mode & 0o777).toBe(0o700);
        expect((await stat(keyPath)).mode & 0o777).toBe(0o600);
      }
    },
  );

  it.runIf(POSIX_IDENTITY_STORAGE)(
    "converges isolated module instances through exclusive key creation",
    async () => {
      const firstModule = await import("../src/lib/resolved-auth-identity.js");
      vi.resetModules();
      const secondModule = await import("../src/lib/resolved-auth-identity.js");

      const [first, second] = await Promise.all([
        firstModule.deriveResolvedAuthIdentity({
          providerId: "zai",
          principal: { kind: "credential", value: "shared-process-secret" },
        }),
        secondModule.deriveResolvedAuthIdentity({
          providerId: "zai",
          principal: { kind: "credential", value: "shared-process-secret" },
        }),
      ]);

      expect(first).not.toBeNull();
      expect(second).toBe(first);
      expect(await readFile(firstModule.getResolvedAuthIdentityKeyPath(), "utf8")).toMatch(
        /^v1:[A-Za-z0-9_-]{43}\n$/u,
      );
    },
  );

  it.runIf(POSIX_IDENTITY_STORAGE)(
    "recovers when a losing first-use process initially observes a partial winner file",
    async () => {
      const identity = await import("../src/lib/resolved-auth-identity.js");
      const keyPath = identity.getResolvedAuthIdentityKeyPath();
      await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 });
      await writeFile(keyPath, "", { mode: 0o600 });

      const publishedKey = `v1:${Buffer.alloc(32, 7).toString("base64url")}\n`;
      const resolving = identity.deriveResolvedAuthIdentity({
        providerId: "zai",
        principal: { kind: "credential", value: "race-secret" },
      });
      await vi.waitFor(
        async () => {
          expect((await readdir(dirname(keyPath))).some((name) => name.includes(".tmp-"))).toBe(
            true,
          );
        },
        { timeout: 1_000, interval: 1 },
      );
      await writeFile(keyPath, publishedKey, { mode: 0o600 });
      const resolved = await resolving;

      expect(identity.isResolvedAuthIdentity(resolved)).toBe(true);
      expect(await readFile(keyPath, "utf8")).toBe(publishedKey);
      expect(
        await identity.deriveResolvedAuthIdentity({
          providerId: "zai",
          principal: { kind: "credential", value: "race-secret" },
        }),
      ).toBe(resolved);
    },
  );

  it("fails closed when private owner-bound storage cannot be guaranteed", async () => {
    const { isProtectedResolvedAuthStorageSupported } = await import(
      "../src/lib/resolved-auth-identity.js"
    );

    expect(
      isProtectedResolvedAuthStorageSupported({ platform: "win32", hasOwnerIdentity: true }),
    ).toBe(false);
    expect(
      isProtectedResolvedAuthStorageSupported({ platform: "linux", hasOwnerIdentity: false }),
    ).toBe(false);
    expect(
      isProtectedResolvedAuthStorageSupported({ platform: "linux", hasOwnerIdentity: true }),
    ).toBe(true);
  });

  it.runIf(POSIX_IDENTITY_STORAGE)(
    "refuses a symlinked key directory instead of redirecting key creation",
    async () => {
      const identity = await import("../src/lib/resolved-auth-identity.js");
      const keyPath = identity.getResolvedAuthIdentityKeyPath();
      await mkdir(dirname(dirname(keyPath)), { recursive: true });
      await mkdir(TEST_SYMLINK_TARGET, { recursive: true });
      await symlink(TEST_SYMLINK_TARGET, dirname(keyPath), "dir");

      const resolved = await identity.deriveResolvedAuthIdentity({
        providerId: "zai",
        principal: { kind: "credential", value: "must-not-leave-the-state-root" },
      });

      expect(resolved).toBeNull();
      await expect(
        readFile(`${TEST_SYMLINK_TARGET}/resolved-auth-key-v1`, "utf8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("refuses malformed key material without permanently memoizing the transient failure", async () => {
    const identity = await import("../src/lib/resolved-auth-identity.js");
    const keyPath = identity.getResolvedAuthIdentityKeyPath();
    await mkdir(dirname(keyPath), { recursive: true });
    await writeFile(keyPath, "not-a-valid-key\n", { mode: 0o666 });
    if (process.platform !== "win32") await chmod(keyPath, 0o666);

    const resolved = await identity.deriveResolvedAuthIdentity({
      providerId: "zai",
      principal: { kind: "credential", value: "must-not-be-hashed-with-fallback" },
    });

    expect(resolved).toBeNull();
    expect(await readFile(keyPath, "utf8")).toBe("not-a-valid-key\n");
    if (POSIX_IDENTITY_STORAGE) {
      expect((await stat(keyPath)).mode & 0o777).toBe(0o600);
      const publishedKey = `v1:${Buffer.alloc(32, 9).toString("base64url")}\n`;
      await writeFile(keyPath, publishedKey, { mode: 0o600 });
      const recovered = await identity.deriveResolvedAuthIdentity({
        providerId: "zai",
        principal: { kind: "credential", value: "must-not-be-hashed-with-fallback" },
      });
      expect(identity.isResolvedAuthIdentity(recovered)).toBe(true);
    }
  });
});
