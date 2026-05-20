import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { homedir } from "os";
import { join } from "path";
import {
  createRuntimePathsMockModule,
  getTrustedOpencodeConfigPaths,
  getWorkspaceOpencodeConfigPaths,
  loadFsConfigMocks,
  mockTrustedConfigFile,
  resetFsConfigMocks,
  resetProcessEnv,
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
  getAuthPaths: () => [join(homedir(), ".local", "share", "opencode", "auth.json")],
}));

describe("deepseek-auth", () => {
  const originalEnv = process.env;
  const trustedPaths = getTrustedOpencodeConfigPaths();
  const workspacePaths = getWorkspaceOpencodeConfigPaths();
  let fsConfigMocks: Awaited<ReturnType<typeof loadFsConfigMocks>>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    resetProcessEnv(originalEnv, [
      "DEEPSEEK_API_KEY",
      "SOMETHING_ELSE",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_CACHE_HOME",
      "XDG_STATE_HOME",
    ]);
    fsConfigMocks = await loadFsConfigMocks();
    resetFsConfigMocks(fsConfigMocks);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns env var DEEPSEEK_API_KEY when set", async () => {
    process.env.DEEPSEEK_API_KEY = "env-key";

    const { resolveDeepSeekApiKey } = await import("../src/lib/deepseek-auth.js");
    await expect(resolveDeepSeekApiKey()).resolves.toEqual({
      key: "env-key",
      source: "env:DEEPSEEK_API_KEY",
    });
  });

  it("reads from trusted global opencode.json", async () => {
    mockTrustedConfigFile(
      fsConfigMocks,
      trustedPaths.json,
      JSON.stringify({
        provider: {
          deepseek: {
            options: {
              apiKey: "json-api-key",
            },
          },
        },
      }),
    );

    const { resolveDeepSeekApiKey } = await import("../src/lib/deepseek-auth.js");
    await expect(resolveDeepSeekApiKey()).resolves.toEqual({
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
          "deepseek": {
            "options": {
              "apiKey": "jsonc-api-key"
            }
          }
        }
      }`,
    );

    const { resolveDeepSeekApiKey } = await import("../src/lib/deepseek-auth.js");
    await expect(resolveDeepSeekApiKey()).resolves.toEqual({
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
          deepseek: {
            options: {
              apiKey: "{env:SOMETHING_ELSE}",
            },
          },
        },
      }),
    );
    (readAuthFile as any).mockResolvedValue(null);

    const { resolveDeepSeekApiKey } = await import("../src/lib/deepseek-auth.js");
    await expect(resolveDeepSeekApiKey()).resolves.toBeNull();
  });

  it.each([
    ["opencode.json", workspacePaths.json],
    ["opencode.jsonc", workspacePaths.jsonc],
  ])("ignores workspace-local %s when resolving provider secrets", async (_label, workspacePath) => {
    const { readAuthFile } = await import("../src/lib/opencode-auth.js");

    fsConfigMocks.existsSync.mockImplementation((path: string) => path === workspacePath);
    (readAuthFile as any).mockResolvedValue(null);

    const { resolveDeepSeekApiKey } = await import("../src/lib/deepseek-auth.js");
    await expect(resolveDeepSeekApiKey()).resolves.toBeNull();
  });

  it("falls back to auth.json when no other sources are configured", async () => {
    const { readAuthFile } = await import("../src/lib/opencode-auth.js");

    fsConfigMocks.existsSync.mockReturnValue(false);
    (readAuthFile as any).mockResolvedValue({
      deepseek: {
        type: "api",
        key: "auth-key",
      },
    });

    const { resolveDeepSeekApiKey } = await import("../src/lib/deepseek-auth.js");
    await expect(resolveDeepSeekApiKey()).resolves.toEqual({
      key: "auth-key",
      source: "auth.json",
    });
  });

  it("returns diagnostics with source, checked paths, and auth paths", async () => {
    process.env.DEEPSEEK_API_KEY = "diag-key";

    const { getDeepSeekKeyDiagnostics } = await import("../src/lib/deepseek-auth.js");
    const result = await getDeepSeekKeyDiagnostics();

    expect(result.configured).toBe(true);
    expect(result.source).toBe("env:DEEPSEEK_API_KEY");
    expect(result.checkedPaths).toContain("env:DEEPSEEK_API_KEY");
    expect(result.authPaths).toContain(join(homedir(), ".local", "share", "opencode", "auth.json"));
  });

  it("returns trusted global config candidate paths only", async () => {
    const { getOpencodeConfigCandidatePaths } = await import("../src/lib/deepseek-auth.js");

    expect(getOpencodeConfigCandidatePaths()).toEqual([
      { path: join(homedir(), ".config", "opencode", "opencode.jsonc"), isJsonc: true },
      { path: join(homedir(), ".config", "opencode", "opencode.json"), isJsonc: false },
    ]);
  });
});
