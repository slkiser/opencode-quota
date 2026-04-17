import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runtimeMocks = vi.hoisted(() => ({
  getOpencodeRuntimeDirCandidates: vi.fn(),
}));

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirCandidates: runtimeMocks.getOpencodeRuntimeDirCandidates,
}));

describe("inspectTuiConfig", () => {
  let tempDir: string;
  let projectDir: string;
  let globalDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "opencode-quota-tui-diag-"));
    projectDir = join(tempDir, "project");
    globalDir = join(tempDir, "global", "opencode");

    mkdirSync(projectDir, { recursive: true });
    mkdirSync(globalDir, { recursive: true });

    runtimeMocks.getOpencodeRuntimeDirCandidates.mockReturnValue({
      configDirs: [globalDir],
    });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("reports candidate paths and detects the quota plugin across tui config layers", async () => {
    mkdirSync(join(projectDir, ".opencode"), { recursive: true });

    writeFileSync(
      join(globalDir, "tui.json"),
      JSON.stringify({ plugin: ["some-other-plugin"] }),
      "utf8",
    );
    writeFileSync(
      join(projectDir, "tui.jsonc"),
      `{
        // local project tui config
        "plugin": ["@slkiser/opencode-quota"]
      }`,
      "utf8",
    );
    writeFileSync(
      join(projectDir, ".opencode", "tui.json"),
      JSON.stringify({ theme: "dark" }),
      "utf8",
    );

    const { inspectTuiConfig } = await import("../src/lib/tui-config-diagnostics.js");
    const diagnostics = await inspectTuiConfig({ cwd: projectDir });

    expect(diagnostics.configured).toBe(true);
    expect(diagnostics.inferredSelectedPath).toBe(join(projectDir, ".opencode", "tui.json"));
    expect(diagnostics.presentPaths).toEqual([
      join(globalDir, "tui.json"),
      join(projectDir, "tui.jsonc"),
      join(projectDir, ".opencode", "tui.json"),
    ]);
    expect(diagnostics.quotaPluginConfigured).toBe(true);
    expect(diagnostics.quotaPluginConfigPaths).toEqual([join(projectDir, "tui.jsonc")]);
  });

  it("supports local file plugin specs that point at dist/tui.tsx", async () => {
    writeFileSync(
      join(projectDir, "tui.json"),
      JSON.stringify({
        plugin: [["file:///Users/test/Downloads/GitHub/opencode-quota/dist/tui.tsx", { debug: true }]],
      }),
      "utf8",
    );

    const { inspectTuiConfig } = await import("../src/lib/tui-config-diagnostics.js");
    const diagnostics = await inspectTuiConfig({ cwd: projectDir });

    expect(diagnostics.quotaPluginConfigured).toBe(true);
    expect(diagnostics.quotaPluginConfigPaths).toEqual([join(projectDir, "tui.json")]);
  });

  it("does not treat the server dist/index.js entrypoint as a tui plugin", async () => {
    writeFileSync(
      join(projectDir, "tui.json"),
      JSON.stringify({
        plugin: ["file:///Users/test/Downloads/GitHub/opencode-quota/dist/index.js"],
      }),
      "utf8",
    );

    const { inspectTuiConfig } = await import("../src/lib/tui-config-diagnostics.js");
    const diagnostics = await inspectTuiConfig({ cwd: projectDir });

    expect(diagnostics.quotaPluginConfigured).toBe(false);
    expect(diagnostics.quotaPluginConfigPaths).toEqual([]);
  });

  it("detects worktree-root tui config when cwd is nested", async () => {
    const nestedDir = join(projectDir, "packages", "feature");
    mkdirSync(nestedDir, { recursive: true });
    mkdirSync(join(projectDir, ".git"), { recursive: true });
    mkdirSync(join(projectDir, ".opencode"), { recursive: true });

    writeFileSync(
      join(projectDir, ".opencode", "tui.json"),
      JSON.stringify({ plugin: ["@slkiser/opencode-quota"] }),
      "utf8",
    );

    const { inspectTuiConfig } = await import("../src/lib/tui-config-diagnostics.js");
    const diagnostics = await inspectTuiConfig({ cwd: nestedDir });

    expect(diagnostics.inferredSelectedPath).toBe(join(projectDir, ".opencode", "tui.json"));
    expect(diagnostics.quotaPluginConfigured).toBe(true);
    expect(diagnostics.quotaPluginConfigPaths).toEqual([join(projectDir, ".opencode", "tui.json")]);
  });

  it("reports missing tui config cleanly", async () => {
    const { inspectTuiConfig } = await import("../src/lib/tui-config-diagnostics.js");
    const diagnostics = await inspectTuiConfig({ cwd: projectDir });

    expect(diagnostics.configured).toBe(false);
    expect(diagnostics.inferredSelectedPath).toBeNull();
    expect(diagnostics.presentPaths).toEqual([]);
    expect(diagnostics.quotaPluginConfigured).toBe(false);
    expect(diagnostics.quotaPluginConfigPaths).toEqual([]);
    expect(diagnostics.candidatePaths).toContain(join(globalDir, "tui.json"));
    expect(diagnostics.candidatePaths).toContain(join(projectDir, "tui.jsonc"));
    expect(diagnostics.candidatePaths).toContain(join(projectDir, ".opencode", "tui.json"));
  });
});
