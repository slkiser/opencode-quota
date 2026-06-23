import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtimePathMocks = vi.hoisted(() => ({
  getOpencodeRuntimeDirCandidates: vi.fn(),
}));

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirCandidates: runtimePathMocks.getOpencodeRuntimeDirCandidates,
}));

const tempRoots: string[] = [];
const originalEnv = process.env;

function getConfigPath(configDir: string): string {
  return join(configDir, "opencode-quota", "opencode.json");
}

async function createConfigDirs(): Promise<[string, string]> {
  const root = await mkdtemp(join(tmpdir(), "opencode-zen-config-"));
  tempRoots.push(root);
  const primaryDir = join(root, "config-primary");
  const fallbackDir = join(root, "config-fallback");
  await mkdir(join(primaryDir, "opencode-quota"), { recursive: true });
  await mkdir(join(fallbackDir, "opencode-quota"), { recursive: true });
  return [primaryDir, fallbackDir];
}

describe("opencode-zen config resolution", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.OPENCODE_WORKSPACE_ID;
    delete process.env.OPENCODE_AUTH_COOKIE;
    delete process.env.OPENCODE_GO_WORKSPACE_ID;
    delete process.env.OPENCODE_GO_AUTH_COOKIE;
  });

  afterEach(async () => {
    process.env = originalEnv;
    for (const root of tempRoots.splice(0, tempRoots.length)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  describe("resolveOpenCodeZenConfigFromEnv", () => {
    it.each([
      ["preferred OPENCODE_*", { OPENCODE_WORKSPACE_ID: "wrk_abc", OPENCODE_AUTH_COOKIE: "cookie-abc" }, { state: "configured", config: { workspaceId: "wrk_abc", authCookie: "cookie-abc" }, source: "env(OPENCODE_*)" }],
      ["compat OPENCODE_GO_* (preferred absent)", { OPENCODE_GO_WORKSPACE_ID: "wrk_def", OPENCODE_GO_AUTH_COOKIE: "cookie-def" }, { state: "configured", config: { workspaceId: "wrk_def", authCookie: "cookie-def" }, source: "env(OPENCODE_GO_*)" }],
      ["both sets, prefers OPENCODE_*", { OPENCODE_WORKSPACE_ID: "wrk_pref", OPENCODE_AUTH_COOKIE: "cookie-pref", OPENCODE_GO_WORKSPACE_ID: "wrk_comp", OPENCODE_GO_AUTH_COOKIE: "cookie-comp" }, { state: "configured", config: { workspaceId: "wrk_pref", authCookie: "cookie-pref" }, source: "env(OPENCODE_*)" }],
    ])("returns configured from %s", async (_name, env, expected) => {
      const { resolveOpenCodeZenConfigFromEnv } = await import("../src/lib/opencode-zen-config.js");
      expect(resolveOpenCodeZenConfigFromEnv(env as NodeJS.ProcessEnv)).toEqual(expected);
    });

    it.each([
      ["only OPENCODE_WORKSPACE_ID set", { OPENCODE_WORKSPACE_ID: "wrk_abc" }, "env(OPENCODE_*)", "OPENCODE_AUTH_COOKIE"],
      ["only OPENCODE_GO_AUTH_COOKIE set", { OPENCODE_GO_AUTH_COOKIE: "cookie-only" }, "env(OPENCODE_GO_*)", "OPENCODE_GO_WORKSPACE_ID"],
    ])("returns incomplete when %s", async (_name, env, source, missing) => {
      const { resolveOpenCodeZenConfigFromEnv } = await import("../src/lib/opencode-zen-config.js");
      expect(resolveOpenCodeZenConfigFromEnv(env as NodeJS.ProcessEnv)).toEqual({ state: "incomplete", source, missing });
    });

    it("returns null when no env vars are set", async () => {
      const { resolveOpenCodeZenConfigFromEnv } = await import("../src/lib/opencode-zen-config.js");
      expect(resolveOpenCodeZenConfigFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
    });
  });

  describe("resolveOpenCodeZenConfig", () => {
    it("uses env vars before config file", async () => {
      const [primaryDir] = await createConfigDirs();
      await writeFile(getConfigPath(primaryDir), JSON.stringify({ workspaceId: "wrk_file", authCookie: "cookie-file" }));
      runtimePathMocks.getOpencodeRuntimeDirCandidates.mockReturnValue({ configDirs: [primaryDir] });
      process.env.OPENCODE_WORKSPACE_ID = "wrk_env";
      process.env.OPENCODE_AUTH_COOKIE = "cookie-env";
      const { resolveOpenCodeZenConfig } = await import("../src/lib/opencode-zen-config.js");
      expect(await resolveOpenCodeZenConfig()).toEqual({ state: "configured", config: { workspaceId: "wrk_env", authCookie: "cookie-env" }, source: "env(OPENCODE_*)" });
    });

    it("reads config from first valid config file when env is absent", async () => {
      const [primaryDir] = await createConfigDirs();
      const primaryPath = getConfigPath(primaryDir);
      await writeFile(primaryPath, JSON.stringify({ workspaceId: "wrk_file", authCookie: "cookie-file" }));
      runtimePathMocks.getOpencodeRuntimeDirCandidates.mockReturnValue({ configDirs: [primaryDir] });
      const { resolveOpenCodeZenConfig } = await import("../src/lib/opencode-zen-config.js");
      expect(await resolveOpenCodeZenConfig()).toEqual({ state: "configured", config: { workspaceId: "wrk_file", authCookie: "cookie-file" }, source: primaryPath });
    });

    it("returns none when no env vars and no config file exists", async () => {
      const [primaryDir, fallbackDir] = await createConfigDirs();
      runtimePathMocks.getOpencodeRuntimeDirCandidates.mockReturnValue({ configDirs: [primaryDir, fallbackDir] });
      const { resolveOpenCodeZenConfig } = await import("../src/lib/opencode-zen-config.js");
      expect(await resolveOpenCodeZenConfig()).toEqual({ state: "none" });
    });

    it("stops at the first invalid config file", async () => {
      const [primaryDir, fallbackDir] = await createConfigDirs();
      const primaryPath = getConfigPath(primaryDir);
      await writeFile(primaryPath, "[]");
      await writeFile(getConfigPath(fallbackDir), JSON.stringify({ workspaceId: "ws-fallback", authCookie: "cookie-fallback" }));
      runtimePathMocks.getOpencodeRuntimeDirCandidates.mockReturnValue({ configDirs: [primaryDir, fallbackDir] });
      const { resolveOpenCodeZenConfig } = await import("../src/lib/opencode-zen-config.js");
      expect(await resolveOpenCodeZenConfig()).toEqual({ state: "invalid", source: primaryPath, error: "Config file must contain a JSON object" });
    });

    it("returns incomplete when config file is missing keys", async () => {
      const [primaryDir] = await createConfigDirs();
      const primaryPath = getConfigPath(primaryDir);
      await writeFile(primaryPath, JSON.stringify({ workspaceId: "wrk_only" }));
      runtimePathMocks.getOpencodeRuntimeDirCandidates.mockReturnValue({ configDirs: [primaryDir] });
      const { resolveOpenCodeZenConfig } = await import("../src/lib/opencode-zen-config.js");
      expect(await resolveOpenCodeZenConfig()).toEqual({ state: "incomplete", source: primaryPath, missing: "authCookie" });
    });
  });

  describe("config caching", () => {
    it("uses cached config within TTL", async () => {
      const [primaryDir] = await createConfigDirs();
      const primaryPath = getConfigPath(primaryDir);
      await writeFile(primaryPath, JSON.stringify({ workspaceId: "wrk_initial", authCookie: "cookie-initial" }));
      runtimePathMocks.getOpencodeRuntimeDirCandidates.mockReturnValue({ configDirs: [primaryDir] });
      const { resolveOpenCodeZenConfigCached } = await import("../src/lib/opencode-zen-config.js");
      const first = await resolveOpenCodeZenConfigCached({ maxAgeMs: 5000 });
      expect(first).toEqual({ state: "configured", config: { workspaceId: "wrk_initial", authCookie: "cookie-initial" }, source: primaryPath });
      await writeFile(primaryPath, JSON.stringify({ workspaceId: "wrk_changed", authCookie: "cookie-changed" }));
      expect(await resolveOpenCodeZenConfigCached({ maxAgeMs: 5000 })).toEqual(first);
    });
  });

  describe("getOpenCodeZenConfigDiagnostics", () => {
    it("reports configured state with source", async () => {
      const [primaryDir] = await createConfigDirs();
      const primaryPath = getConfigPath(primaryDir);
      await writeFile(primaryPath, JSON.stringify({ workspaceId: "wrk_diag", authCookie: "cookie-diag" }));
      runtimePathMocks.getOpencodeRuntimeDirCandidates.mockReturnValue({ configDirs: [primaryDir] });
      const { getOpenCodeZenConfigDiagnostics } = await import("../src/lib/opencode-zen-config.js");
      expect(await getOpenCodeZenConfigDiagnostics()).toEqual({ state: "configured", source: primaryPath, missing: null, error: null, checkedPaths: [primaryPath] });
    });

    it("reports invalid config details in diagnostics", async () => {
      const [primaryDir] = await createConfigDirs();
      const primaryPath = getConfigPath(primaryDir);
      await writeFile(primaryPath, "{");
      runtimePathMocks.getOpencodeRuntimeDirCandidates.mockReturnValue({ configDirs: [primaryDir] });
      const { getOpenCodeZenConfigDiagnostics } = await import("../src/lib/opencode-zen-config.js");
      const result = await getOpenCodeZenConfigDiagnostics();
      expect(result.state).toBe("invalid");
      expect(result.source).toBe(primaryPath);
      expect(result.error).toContain("Failed to parse JSON:");
    });

    it("reports none state with checked paths", async () => {
      const [primaryDir, fallbackDir] = await createConfigDirs();
      runtimePathMocks.getOpencodeRuntimeDirCandidates.mockReturnValue({ configDirs: [primaryDir, fallbackDir] });
      const { getOpenCodeZenConfigDiagnostics } = await import("../src/lib/opencode-zen-config.js");
      expect(await getOpenCodeZenConfigDiagnostics()).toEqual({ state: "none", source: null, missing: null, error: null, checkedPaths: [primaryDir, fallbackDir].map(d => getConfigPath(d)) });
    });
  });
});
