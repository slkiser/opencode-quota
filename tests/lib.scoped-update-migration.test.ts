import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AMBIGUOUS_ZEN_ENV_NAMES,
  auditObsoleteUpdateSources,
  buildScopedUpdateMigrationCandidates,
  discoverExistingScopedUpdateMigrationCandidates,
  inspectLegacyDisplayDocument,
  LEGACY_DISPLAY_MAPPINGS,
  OBSOLETE_GO_ENV_NAMES,
  OBSOLETE_GO_FILE,
  type ScopedUpdateManualFinding,
  type ScopedUpdateSafeAction,
  SUPPORTED_ZEN_FILE,
  sortScopedUpdateManualFindings,
  sortScopedUpdateSafeActions,
} from "../src/lib/scoped-update-migration.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "opencode-quota-migration-"));
  tempDirs.push(path);
  return path;
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function inspect(params: {
  raw: string;
  container?: "quota-root" | "experimental.quotaToast";
  format?: "json" | "jsonc";
  path?: string;
}) {
  return inspectLegacyDisplayDocument({
    path: params.path ?? "/config/quota.jsonc",
    format: params.format ?? "jsonc",
    raw: params.raw,
    container: params.container ?? "quota-root",
  });
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("legacy display inspection", () => {
  it("locks the historical display mapping", () => {
    expect(LEGACY_DISPLAY_MAPPINGS).toEqual({
      default: "summary",
      detailed: "detailed",
    });
  });

  it.each([
    ["quota-root", "default", "summary"],
    ["quota-root", "detailed", "detailed"],
    ["experimental.quotaToast", "default", "summary"],
    ["experimental.quotaToast", "detailed", "detailed"],
  ] as const)("maps %s %s to %s", (container, from, to) => {
    const raw =
      container === "quota-root"
        ? `{"opencodeZenDisplay":"${from}","unrelated":true}`
        : `{"experimental":{"quotaToast":{"opencodeZenDisplay":"${from}","unrelated":true}}}`;
    const result = inspect({ raw, container, format: "json" });

    expect(result.changed).toBe(true);
    expect(result.updated).not.toContain("opencodeZenDisplay");
    expect(result.updated).toMatch(new RegExp(`"accountingDetail"\\s*:\\s*"${to}"`));
    expect(result.updated).toContain('"unrelated":true');
    expect(result.safeActions).toEqual([
      {
        kind: "accounting-detail-migration",
        path: "/config/quota.jsonc",
        container,
        from,
        to,
        outcome: "set-and-remove-old",
      },
    ]);
    expect(result.manualFindings).toEqual([]);
  });

  it.each([
    ["default", "summary", "remove-redundant-old"],
    ["detailed", "summary", "keep-current-and-remove-old"],
  ] as const)("keeps valid accountingDetail %s/%s", (from, current, outcome) => {
    const result = inspect({
      raw: `{"opencodeZenDisplay":"${from}","accountingDetail":"${current}"}`,
      format: "json",
    });

    expect(result.changed).toBe(true);
    expect(result.updated).not.toContain("opencodeZenDisplay");
    expect(result.updated).toContain(`"accountingDetail":"${current}"`);
    expect(result.safeActions[0]).toMatchObject({
      outcome,
      from,
      to: LEGACY_DISPLAY_MAPPINGS[from],
    });
  });

  it("is byte-idempotent on a second pass", () => {
    const first = inspect({
      raw: `{
  "opencodeZenDisplay": "default",
  "unrelated": true, // preserve this unrelated comment
}
`,
    });
    const second = inspect({ raw: first.updated });

    expect(first.changed).toBe(true);
    expect(first.updated).toContain("// preserve this unrelated comment");
    expect(first.updated).toContain('"unrelated": true');
    expect(second).toEqual({
      updated: first.updated,
      changed: false,
      safeActions: [],
      manualFindings: [],
    });
  });

  it.each([
    ["unsupported-legacy-value", `{"opencodeZenDisplay":"expanded"}`],
    ["unsupported-legacy-value", `{"opencodeZenDisplay":"secret-unknown-value"}`],
    ["unsupported-legacy-value", `{"opencodeZenDisplay":42}`],
    [
      "invalid-accounting-detail",
      `{"opencodeZenDisplay":"default","accountingDetail":"secret-invalid-value"}`,
    ],
    ["duplicate-key", `{"opencodeZenDisplay":"default","opencodeZenDisplay":"detailed"}`],
    [
      "duplicate-key",
      `{"opencodeZenDisplay":"default","accountingDetail":"summary","accountingDetail":"detailed"}`,
    ],
  ] as const)("leaves unsafe leaf case unchanged: %s", (reason, raw) => {
    const result = inspect({ raw, format: "json" });

    expect(result.updated).toBe(raw);
    expect(result.changed).toBe(false);
    expect(result.safeActions).toEqual([]);
    expect(result.manualFindings).toEqual([
      {
        kind: "display-migration-manual",
        path: "/config/quota.jsonc",
        container: "quota-root",
        reason,
      },
    ]);
    expect(JSON.stringify(result.manualFindings)).not.toContain("secret-");
  });

  it.each([
    `{"experimental":{},"experimental":{"quotaToast":{"opencodeZenDisplay":"default"}}}`,
    `{"experimental":42}`,
    `{"experimental":{"quotaToast":{},"quotaToast":{"opencodeZenDisplay":"default"}}}`,
    `{"experimental":{"quotaToast":42}}`,
  ])("leaves ambiguous host structure unchanged", (raw) => {
    const result = inspect({
      raw,
      format: "json",
      container: "experimental.quotaToast",
    });

    expect(result.updated).toBe(raw);
    expect(result.manualFindings).toEqual([
      {
        kind: "display-migration-manual",
        path: "/config/quota.jsonc",
        container: "experimental.quotaToast",
        reason: "unsupported-structure",
      },
    ]);
  });

  it.each([
    "[]",
    "null",
    "true",
    '"text"',
    "42",
  ])("distinguishes unsupported root %s from malformed syntax", (raw) => {
    expect(inspect({ raw, format: "json" }).manualFindings).toEqual([
      {
        kind: "migration-file-uninspectable",
        path: "/config/quota.jsonc",
        reason: "unsupported-root",
      },
    ]);
  });

  it("uses a fixed malformed-document finding without parser text", () => {
    const raw = `{"opencodeZenDisplay":"parser-secret",`;
    const result = inspect({ raw, format: "json" });

    expect(result.updated).toBe(raw);
    expect(result.manualFindings).toEqual([
      {
        kind: "migration-file-uninspectable",
        path: "/config/quota.jsonc",
        reason: "invalid-json",
      },
    ]);
    expect(JSON.stringify(result.manualFindings)).not.toContain("parser-secret");
  });

  it("enforces strict JSON but preserves JSONC comments and trailing commas", () => {
    const raw = `{
  "opencodeZenDisplay": "default",
  "nested": { "keep": true }, // unrelated comment with "quotes"
}
`;
    const jsonResult = inspect({ raw, format: "json" });
    const jsoncResult = inspect({ raw, format: "jsonc" });

    expect(jsonResult.manualFindings).toMatchObject([
      { kind: "migration-file-uninspectable", reason: "invalid-json" },
    ]);
    expect(jsoncResult.changed).toBe(true);
    expect(jsoncResult.updated).toContain('// unrelated comment with "quotes"');
    expect(jsoncResult.updated).toContain('"nested": { "keep": true }');
    expect(jsoncResult.updated).not.toContain("opencodeZenDisplay");
  });

  it("does nothing when the target object or old key is absent", () => {
    expect(inspect({ raw: `{"accountingDetail":"summary"}`, format: "json" }).changed).toBe(false);
    expect(
      inspect({
        raw: `{"experimental":{"other":true}}`,
        format: "json",
        container: "experimental.quotaToast",
      }).changed,
    ).toBe(false);
  });
});

describe("migration candidate discovery", () => {
  it("reuses global-then-workspace candidate order and runtime relative paths", () => {
    const candidates = buildScopedUpdateMigrationCandidates({
      globalRoots: ["/global-a", "/global-b"],
      workspaceRoot: "/workspace",
    });

    expect(
      candidates.map(({ path, container, scope, format }) => ({
        path,
        container,
        scope,
        format,
      })),
    ).toEqual([
      {
        path: join("/global-a", "opencode-quota/quota-toast.jsonc"),
        container: "quota-root",
        scope: "global",
        format: "jsonc",
      },
      {
        path: join("/global-a", "opencode-quota/quota-toast.json"),
        container: "quota-root",
        scope: "global",
        format: "json",
      },
      {
        path: join("/global-a", "opencode.json"),
        container: "experimental.quotaToast",
        scope: "global",
        format: "json",
      },
      {
        path: join("/global-a", "opencode.jsonc"),
        container: "experimental.quotaToast",
        scope: "global",
        format: "jsonc",
      },
      {
        path: join("/global-b", "opencode-quota/quota-toast.jsonc"),
        container: "quota-root",
        scope: "global",
        format: "jsonc",
      },
      {
        path: join("/global-b", "opencode-quota/quota-toast.json"),
        container: "quota-root",
        scope: "global",
        format: "json",
      },
      {
        path: join("/global-b", "opencode.json"),
        container: "experimental.quotaToast",
        scope: "global",
        format: "json",
      },
      {
        path: join("/global-b", "opencode.jsonc"),
        container: "experimental.quotaToast",
        scope: "global",
        format: "jsonc",
      },
      {
        path: join("/workspace", "opencode-quota/quota-toast.jsonc"),
        container: "quota-root",
        scope: "workspace",
        format: "jsonc",
      },
      {
        path: join("/workspace", "opencode-quota/quota-toast.json"),
        container: "quota-root",
        scope: "workspace",
        format: "json",
      },
      {
        path: join("/workspace", "opencode.json"),
        container: "experimental.quotaToast",
        scope: "workspace",
        format: "json",
      },
      {
        path: join("/workspace", "opencode.jsonc"),
        container: "experimental.quotaToast",
        scope: "workspace",
        format: "jsonc",
      },
    ]);
  });

  it("does not duplicate a workspace root already present globally", () => {
    const root = tempDir();
    const candidates = buildScopedUpdateMigrationCandidates({
      globalRoots: [root],
      workspaceRoot: root,
    });

    expect(candidates).toHaveLength(4);
    expect(candidates.every((candidate) => candidate.scope === "global")).toBe(true);
  });

  it("returns only existing regular files and deduplicates real paths", async () => {
    const root = tempDir();
    const globalRoot = join(root, "global");
    const workspaceRoot = join(root, "workspace");
    const globalFile = join(globalRoot, "opencode.json");
    const workspaceFile = join(workspaceRoot, "opencode.json");
    write(globalFile, "{}");
    write(workspaceFile, "{}");

    const result = await discoverExistingScopedUpdateMigrationCandidates({
      globalRoots: [globalRoot],
      workspaceRoot,
    });

    expect(result.candidates.map((candidate) => candidate.path)).toEqual([
      globalFile,
      workspaceFile,
    ]);
    expect(result.manualFindings).toEqual([]);
  });

  it("rejects a symlinked opencode-quota candidate parent", async () => {
    const root = tempDir();
    const globalRoot = join(root, "global");
    const outsideParent = join(root, "outside-opencode-quota");
    const candidatePath = join(globalRoot, "opencode-quota", "quota-toast.jsonc");
    write(join(outsideParent, "quota-toast.jsonc"), `{"opencodeZenDisplay":"default"}`);
    mkdirSync(globalRoot, { recursive: true });
    symlinkSync(outsideParent, join(globalRoot, "opencode-quota"));

    const result = await discoverExistingScopedUpdateMigrationCandidates({
      globalRoots: [globalRoot],
      workspaceRoot: join(root, "workspace"),
    });

    expect(result.candidates).toEqual([]);
    expect(result.manualFindings).toEqual([
      {
        kind: "migration-file-uninspectable",
        path: candidatePath,
        reason: "symlink",
      },
    ]);
  });

  it("keeps a package-selected cross-root symlink out of migration discovery", async () => {
    const root = tempDir();
    const globalRoot = join(root, "global");
    const workspaceRoot = join(root, "workspace");
    const workspaceFile = join(workspaceRoot, "opencode.json");
    const symlinkPath = join(globalRoot, "opencode.json");
    write(workspaceFile, `{"experimental":{"quotaToast":{"opencodeZenDisplay":"default"}}}`);
    mkdirSync(dirname(symlinkPath), { recursive: true });
    symlinkSync(workspaceFile, symlinkPath);

    const result = await discoverExistingScopedUpdateMigrationCandidates({
      globalRoots: [globalRoot],
      workspaceRoot,
      selectedPackagePaths: [symlinkPath],
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      path: workspaceFile,
      realPath: realpathSync(workspaceFile),
      realRoot: realpathSync(workspaceRoot),
    });
    expect(result.manualFindings).toEqual([
      {
        kind: "migration-file-uninspectable",
        path: symlinkPath,
        reason: "symlink",
      },
    ]);
  });

  it("reports a distinct symlink before realpath dedupe, even when it targets a selected file", async () => {
    const root = tempDir();
    const globalRoot = join(root, "global");
    const workspaceRoot = join(root, "workspace");
    const workspaceFile = join(workspaceRoot, "opencode-quota", "quota-toast.jsonc");
    const symlinkPath = join(globalRoot, "opencode-quota", "quota-toast.jsonc");
    write(workspaceFile, `{"opencodeZenDisplay":"default"}`);
    mkdirSync(dirname(symlinkPath), { recursive: true });
    symlinkSync(workspaceFile, symlinkPath);

    const result = await discoverExistingScopedUpdateMigrationCandidates({
      globalRoots: [globalRoot],
      workspaceRoot,
      selectedPackagePaths: [workspaceFile],
    });

    expect(result.candidates.map((candidate) => candidate.path)).toEqual([workspaceFile]);
    expect(result.manualFindings).toEqual([
      {
        kind: "migration-file-uninspectable",
        path: symlinkPath,
        reason: "symlink",
      },
    ]);
  });
});

describe("obsolete source audit", () => {
  it("locks exact historical source registries", () => {
    expect(OBSOLETE_GO_ENV_NAMES).toEqual(["OPENCODE_GO_WORKSPACE_ID", "OPENCODE_GO_AUTH_COOKIE"]);
    expect(AMBIGUOUS_ZEN_ENV_NAMES).toEqual(["OPENCODE_WORKSPACE_ID", "OPENCODE_AUTH_COOKIE"]);
    expect(OBSOLETE_GO_FILE).toBe("opencode-quota/opencode-go.json");
    expect(SUPPORTED_ZEN_FILE).toBe("opencode-quota/opencode.json");
  });

  it.each([
    ["OPENCODE_GO_WORKSPACE_ID"],
    ["OPENCODE_GO_AUTH_COOKIE"],
    ["OPENCODE_GO_WORKSPACE_ID", "OPENCODE_GO_AUTH_COOKIE"],
  ] as const)("detects obsolete Go env names by own-property presence: %s", async (...names) => {
    const root = tempDir();
    const env: NodeJS.ProcessEnv = {};
    for (const name of names) env[name] = "go-secret-canary";

    const findings = await auditObsoleteUpdateSources({
      env,
      configDirs: [root],
      primaryConfigDir: root,
    });

    expect(findings.filter((finding) => finding.kind === "obsolete-go-env")).toEqual(
      names.map((name) => ({ kind: "obsolete-go-env", name })),
    );
    expect(JSON.stringify(findings)).not.toContain("go-secret-canary");
  });

  it("reports the exact obsolete Go path under every global config candidate", async () => {
    const root = tempDir();
    const configDirs = [join(root, "first"), join(root, "second")];
    const paths = configDirs.map((dir) => join(dir, OBSOLETE_GO_FILE));
    for (const path of paths) write(path, "legacy-file-secret-canary");

    const findings = await auditObsoleteUpdateSources({
      env: {},
      configDirs,
      primaryConfigDir: configDirs[0] ?? root,
    });

    expect(findings).toEqual(paths.map((path) => ({ kind: "obsolete-go-file", path })));
    expect(JSON.stringify(findings)).not.toContain("legacy-file-secret-canary");
  });

  it("never scans repository or workspace roots for credential files", async () => {
    const root = tempDir();
    const globalRoot = join(root, "global");
    write(join(root, "workspace", OBSOLETE_GO_FILE), "workspace-secret-canary");

    const findings = await auditObsoleteUpdateSources({
      env: {},
      configDirs: [globalRoot],
      primaryConfigDir: globalRoot,
    });

    expect(findings).toEqual([]);
  });

  it.each([
    ["OPENCODE_WORKSPACE_ID"],
    ["OPENCODE_AUTH_COOKIE"],
    ["OPENCODE_WORKSPACE_ID", "OPENCODE_AUTH_COOKIE"],
  ] as const)("groups present ambiguous Zen names without values: %s", async (...names) => {
    const root = tempDir();
    const env: NodeJS.ProcessEnv = {};
    for (const name of names) env[name] = "zen-secret-canary";

    const findings = await auditObsoleteUpdateSources({
      env,
      configDirs: [root],
      primaryConfigDir: root,
    });

    expect(findings).toEqual([
      {
        kind: "ambiguous-zen-env",
        names,
        suggestedPath: join(root, SUPPORTED_ZEN_FILE),
      },
    ]);
    expect(JSON.stringify(findings)).not.toContain("zen-secret-canary");
  });

  it.each([
    "malformed",
    "incomplete",
    "symlink",
  ])("suppresses ambiguous Zen findings when any supported file path exists: %s", async (kind) => {
    const root = tempDir();
    const first = join(root, "first");
    const second = join(root, "second");
    const supportedPath = join(second, SUPPORTED_ZEN_FILE);
    if (kind === "symlink") {
      const target = join(root, "target.json");
      write(target, "supported-file-secret-canary");
      mkdirSync(dirname(supportedPath), { recursive: true });
      symlinkSync(target, supportedPath);
    } else {
      write(supportedPath, kind === "malformed" ? "{" : "{}");
    }

    const findings = await auditObsoleteUpdateSources({
      env: {
        OPENCODE_WORKSPACE_ID: "zen-workspace-secret",
        OPENCODE_AUTH_COOKIE: "zen-cookie-secret",
      },
      configDirs: [first, second],
      primaryConfigDir: first,
    });

    expect(findings).toEqual([]);
  });

  it("deduplicates config paths while preserving first config-dir order", async () => {
    const root = tempDir();
    const first = join(root, "first");
    const second = join(root, "second");
    write(join(first, OBSOLETE_GO_FILE), "one");
    write(join(second, OBSOLETE_GO_FILE), "two");

    const findings = await auditObsoleteUpdateSources({
      env: {},
      configDirs: [first, first, second],
      primaryConfigDir: first,
    });

    expect(findings).toEqual([
      { kind: "obsolete-go-file", path: join(first, OBSOLETE_GO_FILE) },
      { kind: "obsolete-go-file", path: join(second, OBSOLETE_GO_FILE) },
    ]);
  });
});

describe("presentation sorting", () => {
  it("sorts copies deterministically without changing discovery/write order", () => {
    const actions: ScopedUpdateSafeAction[] = [
      { kind: "package-spec", path: "/z", replacements: 1 },
      {
        kind: "accounting-detail-migration",
        path: "/a",
        container: "quota-root",
        from: "default",
        to: "summary",
        outcome: "set-and-remove-old",
      },
    ];
    const findings: ScopedUpdateManualFinding[] = [
      { kind: "obsolete-go-file", path: "/z" },
      {
        kind: "migration-file-uninspectable",
        path: "/a",
        reason: "invalid-json",
      },
    ];

    expect(sortScopedUpdateSafeActions(actions).map((action) => action.path)).toEqual(["/a", "/z"]);
    expect(sortScopedUpdateManualFindings(findings).map((finding) => finding.kind)).toEqual([
      "migration-file-uninspectable",
      "obsolete-go-file",
    ]);
    expect(actions[0]?.path).toBe("/z");
    expect(findings[0]?.kind).toBe("obsolete-go-file");
  });
});
