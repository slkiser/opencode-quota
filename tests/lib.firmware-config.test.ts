import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { join } from "path";
import { homedir } from "os";

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirCandidates: () => ({
    dataDirs: [join(homedir(), ".local", "share", "opencode")],
    configDirs: [join(homedir(), ".config", "opencode")],
    cacheDirs: [join(homedir(), ".cache", "opencode")],
    stateDirs: [join(homedir(), ".local", "state", "opencode")],
  }),
  getOpencodeRuntimeDirs: () => ({
    dataDir: join(homedir(), ".local", "share", "opencode"),
    configDir: join(homedir(), ".config", "opencode"),
    cacheDir: join(homedir(), ".cache", "opencode"),
    stateDir: join(homedir(), ".local", "state", "opencode"),
  }),
}));

// Mock fs and fs/promises before importing the module
vi.mock("fs", () => ({
  existsSync: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
}));

// Mock opencode-auth
vi.mock("../src/lib/opencode-auth.js", () => ({
  readAuthFile: vi.fn(),
}));

describe("firmware-config", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    // Reset environment
    process.env = { ...originalEnv };
    delete process.env.FIRMWARE_AI_API_KEY;
    delete process.env.FIRMWARE_API_KEY;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_DATA_HOME;
    delete process.env.XDG_CACHE_HOME;
    delete process.env.XDG_STATE_HOME;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("resolveFirmwareApiKey", () => {
    it("returns env var FIRMWARE_AI_API_KEY when set (highest priority)", async () => {
      process.env.FIRMWARE_AI_API_KEY = "env-key-1";

      const { resolveFirmwareApiKey } = await import("../src/lib/firmware-config.js");
      const result = await resolveFirmwareApiKey();

      expect(result).toEqual({
        key: "env-key-1",
        source: "env:FIRMWARE_AI_API_KEY",
      });
    });

    it("returns env var FIRMWARE_API_KEY when FIRMWARE_AI_API_KEY not set", async () => {
      process.env.FIRMWARE_API_KEY = "env-key-2";

      const { resolveFirmwareApiKey } = await import("../src/lib/firmware-config.js");
      const result = await resolveFirmwareApiKey();

      expect(result).toEqual({
        key: "env-key-2",
        source: "env:FIRMWARE_API_KEY",
      });
    });

    it("prefers FIRMWARE_AI_API_KEY over FIRMWARE_API_KEY", async () => {
      process.env.FIRMWARE_AI_API_KEY = "primary-key";
      process.env.FIRMWARE_API_KEY = "fallback-key";

      const { resolveFirmwareApiKey } = await import("../src/lib/firmware-config.js");
      const result = await resolveFirmwareApiKey();

      expect(result).toEqual({
        key: "primary-key",
        source: "env:FIRMWARE_AI_API_KEY",
      });
    });

    it("reads from opencode.json when env vars not set", async () => {
      const { existsSync } = await import("fs");
      const { readFile } = await import("fs/promises");

      (existsSync as any).mockImplementation((path: string) => {
        // Only match .json files, not .jsonc files
        return path.endsWith("opencode.json");
      });

      (readFile as any).mockResolvedValue(
        JSON.stringify({
          provider: {
            firmware: {
              options: {
                apiKey: "json-api-key",
              },
            },
          },
        }),
      );

      const { resolveFirmwareApiKey } = await import("../src/lib/firmware-config.js");
      const result = await resolveFirmwareApiKey();

      expect(result).toEqual({
        key: "json-api-key",
        source: "opencode.json",
      });
    });

    it("reads from opencode.jsonc with comments stripped", async () => {
      const { existsSync } = await import("fs");
      const { readFile } = await import("fs/promises");

      (existsSync as any).mockImplementation((path: string) => {
        return path.endsWith("opencode.jsonc");
      });

      (readFile as any).mockResolvedValue(`{
        // This is a comment
        "provider": {
          "firmware": {
            "options": {
              "apiKey": "jsonc-api-key" // inline comment
            }
          }
        }
      }`);

      const { resolveFirmwareApiKey } = await import("../src/lib/firmware-config.js");
      const result = await resolveFirmwareApiKey();

      expect(result).toEqual({
        key: "jsonc-api-key",
        source: "opencode.jsonc",
      });
    });

    it("resolves {env:VAR_NAME} syntax in opencode.json", async () => {
      process.env.MY_FIRMWARE_KEY = "resolved-from-env";

      const { existsSync } = await import("fs");
      const { readFile } = await import("fs/promises");

      (existsSync as any).mockImplementation((path: string) => {
        // Only match .json files, not .jsonc files
        return path.endsWith("opencode.json");
      });

      (readFile as any).mockResolvedValue(
        JSON.stringify({
          provider: {
            firmware: {
              options: {
                apiKey: "{env:MY_FIRMWARE_KEY}",
              },
            },
          },
        }),
      );

      const { resolveFirmwareApiKey } = await import("../src/lib/firmware-config.js");
      const result = await resolveFirmwareApiKey();

      expect(result).toEqual({
        key: "resolved-from-env",
        source: "opencode.json",
      });
    });

    it("returns null when {env:VAR_NAME} references unset variable", async () => {
      const { existsSync } = await import("fs");
      const { readFile } = await import("fs/promises");
      const { readAuthFile } = await import("../src/lib/opencode-auth.js");

      (existsSync as any).mockImplementation((path: string) => {
        return path.includes("opencode.json");
      });

      (readFile as any).mockResolvedValue(
        JSON.stringify({
          provider: {
            firmware: {
              options: {
                apiKey: "{env:NONEXISTENT_VAR}",
              },
            },
          },
        }),
      );

      (readAuthFile as any).mockResolvedValue(null);

      const { resolveFirmwareApiKey } = await import("../src/lib/firmware-config.js");
      const result = await resolveFirmwareApiKey();

      expect(result).toBeNull();
    });

    it("falls back to auth.json when no other sources configured", async () => {
      const { existsSync } = await import("fs");
      const { readAuthFile } = await import("../src/lib/opencode-auth.js");

      (existsSync as any).mockReturnValue(false);
      (readAuthFile as any).mockResolvedValue({
        firmware: {
          type: "api",
          key: "auth-json-key",
        },
      });

      const { resolveFirmwareApiKey } = await import("../src/lib/firmware-config.js");
      const result = await resolveFirmwareApiKey();

      expect(result).toEqual({
        key: "auth-json-key",
        source: "auth.json",
      });
    });

    it("returns null when no sources have a key", async () => {
      const { existsSync } = await import("fs");
      const { readAuthFile } = await import("../src/lib/opencode-auth.js");

      (existsSync as any).mockReturnValue(false);
      (readAuthFile as any).mockResolvedValue(null);

      const { resolveFirmwareApiKey } = await import("../src/lib/firmware-config.js");
      const result = await resolveFirmwareApiKey();

      expect(result).toBeNull();
    });

    it("ignores empty string env vars", async () => {
      process.env.FIRMWARE_AI_API_KEY = "   ";
      process.env.FIRMWARE_API_KEY = "";

      const { existsSync } = await import("fs");
      const { readAuthFile } = await import("../src/lib/opencode-auth.js");

      (existsSync as any).mockReturnValue(false);
      (readAuthFile as any).mockResolvedValue({
        firmware: {
          type: "api",
          key: "auth-key",
        },
      });

      const { resolveFirmwareApiKey } = await import("../src/lib/firmware-config.js");
      const result = await resolveFirmwareApiKey();

      expect(result).toEqual({
        key: "auth-key",
        source: "auth.json",
      });
    });
  });

  describe("hasFirmwareApiKey", () => {
    it("returns true when key is configured", async () => {
      process.env.FIRMWARE_AI_API_KEY = "test-key";

      const { hasFirmwareApiKey } = await import("../src/lib/firmware-config.js");
      const result = await hasFirmwareApiKey();

      expect(result).toBe(true);
    });

    it("returns false when no key is configured", async () => {
      const { existsSync } = await import("fs");
      const { readAuthFile } = await import("../src/lib/opencode-auth.js");

      (existsSync as any).mockReturnValue(false);
      (readAuthFile as any).mockResolvedValue(null);

      const { hasFirmwareApiKey } = await import("../src/lib/firmware-config.js");
      const result = await hasFirmwareApiKey();

      expect(result).toBe(false);
    });
  });

  describe("getFirmwareKeyDiagnostics", () => {
    it("returns diagnostics with source when configured", async () => {
      process.env.FIRMWARE_AI_API_KEY = "diag-key";

      const { getFirmwareKeyDiagnostics } = await import("../src/lib/firmware-config.js");
      const result = await getFirmwareKeyDiagnostics();

      expect(result.configured).toBe(true);
      expect(result.source).toBe("env:FIRMWARE_AI_API_KEY");
      expect(result.checkedPaths).toContain("env:FIRMWARE_AI_API_KEY");
    });

    it("returns diagnostics with checked paths", async () => {
      const { existsSync } = await import("fs");
      const { readAuthFile } = await import("../src/lib/opencode-auth.js");

      const expectedPath = join(homedir(), ".config", "opencode", "opencode.json");

      (existsSync as any).mockImplementation((path: string) => {
        return path === expectedPath;
      });
      (readAuthFile as any).mockResolvedValue(null);

      const { getFirmwareKeyDiagnostics } = await import("../src/lib/firmware-config.js");
      const result = await getFirmwareKeyDiagnostics();

      expect(result.configured).toBe(false);
      expect(result.checkedPaths).toContain(expectedPath);
    });
  });

  describe("getOpencodeConfigCandidatePaths", () => {
    it("returns paths in correct priority order", async () => {
      const { getOpencodeConfigCandidatePaths } = await import("../src/lib/firmware-config.js");
      const paths = getOpencodeConfigCandidatePaths();

      // Should have 4 candidates: local jsonc, local json, global jsonc, global json
      expect(paths.length).toBe(4);

      // Local paths should come before global paths
      expect(paths[0].path).toContain(process.cwd());
      expect(paths[0].isJsonc).toBe(true);
      expect(paths[1].path).toContain(process.cwd());
      expect(paths[1].isJsonc).toBe(false);

      // Global paths
      expect(paths[2].path).toContain("opencode");
      expect(paths[2].isJsonc).toBe(true);
      expect(paths[3].path).toContain("opencode");
      expect(paths[3].isJsonc).toBe(false);
    });
  });
});
