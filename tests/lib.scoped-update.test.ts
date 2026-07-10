import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  QUOTA_LATEST_SPEC,
  applyScopedUpdatePlan,
  isCanonicalQuotaUpdateSpec,
  planScopedUpdate,
  runScopedUpdateCommand,
  sanitizeOpenCodePackageSpec,
} from "../src/lib/scoped-update.js";

const tempDirs: string[] = [];
function tempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "opencode-quota-update-"));
  tempDirs.push(path);
  return path;
}
function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
function fixture() {
  const root = tempDir();
  const project = join(root, "project");
  const global = join(root, "config", "opencode");
  const cache = join(root, "cache", "opencode");
  mkdirSync(join(project, ".git"), { recursive: true });
  return {
    root,
    project,
    global,
    cache,
    env: {
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_STATE_HOME: join(root, "state"),
    } satisfies NodeJS.ProcessEnv,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("scoped update specs and paths", () => {
  it("accepts only bare, latest, and exact SemVer package specs", () => {
    for (const spec of [
      "@slkiser/opencode-quota",
      "@slkiser/opencode-quota@latest",
      "@slkiser/opencode-quota@3.11.1",
      "@slkiser/opencode-quota@3.11.2-beta.1+build.2",
    ])
      expect(isCanonicalQuotaUpdateSpec(spec)).toBe(true);
    for (const spec of [
      "@slkiser/opencode-quota@next",
      "@slkiser/opencode-quota@^3.11.1",
      "@slkiser/opencode-quota@~3.11.1",
      "npm:@slkiser/opencode-quota@3.11.1",
      "file:../opencode-quota",
      "workspace:*",
      "https://example.test/opencode-quota.tgz",
    ])
      expect(isCanonicalQuotaUpdateSpec(spec)).toBe(false);
  });

  it("matches OpenCode Windows sanitization without changing slashes", () => {
    expect(sanitizeOpenCodePackageSpec("@scope/pkg@1.0.0", "linux")).toBe("@scope/pkg@1.0.0");
    expect(sanitizeOpenCodePackageSpec("@scope/pkg@file:C:\\pkg?x", "win32")).toBe(
      "@scope/pkg@file_C_\\pkg_x",
    );
  });

  it.each([
    ["linux", "/home/u/.config", "/home/u/.cache"],
    ["darwin", "/Users/u/Library/Application Support", "/Users/u/Library/Caches"],
    ["win32", "C:/Users/u/AppData/Roaming", "C:/Users/u/AppData/Local"],
  ] as const)("uses primary %s runtime roots", async (platform, configBase, cacheBase) => {
    const root = tempDir();
    const project = join(root, "project");
    mkdirSync(join(project, ".git"), { recursive: true });
    const env: NodeJS.ProcessEnv = {
      XDG_CONFIG_HOME: configBase,
      XDG_CACHE_HOME: cacheBase,
      XDG_DATA_HOME: join(root, "data"),
      XDG_STATE_HOME: join(root, "state"),
    };
    const plan = await planScopedUpdate({
      cwd: project,
      env,
      homeDir: join(root, "home"),
      platform,
    });
    expect(plan.configPaths).toEqual([]);
    expect(plan.cacheCandidates.some((path) => path.startsWith(join(cacheBase, "opencode")))).toBe(
      true,
    );
  });
});

describe("scoped update config planning", () => {
  it("prefers JSONC, preserves comments/format/options, and leaves custom specs untouched", async () => {
    const f = fixture();
    const jsonc = join(f.project, "opencode.jsonc");
    const ignoredJson = join(f.project, "opencode.json");
    const original = `{\n  // keep this comment\n  "plugin": [\n    "@slkiser/opencode-quota@3.11.1",\n    ["@slkiser/opencode-quota", { "setting": true }],\n    "@slkiser/opencode-quota@next",\n    "other-plugin",\n  ],\n  "unrelated": { "keep": true },\n}\n`;
    write(jsonc, original);
    write(ignoredJson, `{"plugin":["@slkiser/opencode-quota@1.0.0"]}`);
    const plan = await planScopedUpdate({
      cwd: join(f.project, "nested"),
      env: f.env,
      homeDir: join(f.root, "home"),
      platform: "linux",
    });
    expect(plan.configPaths).toEqual([jsonc]);
    const updated = plan.configEdits[0]!.updated;
    expect(updated).toContain("// keep this comment");
    expect(updated).toContain(`["${QUOTA_LATEST_SPEC}", { "setting": true }]`);
    expect(updated).toContain('"@slkiser/opencode-quota@next"');
    expect(updated).toContain('"other-plugin"');
    expect(updated).toContain('"unrelated": { "keep": true }');
    expect(readFileSync(ignoredJson, "utf8")).toContain("@1.0.0");
  });

  it("honors OPENCODE_CONFIG_DIR and deduplicates project/global real paths", async () => {
    const f = fixture();
    const config = join(f.project, "tui.jsonc");
    write(config, `{"plugin":["@slkiser/opencode-quota"]}`);
    const plan = await planScopedUpdate({
      cwd: f.project,
      env: { ...f.env, OPENCODE_CONFIG_DIR: f.project },
      homeDir: join(f.root, "home"),
    });
    expect(plan.configPaths).toEqual([config]);
  });

  it("aborts planning before writes when any selected config is unparseable", async () => {
    const f = fixture();
    const valid = join(f.project, "opencode.json");
    write(valid, `{"plugin":["@slkiser/opencode-quota@3.11.1"]}`);
    write(join(f.global, "tui.jsonc"), `{ nope`);
    await expect(
      planScopedUpdate({ cwd: f.project, env: f.env, homeDir: join(f.root, "home") }),
    ).rejects.toThrow("unparseable");
    expect(readFileSync(valid, "utf8")).toContain("@3.11.1");
  });

  it("is idempotent after applying its targeted edits", async () => {
    const f = fixture();
    const config = join(f.project, "opencode.json");
    write(config, `{"plugin":["@slkiser/opencode-quota@3.11.1","other"]}`);
    const params = { cwd: f.project, env: f.env, homeDir: join(f.root, "home") };
    await applyScopedUpdatePlan(await planScopedUpdate(params));
    expect((await planScopedUpdate(params)).configEdits).toEqual([]);
    expect(readFileSync(config, "utf8")).toBe(`{"plugin":["${QUOTA_LATEST_SPEC}","other"]}`);
  });
});

describe("scoped update application safety", () => {
  it("rejects a race in an unchanged @latest config before cache deletion", async () => {
    const f = fixture();
    const config = join(f.project, "opencode.json");
    write(config, `{"plugin":["@slkiser/opencode-quota@latest"]}`);
    const cache = join(f.cache, "packages", "@slkiser", "opencode-quota@latest");
    const manifest = join(cache, "node_modules", "@slkiser", "opencode-quota", "package.json");
    write(manifest, `{"name":"@slkiser/opencode-quota"}`);
    const plan = await planScopedUpdate({
      cwd: f.project,
      env: f.env,
      homeDir: join(f.root, "home"),
    });

    write(config, `{"plugin":["other-plugin"]}`);

    await expect(applyScopedUpdatePlan(plan)).rejects.toThrow("changed since preview");
    expect(readFileSync(manifest, "utf8")).toContain("@slkiser/opencode-quota");
  });

  it("revalidates @latest authority immediately before deleting cache", async () => {
    const f = fixture();
    const config = join(f.project, "opencode.json");
    write(config, `{"plugin":["@slkiser/opencode-quota@3.11.1"]}`);
    const cache = join(f.cache, "packages", "@slkiser", "opencode-quota@latest");
    const manifest = join(cache, "node_modules", "@slkiser", "opencode-quota", "package.json");
    write(manifest, `{"name":"@slkiser/opencode-quota"}`);
    const plan = await planScopedUpdate({
      cwd: f.project,
      env: f.env,
      homeDir: join(f.root, "home"),
    });

    await expect(
      applyScopedUpdatePlan(plan, {
        beforeCacheDeletion: async () => {
          write(config, `{"plugin":["other-plugin"]}`);
        },
      }),
    ).rejects.toThrow("changed before cache deletion");
    expect(readFileSync(manifest, "utf8")).toContain("@slkiser/opencode-quota");
  });

  it.each(["read", "write"] as const)(
    "reports earlier writes when a later config %s fails",
    async (failureKind) => {
      const f = fixture();
      const first = join(f.project, "opencode.json");
      const second = join(f.global, "tui.json");
      write(first, `{"plugin":["@slkiser/opencode-quota@3.11.1"]}`);
      write(second, `{"plugin":["@slkiser/opencode-quota@3.11.1"]}`);
      const plan = await planScopedUpdate({
        cwd: f.project,
        env: f.env,
        homeDir: join(f.root, "home"),
      });
      let reads = 0;
      let writes = 0;

      const promise = applyScopedUpdatePlan(plan, {
        readBytes: async (path) => {
          reads++;
          if (failureKind === "read" && reads === 2) throw new Error("read failed");
          return readFileSync(path);
        },
        writeText: async (path, content) => {
          writes++;
          if (failureKind === "write" && writes === 2) throw new Error("write failed");
          write(path, content);
        },
      });

      const error = await promise.catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        details: { writtenPaths: [first] },
      });
      expect(String(error)).toContain("Changed before failure");
      expect(readFileSync(first, "utf8")).toContain("@latest");
      expect(readFileSync(second, "utf8")).toContain("@3.11.1");
    },
  );

  it("detects raw-byte races before writing", async () => {
    const f = fixture();
    const config = join(f.project, "opencode.json");
    write(config, `{"plugin":["@slkiser/opencode-quota@3.11.1"]}`);
    const plan = await planScopedUpdate({
      cwd: f.project,
      env: f.env,
      homeDir: join(f.root, "home"),
    });
    write(config, `{"plugin":["@slkiser/opencode-quota@3.11.1"],"raced":true}`);
    await expect(applyScopedUpdatePlan(plan)).rejects.toThrow("changed since preview");
    expect(readFileSync(config, "utf8")).toContain('"raced":true');
  });

  it("removes only manifest-verified derived cache directories", async () => {
    const f = fixture();
    write(
      join(f.project, "opencode.json"),
      `{"plugin":["@slkiser/opencode-quota@3.11.1","other-plugin"]}`,
    );
    const quotaCache = join(f.cache, "packages", "@slkiser", "opencode-quota@3.11.1");
    const latestCache = join(f.cache, "packages", "@slkiser", "opencode-quota@latest");
    const otherCache = join(f.cache, "packages", "other-plugin");
    for (const path of [quotaCache, latestCache])
      write(
        join(path, "node_modules", "@slkiser", "opencode-quota", "package.json"),
        `{"name":"@slkiser/opencode-quota"}`,
      );
    write(
      join(otherCache, "node_modules", "other-plugin", "package.json"),
      `{"name":"other-plugin"}`,
    );
    const result = await applyScopedUpdatePlan(
      await planScopedUpdate({ cwd: f.project, env: f.env, homeDir: join(f.root, "home") }),
    );
    expect(result.removedCachePaths).toEqual(expect.arrayContaining([quotaCache, latestCache]));
    expect(() =>
      readFileSync(join(otherCache, "node_modules", "other-plugin", "package.json")),
    ).not.toThrow();
  });

  it("skips symlinks and wrong manifests without broadening deletion", async () => {
    const f = fixture();
    write(join(f.project, "opencode.json"), `{"plugin":["@slkiser/opencode-quota@3.11.1"]}`);
    const outside = join(f.root, "outside");
    mkdirSync(outside);
    const exact = join(f.cache, "packages", "@slkiser", "opencode-quota@3.11.1");
    mkdirSync(dirname(exact), { recursive: true });
    symlinkSync(outside, exact);
    const latest = join(f.cache, "packages", "@slkiser", "opencode-quota@latest");
    write(
      join(latest, "node_modules", "@slkiser", "opencode-quota", "package.json"),
      `{"name":"not-the-package"}`,
    );
    const result = await applyScopedUpdatePlan(
      await planScopedUpdate({ cwd: f.project, env: f.env, homeDir: join(f.root, "home") }),
    );
    expect(result.removedCachePaths).toEqual([]);
    expect(result.skippedCachePaths).toEqual(expect.arrayContaining([exact, latest]));
  });

  it("dry-run and declined confirmation do not change config or cache", async () => {
    const f = fixture();
    const config = join(f.project, "opencode.json");
    const original = `{"plugin":["@slkiser/opencode-quota@3.11.1"]}`;
    write(config, original);
    const common = { cwd: f.project, env: f.env, homeDir: join(f.root, "home"), log: vi.fn() };
    expect(await runScopedUpdateCommand({ ...common, argv: ["--dry-run"] })).toBe(0);
    expect(readFileSync(config, "utf8")).toBe(original);
    const confirm = vi.fn().mockResolvedValue(false);
    expect(await runScopedUpdateCommand({ ...common, confirm })).toBe(0);
    expect(confirm).toHaveBeenCalledOnce();
    expect(readFileSync(config, "utf8")).toBe(original);
  });
});
