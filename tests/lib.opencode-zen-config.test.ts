import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtimePathMocks = vi.hoisted(() => ({
  getOpencodeRuntimeDirCandidates: vi.fn(),
}));

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirCandidates: runtimePathMocks.getOpencodeRuntimeDirCandidates,
}));

const originalEnv = process.env;
const tempRoots: string[] = [];

async function createConfigDirs(): Promise<[string, string]> {
  const root = await mkdtemp(join(tmpdir(), "opencode-zen-config-"));
  tempRoots.push(root);
  const primary = join(root, "primary");
  const fallback = join(root, "fallback");
  await mkdir(join(primary, "opencode-quota"), { recursive: true });
  await mkdir(join(fallback, "opencode-quota"), { recursive: true });
  return [primary, fallback];
}

function configPath(configDir: string): string {
  return join(configDir, "opencode-quota", "opencode.json");
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
    runtimePathMocks.getOpencodeRuntimeDirCandidates.mockReturnValue({ configDirs: [] });
  });

  afterEach(async () => {
    process.env = originalEnv;
    for (const root of tempRoots.splice(0)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores OPENCODE_* environment variables and reads only the config file", async () => {
    process.env.OPENCODE_WORKSPACE_ID = "wrk_env";
    process.env.OPENCODE_AUTH_COOKIE = "cookie-env";
    const [primary] = await createConfigDirs();
    const path = configPath(primary);
    await writeFile(path, JSON.stringify({ workspaceId: "wrk_file", authCookie: "cookie-file" }));
    runtimePathMocks.getOpencodeRuntimeDirCandidates.mockReturnValue({
      configDirs: [primary],
    });

    const { resolveOpenCodeZenConfig } = await import("../src/lib/opencode-zen-config.js");

    await expect(resolveOpenCodeZenConfig()).resolves.toEqual({
      state: "configured",
      config: { workspaceId: "wrk_file", authCookie: "cookie-file" },
      source: path,
    });
  });

  it("ignores OPENCODE_* environment variables when no config file exists", async () => {
    process.env.OPENCODE_WORKSPACE_ID = "wrk_env";
    process.env.OPENCODE_AUTH_COOKIE = "cookie-env";

    const { resolveOpenCodeZenConfig } = await import("../src/lib/opencode-zen-config.js");

    await expect(resolveOpenCodeZenConfig()).resolves.toEqual({ state: "none" });
  });

  it("reads the first trusted runtime config file", async () => {
    const [primary] = await createConfigDirs();
    const path = configPath(primary);
    await writeFile(
      path,
      JSON.stringify({ workspaceId: " wrk_file ", authCookie: " cookie-file " }),
    );
    runtimePathMocks.getOpencodeRuntimeDirCandidates.mockReturnValue({
      configDirs: [primary],
    });

    const { resolveOpenCodeZenConfig } = await import("../src/lib/opencode-zen-config.js");

    await expect(resolveOpenCodeZenConfig()).resolves.toEqual({
      state: "configured",
      config: { workspaceId: "wrk_file", authCookie: "cookie-file" },
      source: path,
    });
  });

  it("returns incomplete for missing and wrong-type file fields", async () => {
    const [primary] = await createConfigDirs();
    const path = configPath(primary);
    await writeFile(path, JSON.stringify({ workspaceId: 123, authCookie: "cookie" }));
    runtimePathMocks.getOpencodeRuntimeDirCandidates.mockReturnValue({
      configDirs: [primary],
    });

    const { resolveOpenCodeZenConfig } = await import("../src/lib/opencode-zen-config.js");

    await expect(resolveOpenCodeZenConfig()).resolves.toEqual({
      state: "incomplete",
      source: path,
      missing: "workspaceId",
    });
  });

  it("stops at the first invalid config instead of falling through", async () => {
    const [primary, fallback] = await createConfigDirs();
    await writeFile(configPath(primary), "[]");
    await writeFile(
      configPath(fallback),
      JSON.stringify({ workspaceId: "wrk_ok", authCookie: "cookie-ok" }),
    );
    runtimePathMocks.getOpencodeRuntimeDirCandidates.mockReturnValue({
      configDirs: [primary, fallback],
    });

    const { resolveOpenCodeZenConfig } = await import("../src/lib/opencode-zen-config.js");

    await expect(resolveOpenCodeZenConfig()).resolves.toEqual({
      state: "invalid",
      source: configPath(primary),
      error: "Config file must contain a JSON object",
    });
  });

  it("does not include malformed credential text in JSON parse errors", async () => {
    const [primary] = await createConfigDirs();
    const path = configPath(primary);
    await writeFile(path, '{"authCookie":super-secret}');
    runtimePathMocks.getOpencodeRuntimeDirCandidates.mockReturnValue({
      configDirs: [primary],
    });

    const { resolveOpenCodeZenConfig } = await import("../src/lib/opencode-zen-config.js");

    await expect(resolveOpenCodeZenConfig()).resolves.toEqual({
      state: "invalid",
      source: path,
      error: "Failed to parse JSON",
    });
  });

  it("keeps file-only resolution and public diagnostics unchanged after source audit", async () => {
    const [primary] = await createConfigDirs();
    const path = configPath(primary);
    const obsoleteGoPath = join(primary, "opencode-quota", "opencode-go.json");
    const zenWorkspaceCanary = "zen-file-workspace-canary";
    const zenCookieCanary = "zen-file-cookie-canary";
    const goFileCanary = "obsolete-go-file-canary";
    process.env.OPENCODE_WORKSPACE_ID = "zen-env-workspace-canary";
    process.env.OPENCODE_AUTH_COOKIE = "zen-env-cookie-canary";
    process.env.OPENCODE_GO_WORKSPACE_ID = "go-env-workspace-canary";
    process.env.OPENCODE_GO_AUTH_COOKIE = "go-env-cookie-canary";
    await writeFile(
      path,
      JSON.stringify({ workspaceId: zenWorkspaceCanary, authCookie: zenCookieCanary }),
    );
    await writeFile(obsoleteGoPath, JSON.stringify({ authCookie: goFileCanary }));
    runtimePathMocks.getOpencodeRuntimeDirCandidates.mockReturnValue({ configDirs: [primary] });

    const { getOpenCodeZenConfigDiagnostics, resolveOpenCodeZenConfig } = await import(
      "../src/lib/opencode-zen-config.js"
    );
    const beforeResult = await resolveOpenCodeZenConfig();
    const beforeDiagnostics = await getOpenCodeZenConfigDiagnostics();
    const zenBytesBeforeAudit = await readFile(path);
    const goBytesBeforeAudit = await readFile(obsoleteGoPath);
    const { auditObsoleteUpdateSources } = await import("../src/lib/scoped-update-migration.js");
    const findings = await auditObsoleteUpdateSources({
      env: process.env,
      configDirs: [primary],
      primaryConfigDir: primary,
    });
    expect(await readFile(path)).toEqual(zenBytesBeforeAudit);
    expect(await readFile(obsoleteGoPath)).toEqual(goBytesBeforeAudit);
    expect(process.env.OPENCODE_WORKSPACE_ID).toBe("zen-env-workspace-canary");
    expect(process.env.OPENCODE_AUTH_COOKIE).toBe("zen-env-cookie-canary");
    expect(process.env.OPENCODE_GO_WORKSPACE_ID).toBe("go-env-workspace-canary");
    expect(process.env.OPENCODE_GO_AUTH_COOKIE).toBe("go-env-cookie-canary");
    const afterResult = await resolveOpenCodeZenConfig();
    const afterDiagnostics = await getOpenCodeZenConfigDiagnostics();

    expect(beforeResult).toEqual({
      state: "configured",
      config: { workspaceId: zenWorkspaceCanary, authCookie: zenCookieCanary },
      source: path,
    });
    expect(afterResult).toEqual(beforeResult);
    expect(afterDiagnostics).toEqual(beforeDiagnostics);
    expect(findings).toEqual(
      expect.arrayContaining([
        { kind: "obsolete-go-env", name: "OPENCODE_GO_WORKSPACE_ID" },
        { kind: "obsolete-go-env", name: "OPENCODE_GO_AUTH_COOKIE" },
        { kind: "obsolete-go-file", path: obsoleteGoPath },
      ]),
    );
    expect(findings).not.toContainEqual(expect.objectContaining({ kind: "ambiguous-zen-env" }));

    const publicBoundary = JSON.stringify({ findings, beforeDiagnostics, afterDiagnostics });
    for (const canary of [
      zenWorkspaceCanary,
      zenCookieCanary,
      goFileCanary,
      "zen-env-workspace-canary",
      "zen-env-cookie-canary",
      "go-env-workspace-canary",
      "go-env-cookie-canary",
    ]) {
      expect(publicBoundary).not.toContain(canary);
    }
  });

  it("caches the resolved credentials within the configured TTL", async () => {
    const [primary] = await createConfigDirs();
    const path = configPath(primary);
    await writeFile(
      path,
      JSON.stringify({ workspaceId: "wrk_initial", authCookie: "cookie-initial" }),
    );
    runtimePathMocks.getOpencodeRuntimeDirCandidates.mockReturnValue({
      configDirs: [primary],
    });

    const { resolveOpenCodeZenConfigCached } = await import("../src/lib/opencode-zen-config.js");
    const first = await resolveOpenCodeZenConfigCached({ maxAgeMs: 5_000 });
    await writeFile(
      path,
      JSON.stringify({ workspaceId: "wrk_changed", authCookie: "cookie-changed" }),
    );

    await expect(resolveOpenCodeZenConfigCached({ maxAgeMs: 5_000 })).resolves.toEqual(first);
  });

  it("reports diagnostics without exposing credential values", async () => {
    const [primary] = await createConfigDirs();
    const path = configPath(primary);
    await writeFile(
      path,
      JSON.stringify({ workspaceId: "wrk_secret", authCookie: "cookie-secret" }),
    );
    runtimePathMocks.getOpencodeRuntimeDirCandidates.mockReturnValue({
      configDirs: [primary],
    });

    const { getOpenCodeZenConfigDiagnostics } = await import("../src/lib/opencode-zen-config.js");
    const diagnostics = await getOpenCodeZenConfigDiagnostics();

    expect(diagnostics).toEqual({
      state: "configured",
      source: path,
      missing: null,
      error: null,
      checkedPaths: [path],
    });
    expect(JSON.stringify(diagnostics)).not.toContain("cookie-secret");
    expect(JSON.stringify(diagnostics)).not.toContain("wrk_secret");
  });
});
