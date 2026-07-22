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

  it("prefers the PR #140 OPENCODE_* environment variables", async () => {
    process.env.OPENCODE_WORKSPACE_ID = "  wrk_zen  ";
    process.env.OPENCODE_AUTH_COOKIE = "  zen-cookie  ";
    process.env.OPENCODE_GO_WORKSPACE_ID = "wrk_go";
    process.env.OPENCODE_GO_AUTH_COOKIE = "go-cookie";

    const { resolveOpenCodeZenConfig } = await import("../src/lib/opencode-zen-config.js");

    await expect(resolveOpenCodeZenConfig()).resolves.toEqual({
      state: "configured",
      config: { workspaceId: "wrk_zen", authCookie: "zen-cookie" },
      source: "env(OPENCODE_*)",
    });
  });

  it("does not mix a partial Zen source with OpenCode Go credentials", async () => {
    process.env.OPENCODE_WORKSPACE_ID = "wrk_zen";
    process.env.OPENCODE_GO_WORKSPACE_ID = "wrk_go";
    process.env.OPENCODE_GO_AUTH_COOKIE = "go-cookie";

    const { resolveOpenCodeZenConfig } = await import("../src/lib/opencode-zen-config.js");

    await expect(resolveOpenCodeZenConfig()).resolves.toEqual({
      state: "incomplete",
      source: "env(OPENCODE_*)",
      missing: "OPENCODE_AUTH_COOKIE",
    });
  });

  it("does not reuse OpenCode Go credentials", async () => {
    process.env.OPENCODE_GO_WORKSPACE_ID = "wrk_go";
    process.env.OPENCODE_GO_AUTH_COOKIE = "go-cookie";

    const { resolveOpenCodeZenConfig } = await import("../src/lib/opencode-zen-config.js");

    await expect(resolveOpenCodeZenConfig()).resolves.toEqual({ state: "none" });
  });

  it("reads the first trusted runtime config file when env vars are absent", async () => {
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
    process.env.OPENCODE_WORKSPACE_ID = "wrk_secret";
    process.env.OPENCODE_AUTH_COOKIE = "cookie-secret";

    const { getOpenCodeZenConfigDiagnostics } = await import("../src/lib/opencode-zen-config.js");
    const diagnostics = await getOpenCodeZenConfigDiagnostics();

    expect(diagnostics).toEqual({
      state: "configured",
      source: "env(OPENCODE_*)",
      missing: null,
      error: null,
      checkedPaths: [],
    });
    expect(JSON.stringify(diagnostics)).not.toContain("cookie-secret");
    expect(JSON.stringify(diagnostics)).not.toContain("wrk_secret");
  });
});
