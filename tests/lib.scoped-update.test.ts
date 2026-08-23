import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyScopedUpdatePlan,
  formatScopedUpdatePreview,
  isCanonicalQuotaUpdateSpec,
  planScopedUpdate,
  QUOTA_LATEST_SPEC,
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
function hasControlCharacter(text: string): boolean {
  return Array.from(text).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || (code >= 127 && code <= 159);
  });
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
  vi.unstubAllEnvs();
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

  it("combines package and display changes into one immutable document plan", async () => {
    const f = fixture();
    const config = join(f.project, "opencode.jsonc");
    write(
      config,
      `{
  // keep package and display formatting
  "plugin": ["@slkiser/opencode-quota@3.11.1"],
  "experimental": {
    "quotaToast": {
      "opencodeZenDisplay": "default",
      "unrelated": true,
    },
  },
}
`,
    );

    const plan = await planScopedUpdate({
      cwd: f.project,
      env: f.env,
      homeDir: join(f.root, "home"),
      platform: "linux",
    });

    expect(plan.configPaths).toEqual([config]);
    expect(plan.configSnapshots).toHaveLength(1);
    expect(plan.configSnapshots[0]).toMatchObject({
      path: config,
      changed: true,
      roles: ["package-authority", "package-edit", "display-migration"],
    });
    expect(plan.configEdits).toHaveLength(1);
    expect(plan.configEdits[0]).toMatchObject({
      path: config,
      replacements: 1,
      displayMigrations: 1,
    });
    expect(plan.configEdits[0]?.updated).toContain(QUOTA_LATEST_SPEC);
    expect(plan.configEdits[0]?.updated).toContain('"accountingDetail": "summary"');
    expect(plan.configEdits[0]?.updated).not.toContain("opencodeZenDisplay");
    expect(plan.configEdits[0]?.updated).toContain("// keep package and display formatting");
    expect(plan.safeActions).toEqual(
      expect.arrayContaining([
        { kind: "package-spec", path: config, replacements: 1 },
        expect.objectContaining({
          kind: "accounting-detail-migration",
          path: config,
          from: "default",
          to: "summary",
        }),
      ]),
    );
  });

  it("plans and applies a migration-only sidecar without granting cache authority", async () => {
    const f = fixture();
    const sidecar = join(f.project, "opencode-quota", "quota-toast.jsonc");
    write(sidecar, `{"opencodeZenDisplay":"detailed"}`);
    const cache = join(f.cache, "packages", "@slkiser", "opencode-quota@latest");
    const manifest = join(cache, "node_modules", "@slkiser", "opencode-quota", "package.json");
    write(manifest, `{"name":"@slkiser/opencode-quota"}`);

    const plan = await planScopedUpdate({
      cwd: f.project,
      env: f.env,
      homeDir: join(f.root, "home"),
      platform: "linux",
    });

    expect(plan.configPaths).toEqual([]);
    expect(plan.authoritativeLatest).toBe(false);
    expect(plan.configSnapshots).toEqual([
      expect.objectContaining({
        path: sidecar,
        changed: true,
        roles: ["display-migration"],
      }),
    ]);
    expect(plan.configEdits).toEqual([
      expect.objectContaining({
        path: sidecar,
        replacements: 0,
        displayMigrations: 1,
      }),
    ]);

    const result = await applyScopedUpdatePlan(plan);
    expect(result.writtenPaths).toEqual([sidecar]);
    expect(result.removedCachePaths).toEqual([]);
    expect(readFileSync(manifest, "utf8")).toContain("@slkiser/opencode-quota");
    expect(readFileSync(sidecar, "utf8")).toContain('"accountingDetail": "detailed"');
  });

  it("keeps malformed migration-only files manual without blocking package work", async () => {
    const f = fixture();
    const config = join(f.project, "opencode.json");
    const malformed = join(f.project, "opencode-quota", "quota-toast.jsonc");
    write(config, `{"plugin":["@slkiser/opencode-quota@3.11.1"]}`);
    write(malformed, `{"opencodeZenDisplay":"parser-secret",`);

    const plan = await planScopedUpdate({
      cwd: f.project,
      env: f.env,
      homeDir: join(f.root, "home"),
      platform: "linux",
    });

    expect(plan.configEdits).toEqual([
      expect.objectContaining({ path: config, replacements: 1, displayMigrations: 0 }),
    ]);
    expect(plan.configSnapshots.map((snapshot) => snapshot.path)).toEqual([config]);
    expect(plan.manualFindings).toContainEqual({
      kind: "migration-file-uninspectable",
      path: malformed,
      reason: "invalid-json",
    });
    expect(JSON.stringify(plan.manualFindings)).not.toContain("parser-secret");
  });

  it("preserves package-first then explicit migration-only snapshot order", async () => {
    const f = fixture();
    const projectConfig = join(f.project, "opencode.json");
    const globalConfig = join(f.global, "tui.json");
    const globalSidecar = join(f.global, "opencode-quota", "quota-toast.json");
    const workspaceSidecar = join(f.project, "opencode-quota", "quota-toast.jsonc");
    write(projectConfig, `{"plugin":["@slkiser/opencode-quota@3.11.1"]}`);
    write(globalConfig, `{"plugin":["@slkiser/opencode-quota@latest"]}`);
    write(globalSidecar, `{"opencodeZenDisplay":"default"}`);
    write(workspaceSidecar, `{"opencodeZenDisplay":"detailed"}`);

    const plan = await planScopedUpdate({
      cwd: join(f.project, "nested", "deeper"),
      env: f.env,
      homeDir: join(f.root, "home"),
      platform: "linux",
    });

    expect(plan.configPaths).toEqual([projectConfig, globalConfig]);
    expect(plan.configSnapshots.map((snapshot) => snapshot.path)).toEqual([
      projectConfig,
      globalConfig,
      globalSidecar,
      workspaceSidecar,
    ]);
  });

  it("uses injected runtime roots and the enclosing Git worktree, not ambient env", async () => {
    const f = fixture();
    const injectedRoot = join(f.root, "injected-config");
    const ambientRoot = join(f.root, "ambient-config");
    const injectedConfig = join(injectedRoot, "opencode.json");
    const ambientConfig = join(ambientRoot, "opencode.json");
    const workspaceSidecar = join(f.project, "opencode-quota", "quota-toast.json");
    write(injectedConfig, `{"plugin":["@slkiser/opencode-quota@3.11.1"]}`);
    write(ambientConfig, `{"plugin":["@slkiser/opencode-quota@3.11.1"]}`);
    write(workspaceSidecar, `{"opencodeZenDisplay":"default"}`);
    vi.stubEnv("OPENCODE_CONFIG_DIR", ambientRoot);

    const plan = await planScopedUpdate({
      cwd: join(f.project, "nested", "deeper"),
      env: { ...f.env, OPENCODE_CONFIG_DIR: injectedRoot },
      homeDir: join(f.root, "home"),
      platform: "linux",
    });

    expect(plan.configPaths).toEqual([injectedConfig]);
    expect(plan.configSnapshots.map((snapshot) => snapshot.path)).toEqual([
      injectedConfig,
      workspaceSidecar,
    ]);
    expect(plan.configSnapshots.some((snapshot) => snapshot.path === ambientConfig)).toBe(false);
  });

  it("inspects shadowed host siblings while retaining package JSONC authority", async () => {
    const f = fixture();
    const selected = join(f.project, "opencode.jsonc");
    const shadowed = join(f.project, "opencode.json");
    write(selected, `{"plugin":["@slkiser/opencode-quota@latest"]}`);
    write(shadowed, `{"experimental":{"quotaToast":{"opencodeZenDisplay":"default"}}}`);

    const plan = await planScopedUpdate({
      cwd: f.project,
      env: f.env,
      homeDir: join(f.root, "home"),
      platform: "linux",
    });

    expect(plan.configPaths).toEqual([selected]);
    expect(plan.configSnapshots.map((snapshot) => snapshot.path)).toEqual([selected, shadowed]);
    expect(plan.configSnapshots[0]?.roles).toEqual(["package-authority", "display-migration"]);
    expect(plan.configSnapshots[1]?.roles).toEqual(["display-migration"]);
    expect(plan.configEdits).toEqual([
      expect.objectContaining({ path: shadowed, replacements: 0, displayMigrations: 1 }),
    ]);
  });

  it("keeps package specs and cache derivation package-authority-only", async () => {
    const f = fixture();
    const selected = join(f.project, "opencode.jsonc");
    const migrationOnly = join(f.project, "opencode.json");
    const shadowedSpec = "@slkiser/opencode-quota@3.11.1";
    write(selected, `{"plugin":["other-plugin"]}`);
    write(
      migrationOnly,
      `{"plugin":["${shadowedSpec}"],"experimental":{"quotaToast":{"opencodeZenDisplay":"default"}}}`,
    );

    const plan = await planScopedUpdate({
      cwd: f.project,
      env: f.env,
      homeDir: join(f.root, "home"),
      platform: "linux",
    });

    expect(plan.configPaths).toEqual([selected]);
    expect(plan.foundSpecs).toEqual([]);
    expect(plan.authoritativeLatest).toBe(false);
    expect(plan.cacheCandidates.some((path) => path.endsWith("opencode-quota@3.11.1"))).toBe(false);
    expect(plan.configEdits).toEqual([
      expect.objectContaining({ path: migrationOnly, replacements: 0, displayMigrations: 1 }),
    ]);
  });

  it("composes a package-selected alias with a separately discovered real document once", async () => {
    const f = fixture();
    const packageAlias = join(f.project, "opencode.json");
    const realConfig = join(f.global, "opencode.json");
    write(
      realConfig,
      `{"plugin":["@slkiser/opencode-quota@3.11.1"],"experimental":{"quotaToast":{"opencodeZenDisplay":"default"}}}`,
    );
    mkdirSync(dirname(packageAlias), { recursive: true });
    symlinkSync(realConfig, packageAlias);

    const plan = await planScopedUpdate({
      cwd: f.project,
      env: f.env,
      homeDir: join(f.root, "home"),
      platform: "linux",
    });

    expect(plan.configPaths).toEqual([packageAlias]);
    expect(plan.configSnapshots).toEqual([
      expect.objectContaining({
        path: packageAlias,
        changed: true,
        roles: ["package-authority", "package-edit", "display-migration"],
      }),
    ]);
    expect(plan.configEdits).toEqual([
      expect.objectContaining({
        path: packageAlias,
        replacements: 1,
        displayMigrations: 1,
      }),
    ]);
    expect(plan.configEdits[0]?.updated).toContain(QUOTA_LATEST_SPEC);
    expect(plan.configEdits[0]?.updated).toContain('"accountingDetail": "summary"');
    expect(plan.manualFindings).not.toContainEqual(
      expect.objectContaining({ kind: "migration-file-uninspectable" }),
    );
  });

  it("reports a distinct migration symlink alias after package realpath dedupe", async () => {
    const f = fixture();
    const projectConfig = join(f.project, "opencode.json");
    const globalAlias = join(f.global, "opencode.json");
    write(projectConfig, `{"plugin":["@slkiser/opencode-quota@latest"]}`);
    mkdirSync(dirname(globalAlias), { recursive: true });
    symlinkSync(projectConfig, globalAlias);

    const plan = await planScopedUpdate({
      cwd: f.project,
      env: f.env,
      homeDir: join(f.root, "home"),
      platform: "linux",
    });

    expect(plan.configPaths).toEqual([projectConfig]);
    expect(plan.configSnapshots).toHaveLength(1);
    expect(plan.manualFindings).toContainEqual({
      kind: "migration-file-uninspectable",
      path: globalAlias,
      reason: "symlink",
    });
  });

  it("attaches presence-only credential findings without secret values", async () => {
    const f = fixture();
    const obsoleteFile = join(f.global, "opencode-quota", "opencode-go.json");
    write(obsoleteFile, `{"authCookie":"file-secret-canary"}`);

    const plan = await planScopedUpdate({
      cwd: f.project,
      env: {
        ...f.env,
        OPENCODE_GO_AUTH_COOKIE: "go-secret-canary",
        OPENCODE_WORKSPACE_ID: "zen-secret-canary",
      },
      homeDir: join(f.root, "home"),
      platform: "linux",
    });

    expect(plan.manualFindings).toEqual(
      expect.arrayContaining([
        { kind: "obsolete-go-env", name: "OPENCODE_GO_AUTH_COOKIE" },
        { kind: "obsolete-go-file", path: obsoleteFile },
        expect.objectContaining({
          kind: "ambiguous-zen-env",
          names: ["OPENCODE_WORKSPACE_ID"],
        }),
      ]),
    );
    expect(JSON.stringify(plan.manualFindings)).not.toContain("secret-canary");
  });

  it("redacts every credential and parser canary from public planner and CLI surfaces", async () => {
    const f = fixture();
    const config = join(f.project, "opencode.json");
    const malformedSidecar = join(f.project, "opencode-quota", "quota-toast.jsonc");
    const obsoleteGoFile = join(f.global, "opencode-quota", "opencode-go.json");
    const supportedZenFile = join(f.global, "opencode-quota", "opencode.json");
    const authFile = join(f.global, "auth.json");
    const canaries = [
      "go-workspace-value-canary",
      "go-cookie-value-canary",
      "zen-workspace-value-canary",
      "zen-cookie-value-canary",
      "legacy-go-file-content-canary",
      "supported-zen-file-content-canary",
      "provider-api-key-canary",
      "auth-json-key-canary",
      "invalid-display-value-canary",
      "migration-parser-content-canary",
    ];
    write(
      config,
      `{"plugin":["@slkiser/opencode-quota@3.11.1"],"provider":{"opencode-go":{"options":{"apiKey":"provider-api-key-canary"}}},"experimental":{"quotaToast":{"opencodeZenDisplay":"invalid-display-value-canary"}}}`,
    );
    write(malformedSidecar, `{"opencodeZenDisplay":"migration-parser-content-canary",`);
    write(obsoleteGoFile, `{"authCookie":"legacy-go-file-content-canary"}`);
    write(
      supportedZenFile,
      `{"workspaceId":"supported-zen-file-content-canary","authCookie":"supported-zen-file-content-canary"}`,
    );
    write(authFile, `{"opencode-go":{"type":"api","key":"auth-json-key-canary"}}`);
    const env = {
      ...f.env,
      OPENCODE_GO_WORKSPACE_ID: "go-workspace-value-canary",
      OPENCODE_GO_AUTH_COOKIE: "go-cookie-value-canary",
      OPENCODE_WORKSPACE_ID: "zen-workspace-value-canary",
      OPENCODE_AUTH_COOKIE: "zen-cookie-value-canary",
    };
    const params = {
      cwd: f.project,
      env,
      homeDir: join(f.root, "home"),
      platform: "linux" as const,
    };

    const plan = await planScopedUpdate(params);
    const preview = formatScopedUpdatePreview(plan);
    const log = vi.fn();
    expect(await runScopedUpdateCommand({ ...params, argv: ["--dry-run"], log })).toBe(0);
    const publicSuccess = JSON.stringify({
      safeActions: plan.safeActions,
      manualFindings: plan.manualFindings,
      preview,
      logs: log.mock.calls,
    });
    for (const canary of canaries) expect(publicSuccess).not.toContain(canary);

    const failed = fixture();
    write(
      join(failed.project, "opencode.jsonc"),
      `{"provider":{"x":{"apiKey":"raw-parser-error-canary"}}, invalid`,
    );
    const failedParams = {
      cwd: failed.project,
      env: failed.env,
      homeDir: join(failed.root, "home"),
      platform: "linux" as const,
    };
    const planningError = await planScopedUpdate(failedParams).catch((error: unknown) => error);
    expect(String(planningError)).not.toContain("raw-parser-error-canary");
    const errorLog = vi.fn();
    expect(await runScopedUpdateCommand({ ...failedParams, log: errorLog })).toBe(1);
    expect(errorLog.mock.calls.flat().join("\n")).not.toContain("raw-parser-error-canary");
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

  it("blocks cache deletion when a migrated sidecar changes after writes", async () => {
    const f = fixture();
    const config = join(f.project, "opencode.json");
    const sidecar = join(f.project, "opencode-quota", "quota-toast.jsonc");
    write(config, `{"plugin":["@slkiser/opencode-quota@3.11.1"]}`);
    write(sidecar, `{"opencodeZenDisplay":"default"}`);
    const cache = join(f.cache, "packages", "@slkiser", "opencode-quota@latest");
    const manifest = join(cache, "node_modules", "@slkiser", "opencode-quota", "package.json");
    write(manifest, `{"name":"@slkiser/opencode-quota"}`);
    const plan = await planScopedUpdate({
      cwd: f.project,
      env: f.env,
      homeDir: join(f.root, "home"),
      platform: "linux",
    });

    await expect(
      applyScopedUpdatePlan(plan, {
        beforeCacheDeletion: async () => {
          write(sidecar, `{"accountingDetail":"detailed","raced":true}`);
        },
      }),
    ).rejects.toThrow("changed before cache deletion");

    expect(readFileSync(config, "utf8")).toContain("@latest");
    expect(readFileSync(sidecar, "utf8")).toContain('"raced":true');
    expect(readFileSync(manifest, "utf8")).toContain("@slkiser/opencode-quota");
  });

  it("reports completed writes when pre-cache work fails", async () => {
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
      platform: "linux",
    });

    const error = await applyScopedUpdatePlan(plan, {
      beforeCacheDeletion: async () => {
        throw new Error("hook failed");
      },
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ details: { writtenPaths: [config] } });
    expect(String(error)).toContain("Changed before failure");
    expect(readFileSync(config, "utf8")).toContain("@latest");
    expect(readFileSync(manifest, "utf8")).toContain("@slkiser/opencode-quota");
  });

  it("preflights every snapshot before the first write", async () => {
    const f = fixture();
    const first = join(f.project, "opencode.json");
    const second = join(f.global, "tui.json");
    const original = `{"plugin":["@slkiser/opencode-quota@3.11.1"]}`;
    write(first, original);
    write(second, original);
    const plan = await planScopedUpdate({
      cwd: f.project,
      env: f.env,
      homeDir: join(f.root, "home"),
      platform: "linux",
    });
    const writeText = vi.fn();
    let reads = 0;

    await expect(
      applyScopedUpdatePlan(plan, {
        readBytes: async (path) => {
          reads++;
          if (reads === 2) return Buffer.from(`${readFileSync(path, "utf8")} `);
          return readFileSync(path);
        },
        writeText,
      }),
    ).rejects.toThrow("changed since preview");

    expect(writeText).not.toHaveBeenCalled();
    expect(readFileSync(first, "utf8")).toBe(original);
    expect(readFileSync(second, "utf8")).toBe(original);
  });

  it("rejects a migration parent replaced between planning and apply", async () => {
    const f = fixture();
    const sidecar = join(f.project, "opencode-quota", "quota-toast.jsonc");
    const original = `{"opencodeZenDisplay":"default"}`;
    const redirectedParent = join(f.root, "redirected-opencode-quota");
    const redirectedSidecar = join(redirectedParent, "quota-toast.jsonc");
    write(sidecar, original);
    write(redirectedSidecar, original);
    const plan = await planScopedUpdate({
      cwd: f.project,
      env: f.env,
      homeDir: join(f.root, "home"),
      platform: "linux",
    });

    rmSync(dirname(sidecar), { recursive: true });
    symlinkSync(redirectedParent, dirname(sidecar));

    await expect(applyScopedUpdatePlan(plan)).rejects.toThrow(
      "Migration boundary changed before writing",
    );
    expect(readFileSync(redirectedSidecar, "utf8")).toBe(original);
  });

  it.each([
    "read",
    "write",
  ] as const)("reports earlier writes when a later config %s fails", async (failureKind) => {
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
        if (failureKind === "read" && reads === 4) throw new Error("read failed");
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
  });

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

  it("prints the complete preview before dry-run completion or confirmation", async () => {
    const f = fixture();
    const config = join(f.project, "opencode.json");
    const original = `{"plugin":["@slkiser/opencode-quota@3.11.1"]}`;
    write(config, original);
    const cache = join(f.cache, "packages", "@slkiser", "opencode-quota@latest");
    const manifest = join(cache, "node_modules", "@slkiser", "opencode-quota", "package.json");
    write(manifest, `{"name":"@slkiser/opencode-quota"}`);
    const base = {
      cwd: f.project,
      env: f.env,
      homeDir: join(f.root, "home"),
      platform: "linux" as const,
    };
    const preview = formatScopedUpdatePreview(await planScopedUpdate(base));
    const log = vi.fn();

    expect(await runScopedUpdateCommand({ ...base, argv: ["--dry-run"], log })).toBe(0);
    expect(log.mock.calls.map(([message]) => message).slice(0, preview.length)).toEqual(preview);
    expect(log).toHaveBeenCalledWith(
      "Responsible update preview complete — no configuration or package-cache changes were made.",
    );
    expect(readFileSync(config, "utf8")).toBe(original);
    expect(readFileSync(manifest, "utf8")).toContain("@slkiser/opencode-quota");

    log.mockClear();
    const confirm = vi.fn(async (message: string) => {
      expect(message).toBe(
        "Apply the safe config changes above and remove only manifest-verified package-cache directories?",
      );
      expect(log.mock.calls.map(([logged]) => logged)).toEqual(preview);
      expect(readFileSync(config, "utf8")).toBe(original);
      expect(readFileSync(manifest, "utf8")).toContain("@slkiser/opencode-quota");
      return false;
    });
    expect(await runScopedUpdateCommand({ ...base, confirm, log })).toBe(0);
    expect(confirm).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith("OpenCode Quota update cancelled — no files changed.");
    expect(readFileSync(config, "utf8")).toBe(original);
  });

  it("keeps responsible preview sections ordered and identical for dry-run and --yes", async () => {
    const f = fixture();
    const config = join(f.project, "opencode.json");
    const original = `{"plugin":["@slkiser/opencode-quota@3.11.1"],"experimental":{"quotaToast":{"opencodeZenDisplay":"default"}}}`;
    write(config, original);
    const env = { ...f.env, OPENCODE_GO_AUTH_COOKIE: "preview-secret-canary" };
    const base = {
      cwd: f.project,
      env,
      homeDir: join(f.root, "home"),
      platform: "linux" as const,
    };
    const preview = formatScopedUpdatePreview(await planScopedUpdate(base));
    const safeIndex = preview.indexOf("Safe changes this command can make:");
    const manualIndex = preview.indexOf(
      "Manual actions — this command will not change these sources:",
    );
    const cacheIndex = preview.indexOf(
      "Package-cache candidates (removed only after verification):",
    );
    expect(safeIndex).toBeGreaterThan(0);
    expect(manualIndex).toBeGreaterThan(safeIndex);
    expect(cacheIndex).toBeGreaterThan(manualIndex);
    expect(preview.join("\n")).not.toContain("preview-secret-canary");

    const dryLog = vi.fn();
    expect(await runScopedUpdateCommand({ ...base, argv: ["--dry-run"], log: dryLog })).toBe(0);
    expect(dryLog.mock.calls.map(([message]) => message).slice(0, preview.length)).toEqual(preview);

    let previewLines = 0;
    const yesLog = vi.fn((message: string) => {
      if (previewLines >= preview.length) return;
      expect(message).toBe(preview[previewLines]);
      expect(readFileSync(config, "utf8")).toBe(original);
      previewLines++;
    });
    expect(await runScopedUpdateCommand({ ...base, argv: ["--yes"], log: yesLog })).toBe(0);
    expect(previewLines).toBe(preview.length);
    expect(yesLog.mock.calls.map(([message]) => message).slice(0, preview.length)).toEqual(preview);
    expect(readFileSync(config, "utf8")).toContain(QUOTA_LATEST_SPEC);
    expect(readFileSync(config, "utf8")).toContain('"accountingDetail": "summary"');
  });

  it("does not prompt when only manual findings exist", async () => {
    const f = fixture();
    const log = vi.fn();
    const confirm = vi.fn();

    expect(
      await runScopedUpdateCommand({
        cwd: f.project,
        env: { ...f.env, OPENCODE_GO_AUTH_COOKIE: "manual-secret-canary" },
        homeDir: join(f.root, "home"),
        platform: "linux",
        confirm,
        log,
      }),
    ).toBe(0);

    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain("Manual actions — this command will not change these sources:");
    expect(output).not.toContain("Safe changes this command can make:");
    expect(output).not.toContain("Package-cache candidates");
    expect(output).not.toContain("manual-secret-canary");
    expect(output).toContain(
      "No automatic changes are available. Complete the manual actions above, then rerun update.",
    );
    expect(confirm).not.toHaveBeenCalled();
  });

  it("retains the already-current no-op result when the preview has no work or findings", async () => {
    const f = fixture();
    const log = vi.fn();
    const confirm = vi.fn();

    expect(
      await runScopedUpdateCommand({
        cwd: f.project,
        env: f.env,
        homeDir: join(f.root, "home"),
        platform: "linux",
        confirm,
        log,
      }),
    ).toBe(0);

    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain("Responsible OpenCode Quota update preview");
    expect(output).not.toContain("Safe changes this command can make:");
    expect(output).not.toContain("Manual actions");
    expect(output).not.toContain("Package-cache candidates");
    expect(output).toContain("OpenCode Quota update is already current. No files changed.");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("keeps --yes credential-blind and leaves secret-bearing sources untouched", async () => {
    const f = fixture();
    const config = join(f.project, "opencode.json");
    const goFile = join(f.global, "opencode-quota", "opencode-go.json");
    const zenFile = join(f.global, "opencode-quota", "opencode.json");
    const authFile = join(f.global, "auth.json");
    const shellFile = join(f.root, ".zshrc");
    const goFileContent = `{"authCookie":"go-file-secret-canary"}`;
    const zenFileContent = `{"workspaceId":"zen-file-secret-canary"}`;
    const authFileContent = `{"opencode-go":{"key":"auth-file-secret-canary"}}`;
    const shellFileContent = `export OPENCODE_API_KEY="shell-secret-canary"\n`;
    write(
      config,
      `{"plugin":["@slkiser/opencode-quota@3.11.1"],"provider":{"opencode-go":{"options":{"apiKey":"provider-secret-canary"}}},"experimental":{"quotaToast":{"opencodeZenDisplay":"default"}}}`,
    );
    write(goFile, goFileContent);
    write(zenFile, zenFileContent);
    write(authFile, authFileContent);
    write(shellFile, shellFileContent);
    const env = {
      ...f.env,
      OPENCODE_GO_AUTH_COOKIE: "go-env-secret-canary",
      OPENCODE_WORKSPACE_ID: "zen-env-secret-canary",
    };
    const log = vi.fn();

    expect(
      await runScopedUpdateCommand({
        cwd: f.project,
        env,
        homeDir: join(f.root, "home"),
        platform: "linux",
        argv: ["--yes"],
        log,
      }),
    ).toBe(0);

    const output = log.mock.calls.flat().join("\n");
    for (const canary of [
      "go-file-secret-canary",
      "zen-file-secret-canary",
      "auth-file-secret-canary",
      "shell-secret-canary",
      "provider-secret-canary",
      "go-env-secret-canary",
      "zen-env-secret-canary",
    ]) {
      expect(output).not.toContain(canary);
    }
    expect(env.OPENCODE_GO_AUTH_COOKIE).toBe("go-env-secret-canary");
    expect(env.OPENCODE_WORKSPACE_ID).toBe("zen-env-secret-canary");
    expect(readFileSync(goFile, "utf8")).toBe(goFileContent);
    expect(readFileSync(zenFile, "utf8")).toBe(zenFileContent);
    expect(readFileSync(authFile, "utf8")).toBe(authFileContent);
    expect(readFileSync(shellFile, "utf8")).toBe(shellFileContent);
    expect(readFileSync(config, "utf8")).toContain("provider-secret-canary");
  });

  it("sanitizes preview, failure, and final-result paths to one line", async () => {
    const root = tempDir();
    const project = join(root, "project\n\u001b[31munsafe");
    mkdirSync(join(project, ".git"), { recursive: true });
    const config = join(project, "opencode.json");
    write(config, `{"plugin":["@slkiser/opencode-quota@3.11.1"]}`);
    const env = {
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_STATE_HOME: join(root, "state"),
    } satisfies NodeJS.ProcessEnv;
    const params = {
      cwd: project,
      env,
      homeDir: join(root, "home"),
      platform: "linux" as const,
    };
    const log = vi.fn();

    expect(await runScopedUpdateCommand({ ...params, argv: ["--yes"], log })).toBe(0);
    for (const message of log.mock.calls.flat()) {
      expect(hasControlCharacter(message)).toBe(false);
    }
    expect(log.mock.calls.flat().join("\n")).toContain("project unsafe");

    write(config, `{"plugin":["@slkiser/opencode-quota@3.11.1"]}`);
    const plan = await planScopedUpdate(params);
    write(config, `{"plugin":["other-plugin"]}`);
    const error = await applyScopedUpdatePlan(plan).catch((caught: unknown) => caught);
    expect(hasControlCharacter(String(error))).toBe(false);
    expect(String(error)).toContain("project unsafe");
  });

  it("keeps accepted update flags and two-code exits unchanged", async () => {
    const f = fixture();
    expect(
      await runScopedUpdateCommand({
        argv: ["--migrate"],
        cwd: f.project,
        env: f.env,
        homeDir: join(f.root, "home"),
      }),
    ).toBe(1);
    expect(
      await runScopedUpdateCommand({
        argv: ["--dry-run", "--yes"],
        cwd: f.project,
        env: f.env,
        homeDir: join(f.root, "home"),
        platform: "linux",
        log: vi.fn(),
      }),
    ).toBe(0);
  });

  it("reports successful update paths, restart guidance, and the secondary star request", async () => {
    const f = fixture();
    const config = join(f.project, "opencode.json");
    write(config, `{"plugin":["@slkiser/opencode-quota@3.11.1"]}`);
    const log = vi.fn();

    expect(
      await runScopedUpdateCommand({
        cwd: f.project,
        env: f.env,
        homeDir: join(f.root, "home"),
        argv: ["--yes"],
        log,
      }),
    ).toBe(0);

    expect(log).toHaveBeenCalledWith("OpenCode Quota update complete.");
    expect(log).toHaveBeenCalledWith(`Configured paths: ${config}`);
    expect(log).toHaveBeenCalledWith("Restart OpenCode and run /quota.");
    expect(log).toHaveBeenCalledWith(
      "If OpenCode Quota helps, please consider a star: https://github.com/slkiser/opencode-quota",
    );
  });

  it("reports update planning failures as no-write outcomes without asking for a star", async () => {
    const f = fixture();
    write(
      join(f.project, "opencode.jsonc"),
      `{"provider":{"x":{"apiKey":"failure-secret-canary"}}, nope`,
    );
    const log = vi.fn();

    expect(
      await runScopedUpdateCommand({
        cwd: f.project,
        env: f.env,
        homeDir: join(f.root, "home"),
        log,
      }),
    ).toBe(1);

    expect(log).toHaveBeenCalledWith(expect.stringContaining("OpenCode Quota update failed:"));
    expect(log).toHaveBeenCalledWith("No files changed. Fix the reason above, then rerun update.");
    expect(log.mock.calls.flat().join("\n")).not.toContain("failure-secret-canary");
    expect(log.mock.calls.flat().join("\n")).not.toContain("star");
  });
});
