import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { homedir } from "os";
import { join } from "path";
import {
  createRuntimePathsMockModule,
  getTrustedAuthPath,
  getTrustedOpencodeConfigPaths,
  getWorkspaceOpencodeConfigPaths,
  loadFsConfigMocks,
  mockExistingConfigPath,
  mockTrustedConfigFile,
  resetFsConfigMocks,
  resetTrustedConfigTestEnv,
} from "./helpers/trusted-config-test-harness.js";

vi.mock("../src/lib/opencode-runtime-paths.js", () => createRuntimePathsMockModule());

vi.mock("fs", () => ({
  existsSync: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
}));

vi.mock("../src/lib/opencode-auth.js", () => ({
  readAuthFile: vi.fn(),
  getAuthPaths: () => [getTrustedAuthPath()],
}));

describe("openrouter-auth", () => {
  const originalEnv = process.env;
  const trustedPaths = getTrustedOpencodeConfigPaths();
  const workspacePaths = getWorkspaceOpencodeConfigPaths();
  let fsConfigMocks: Awaited<ReturnType<typeof loadFsConfigMocks>>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    resetTrustedConfigTestEnv(originalEnv, ["OPENROUTER_API_KEY", "SOMETHING_ELSE"]);
    fsConfigMocks = await loadFsConfigMocks();
    resetFsConfigMocks(fsConfigMocks);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns env var OPENROUTER_API_KEY when set", async () => {
    process.env.OPENROUTER_API_KEY = "env-key";

    const { resolveOpenRouterApiKey } = await import("../src/lib/openrouter-config.js");
    await expect(resolveOpenRouterApiKey()).resolves.toEqual({
      key: "env-key",
      source: "env:OPENROUTER_API_KEY",
    });
  });

  it("reads from trusted global opencode.json", async () => {
    mockTrustedConfigFile(
      fsConfigMocks,
      trustedPaths.json,
      JSON.stringify({
        provider: {
          openrouter: {
            options: {
              apiKey: "json-api-key",
            },
          },
        },
      }),
    );

    const { resolveOpenRouterApiKey } = await import("../src/lib/openrouter-config.js");
    await expect(resolveOpenRouterApiKey()).resolves.toEqual({
      key: "json-api-key",
      source: "opencode.json",
    });
  });

  it("reads from trusted global opencode.jsonc", async () => {
    mockTrustedConfigFile(
      fsConfigMocks,
      trustedPaths.jsonc,
      `{
        "provider": {
          "openrouter": {
            "options": {
              "apiKey": "jsonc-api-key"
            }
          }
        }
      }`,
    );

    const { resolveOpenRouterApiKey } = await import("../src/lib/openrouter-config.js");
    await expect(resolveOpenRouterApiKey()).resolves.toEqual({
      key: "jsonc-api-key",
      source: "opencode.jsonc",
    });
  });

  it("rejects arbitrary env-template names in trusted config", async () => {
    const { readAuthFile } = await import("../src/lib/opencode-auth.js");
    process.env.SOMETHING_ELSE = "should-not-be-used";

    mockTrustedConfigFile(
      fsConfigMocks,
      trustedPaths.json,
      JSON.stringify({
        provider: {
          openrouter: {
            options: {
              apiKey: "{env:SOMETHING_ELSE}",
            },
          },
        },
      }),
    );
    (readAuthFile as any).mockResolvedValue(null);

    const { resolveOpenRouterApiKey } = await import("../src/lib/openrouter-config.js");
    await expect(resolveOpenRouterApiKey()).resolves.toBeNull();
  });

  it.each([
    ["opencode.json", workspacePaths.json],
    ["opencode.jsonc", workspacePaths.jsonc],
  ])(
    "ignores workspace-local %s when resolving provider secrets",
    async (_label, workspacePath) => {
      const { readAuthFile } = await import("../src/lib/opencode-auth.js");

      mockExistingConfigPath(fsConfigMocks, workspacePath);
      (readAuthFile as any).mockResolvedValue(null);

      const { resolveOpenRouterApiKey } = await import("../src/lib/openrouter-config.js");
      await expect(resolveOpenRouterApiKey()).resolves.toBeNull();
    },
  );

  it("falls back to auth.json when no other sources are configured", async () => {
    const { readAuthFile } = await import("../src/lib/opencode-auth.js");

    fsConfigMocks.existsSync.mockReturnValue(false);
    (readAuthFile as any).mockResolvedValue({
      openrouter: {
        type: "api",
        key: "auth-key",
      },
    });

    const { resolveOpenRouterApiKey } = await import("../src/lib/openrouter-config.js");
    await expect(resolveOpenRouterApiKey()).resolves.toEqual({
      key: "auth-key",
      source: "auth.json",
    });
  });

  it("returns diagnostics with source, checked paths, and auth paths", async () => {
    process.env.OPENROUTER_API_KEY = "diag-key";

    const { getOpenRouterKeyDiagnostics } = await import("../src/lib/openrouter-config.js");
    const result = await getOpenRouterKeyDiagnostics();

    expect(result.configured).toBe(true);
    expect(result.source).toBe("env:OPENROUTER_API_KEY");
    expect(result.checkedPaths).toContain("env:OPENROUTER_API_KEY");
    expect(result.authPaths).toContain(getTrustedAuthPath());
  });

  it("returns trusted global config candidate paths only", async () => {
    const { getOpencodeConfigCandidatePaths } = await import("../src/lib/openrouter-config.js");

    expect(getOpencodeConfigCandidatePaths()).toEqual([
      { path: join(homedir(), ".config", "opencode", "opencode.jsonc"), isJsonc: true },
      { path: join(homedir(), ".config", "opencode", "opencode.json"), isJsonc: false },
    ]);
  });
});
