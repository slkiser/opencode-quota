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

async function createConfigDirs(): Promise<[string, string]> {
  const root = await mkdtemp(join(tmpdir(), "opencode-zen-config-"));
  tempRoots.push(root);
  const primaryDir = join(root, "config-primary");
  const fallbackDir = join(root, "config-fallback");
  await mkdir(join(primaryDir, "opencode-quota"), { recursive: true });
  await mkdir(join(fallbackDir, "opencode-quota"), { recursive: true });
  return [primaryDir, fallbackDir];
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
  });

  afterEach(async () => {
    process.env = originalEnv;
    for (const root of tempRoots.splice(0, tempRoots.length)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves from OPENCODE_* env vars", async () => {
    process.env.OPENCODE_WORKSPACE_ID = "wrk_env";
    process.env.OPENCODE_AUTH_COOKIE = "cookie-env";
    const { resolveOpenCodeZenConfig } = await import("../src/lib/opencode-zen-config.js");
    await expect(resolveOpenCodeZenConfig()).resolves.toEqual({
      state: "configured",
      config: { workspaceId: "wrk_env", authCookie: "cookie-env" },
      source: "env(OPENCODE_*)",
    });
  });

  it("falls back to OPENCODE_GO_* compat env vars", async () => {
    process.env.OPENCODE_GO_WORKSPACE_ID = "wrk_go";
    process.env.OPENCODE_GO_AUTH_COOKIE = "cookie-go";
    const { resolveOpenCodeZenConfig } = await import("../src/lib/opencode-zen-config.js");
    await expect(resolveOpenCodeZenConfig()).resolves.toEqual({
      state: "configured",
      config: { workspaceId: "wrk_go", authCookie: "cookie-go" },
      source: "env(OPENCODE_GO_*)",
    });
  });

  it("reads config file when env vars are absent", async () => {
    const [primaryDir] = await createConfigDirs();
    const path = configPath(primaryDir);
    await writeFile(path, JSON.stringify({ workspaceId: "wrk_file", authCookie: "cookie-file" }));
    runtimePathMocks.getOpencodeRuntimeDirCandidates.mockReturnValue({ configDirs: [primaryDir] });
    const { resolveOpenCodeZenConfig } = await import("../src/lib/opencode-zen-config.js");
    await expect(resolveOpenCodeZenConfig()).resolves.toEqual({
      state: "configured",
      config: { workspaceId: "wrk_file", authCookie: "cookie-file" },
      source: path,
    });
  });

  it("returns incomplete when config file is missing keys", async () => {
    const [primaryDir] = await createConfigDirs();
    const path = configPath(primaryDir);
    await writeFile(path, JSON.stringify({ workspaceId: "wrk_only" }));
    runtimePathMocks.getOpencodeRuntimeDirCandidates.mockReturnValue({ configDirs: [primaryDir] });
    const { resolveOpenCodeZenConfig } = await import("../src/lib/opencode-zen-config.js");
    await expect(resolveOpenCodeZenConfig()).resolves.toEqual({
      state: "incomplete",
      source: path,
      missing: "authCookie",
    });
  });

  it("stops at the first invalid config file", async () => {
    const [primaryDir, fallbackDir] = await createConfigDirs();
    const path = configPath(primaryDir);
    await writeFile(path, "[]");
    await writeFile(configPath(fallbackDir), JSON.stringify({ workspaceId: "ws-ok", authCookie: "cookie-ok" }));
    runtimePathMocks.getOpencodeRuntimeDirCandidates.mockReturnValue({ configDirs: [primaryDir, fallbackDir] });
    const { resolveOpenCodeZenConfig } = await import("../src/lib/opencode-zen-config.js");
    await expect(resolveOpenCodeZenConfig()).resolves.toEqual({
      state: "invalid",
      source: path,
      error: "Config file must contain a JSON object",
    });
  });

  it("uses cached config within TTL", async () => {
    const [primaryDir] = await createConfigDirs();
    const path = configPath(primaryDir);
    await writeFile(path, JSON.stringify({ workspaceId: "wrk_initial", authCookie: "cookie-initial" }));
    runtimePathMocks.getOpencodeRuntimeDirCandidates.mockReturnValue({ configDirs: [primaryDir] });
    const { resolveOpenCodeZenConfigCached } = await import("../src/lib/opencode-zen-config.js");
    const first = await resolveOpenCodeZenConfigCached({ maxAgeMs: 5000 });
    expect(first).toEqual({ state: "configured", config: { workspaceId: "wrk_initial", authCookie: "cookie-initial" }, source: path });
    await writeFile(path, JSON.stringify({ workspaceId: "wrk_changed", authCookie: "cookie-changed" }));
    await expect(resolveOpenCodeZenConfigCached({ maxAgeMs: 5000 })).resolves.toEqual(first);
  });
});
