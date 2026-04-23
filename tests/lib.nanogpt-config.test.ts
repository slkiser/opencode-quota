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

describe("nanogpt-config", () => {
  const originalEnv = process.env;
  const trustedPaths = getTrustedOpencodeConfigPaths();
  const workspacePaths = getWorkspaceOpencodeConfigPaths();
  let fsConfigMocks: Awaited<ReturnType<typeof loadFsConfigMocks>>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    resetProcessEnv(originalEnv, [
      "NANOGPT_API_KEY",
      "NANO_GPT_API_KEY",
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

  describe("resolveNanoGptApiKey", () => {
    it("returns env var NANOGPT_API_KEY when set", async () => {
      process.env.NANOGPT_API_KEY = "env-key-1";

      const { resolveNanoGptApiKey } = await import("../src/lib/nanogpt-config.js");
      await expect(resolveNanoGptApiKey()).resolves.toEqual({
        key: "env-key-1",
        source: "env:NANOGPT_API_KEY",
      });
    });

    it("returns env var NANO_GPT_API_KEY when NANOGPT_API_KEY is not set", async () => {
      process.env.NANO_GPT_API_KEY = "env-key-2";

      const { resolveNanoGptApiKey } = await import("../src/lib/nanogpt-config.js");
      await expect(resolveNanoGptApiKey()).resolves.toEqual({
        key: "env-key-2",
        source: "env:NANO_GPT_API_KEY",
      });
    });

    it("reads from trusted global opencode.json provider.nanogpt", async () => {
      mockTrustedConfigFile(
        fsConfigMocks,
        trustedPaths.json,
        JSON.stringify({
          provider: {
            nanogpt: {
              options: {
                apiKey: "json-api-key",
              },
            },
          },
        }),
      );
      const { resolveNanoGptApiKey } = await import("../src/lib/nanogpt-config.js");
      await expect(resolveNanoGptApiKey()).resolves.toEqual({
        key: "json-api-key",
        source: "opencode.json",
      });
    });

    it("reads from trusted global opencode.jsonc provider.nano-gpt", async () => {
      mockTrustedConfigFile(
        fsConfigMocks,
        trustedPaths.jsonc,
        `{
        "provider": {
          "nano-gpt": {
            "options": {
              "apiKey": "jsonc-api-key"
            }
          }
        }
      }`,
      );
      const { resolveNanoGptApiKey } = await import("../src/lib/nanogpt-config.js");
      await expect(resolveNanoGptApiKey()).resolves.toEqual({
        key: "jsonc-api-key",
        source: "opencode.jsonc",
      });
    });

    it("rejects arbitrary env-template names in trusted config", async () => {
      const { readAuthFile } = await import("../src/lib/opencode-auth.js");

      mockTrustedConfigFile(
        fsConfigMocks,
        trustedPaths.json,
        JSON.stringify({
          provider: {
            nanogpt: {
              options: {
                apiKey: "{env:SOMETHING_ELSE}",
              },
            },
          },
        }),
      );
      (readAuthFile as any).mockResolvedValue(null);

      const { resolveNanoGptApiKey } = await import("../src/lib/nanogpt-config.js");
      await expect(resolveNanoGptApiKey()).resolves.toBeNull();
    });

    it("falls back to nano-gpt alias when nanogpt env template is invalid", async () => {
      mockTrustedConfigFile(
        fsConfigMocks,
        trustedPaths.json,
        JSON.stringify({
          provider: {
            nanogpt: {
              options: {
                apiKey: "{env:SOMETHING_ELSE}",
              },
            },
            "nano-gpt": {
              options: {
                apiKey: "json-alias-key",
              },
            },
          },
        }),
      );
      const { resolveNanoGptApiKey } = await import("../src/lib/nanogpt-config.js");
      await expect(resolveNanoGptApiKey()).resolves.toEqual({
        key: "json-alias-key",
        source: "opencode.json",
      });
    });

    it.each([
      ["opencode.json", workspacePaths.json],
      ["opencode.jsonc", workspacePaths.jsonc],
    ])("ignores workspace-local %s when resolving provider secrets", async (_label, workspacePath) => {
      const { readAuthFile } = await import("../src/lib/opencode-auth.js");

      fsConfigMocks.existsSync.mockImplementation((path: string) => path === workspacePath);
      (readAuthFile as any).mockResolvedValue(null);

      const { resolveNanoGptApiKey } = await import("../src/lib/nanogpt-config.js");
      await expect(resolveNanoGptApiKey()).resolves.toBeNull();
    });

    it("falls back to auth.json for nanogpt and nano-gpt keys", async () => {
      const { readAuthFile } = await import("../src/lib/opencode-auth.js");

      fsConfigMocks.existsSync.mockReturnValue(false);
      (readAuthFile as any).mockResolvedValueOnce({
        nanogpt: {
          type: "api",
          key: "auth-key-1",
        },
      });

      const { resolveNanoGptApiKey } = await import("../src/lib/nanogpt-config.js");
      await expect(resolveNanoGptApiKey()).resolves.toEqual({
        key: "auth-key-1",
        source: "auth.json",
      });

      vi.resetModules();
      vi.clearAllMocks();

      fsConfigMocks = await loadFsConfigMocks();
      resetFsConfigMocks(fsConfigMocks);
      const authAgain = await import("../src/lib/opencode-auth.js");
      fsConfigMocks.existsSync.mockReturnValue(false);
      (authAgain.readAuthFile as any).mockResolvedValueOnce({
        "nano-gpt": {
          type: "api",
          key: "auth-key-2",
        },
      });

      const reload = await import("../src/lib/nanogpt-config.js");
      await expect(reload.resolveNanoGptApiKey()).resolves.toEqual({
        key: "auth-key-2",
        source: "auth.json",
      });
    });
  });

  describe("hasNanoGptApiKey", () => {
    it("returns true when a key is configured", async () => {
      process.env.NANOGPT_API_KEY = "test-key";

      const { hasNanoGptApiKey } = await import("../src/lib/nanogpt-config.js");
      await expect(hasNanoGptApiKey()).resolves.toBe(true);
    });
  });

  describe("getNanoGptKeyDiagnostics", () => {
    it("returns configured diagnostics with source and env path", async () => {
      process.env.NANOGPT_API_KEY = "diag-key";

      const { getNanoGptKeyDiagnostics } = await import("../src/lib/nanogpt-config.js");
      const result = await getNanoGptKeyDiagnostics();

      expect(result.configured).toBe(true);
      expect(result.source).toBe("env:NANOGPT_API_KEY");
      expect(result.checkedPaths).toContain("env:NANOGPT_API_KEY");
      expect(result.authPaths).toContain(join(homedir(), ".local", "share", "opencode", "auth.json"));
    });

    it("reports checked trusted config paths", async () => {
      const { readAuthFile } = await import("../src/lib/opencode-auth.js");
      const expectedPath = trustedPaths.json;

      mockTrustedConfigFile(fsConfigMocks, expectedPath, "{}");
      (readAuthFile as any).mockResolvedValue(null);

      const { getNanoGptKeyDiagnostics } = await import("../src/lib/nanogpt-config.js");
      const result = await getNanoGptKeyDiagnostics();

      expect(result.configured).toBe(false);
      expect(result.checkedPaths).toContain(expectedPath);
      expect(result.authPaths).toContain(join(homedir(), ".local", "share", "opencode", "auth.json"));
    });
  });

  describe("getOpencodeConfigCandidatePaths", () => {
    it("returns trusted global paths only", async () => {
      const { getOpencodeConfigCandidatePaths } = await import("../src/lib/nanogpt-config.js");
      const paths = getOpencodeConfigCandidatePaths();

      expect(paths).toEqual([
        { path: join(homedir(), ".config", "opencode", "opencode.jsonc"), isJsonc: true },
        { path: join(homedir(), ".config", "opencode", "opencode.json"), isJsonc: false },
      ]);
    });
  });
});
