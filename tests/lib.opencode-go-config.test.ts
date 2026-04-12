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
  return join(configDir, "opencode-quota", "opencode-go.json");
}

async function createConfigDirs(): Promise<[string, string]> {
  const root = await mkdtemp(join(tmpdir(), "opencode-go-config-"));
  tempRoots.push(root);

  const primaryDir = join(root, "config-primary");
  const fallbackDir = join(root, "config-fallback");

  await mkdir(join(primaryDir, "opencode-quota"), { recursive: true });
  await mkdir(join(fallbackDir, "opencode-quota"), { recursive: true });

  return [primaryDir, fallbackDir];
}

describe("opencode-go config resolution", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.OPENCODE_GO_WORKSPACE_ID;
    delete process.env.OPENCODE_GO_AUTH_COOKIE;
  });

  afterEach(async () => {
    process.env = originalEnv;
    for (const root of tempRoots.splice(0, tempRoots.length)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stops at the first invalid config file instead of falling through to a lower-priority path", async () => {
    const [primaryDir, fallbackDir] = await createConfigDirs();
    const primaryPath = getConfigPath(primaryDir);
    const fallbackPath = getConfigPath(fallbackDir);

    runtimePathMocks.getOpencodeRuntimeDirCandidates.mockReturnValue({
      configDirs: [primaryDir, fallbackDir],
    });

    await writeFile(primaryPath, "[]");
    await writeFile(
      fallbackPath,
      JSON.stringify({ workspaceId: "ws-fallback", authCookie: "cookie-fallback" }),
    );

    const { resolveOpenCodeGoConfig } = await import("../src/lib/opencode-go-config.js");

    await expect(resolveOpenCodeGoConfig()).resolves.toEqual({
      state: "invalid",
      source: primaryPath,
      error: "Config file must contain a JSON object",
    });
  });

  it("reports invalid config details in diagnostics", async () => {
    const [primaryDir] = await createConfigDirs();
    const primaryPath = getConfigPath(primaryDir);

    runtimePathMocks.getOpencodeRuntimeDirCandidates.mockReturnValue({
      configDirs: [primaryDir],
    });

    await writeFile(primaryPath, "{");

    const { getOpenCodeGoConfigDiagnostics } = await import("../src/lib/opencode-go-config.js");

    await expect(getOpenCodeGoConfigDiagnostics()).resolves.toMatchObject({
      state: "invalid",
      source: primaryPath,
      missing: null,
      checkedPaths: [primaryPath],
    });

    const diagnostics = await getOpenCodeGoConfigDiagnostics();
    expect(diagnostics.error).toContain("Failed to parse JSON:");
  });
});
