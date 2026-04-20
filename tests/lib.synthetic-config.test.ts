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

vi.mock("fs", () => ({
  existsSync: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
}));

vi.mock("../src/lib/opencode-auth.js", () => ({
  readAuthFile: vi.fn(),
}));

describe("synthetic-config", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.SYNTHETIC_API_KEY;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_DATA_HOME;
    delete process.env.XDG_CACHE_HOME;
    delete process.env.XDG_STATE_HOME;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("resolveSyntheticApiKey", () => {
    it("returns env var SYNTHETIC_API_KEY when set", async () => {
      process.env.SYNTHETIC_API_KEY = "env-key-1";

      const { resolveSyntheticApiKey } = await import("../src/lib/synthetic-config.js");
      const result = await resolveSyntheticApiKey();

      expect(result).toEqual({
        key: "env-key-1",
        source: "env:SYNTHETIC_API_KEY",
      });
    });

    it("reads from opencode.json when env var not set", async () => {
      const { existsSync } = await import("fs");
      const { readFile } = await import("fs/promises");

      (existsSync as any).mockImplementation((path: string) => path.endsWith("opencode.json"));

      (readFile as any).mockResolvedValue(
        JSON.stringify({
          provider: {
            synthetic: {
              options: {
                apiKey: "json-api-key",
              },
            },
          },
        }),
      );

      const { resolveSyntheticApiKey } = await import("../src/lib/synthetic-config.js");
      const result = await resolveSyntheticApiKey();

      expect(result).toEqual({
        key: "json-api-key",
        source: "opencode.json",
      });
    });

    it("reads from opencode.jsonc with comments stripped", async () => {
      const { existsSync } = await import("fs");
      const { readFile } = await import("fs/promises");

      (existsSync as any).mockImplementation((path: string) => path.endsWith("opencode.jsonc"));

      (readFile as any).mockResolvedValue(`{
        // This is a comment
        "provider": {
          "synthetic": {
            "options": {
              "apiKey": "jsonc-api-key" // inline comment
            }
          }
        }
      }`);

      const { resolveSyntheticApiKey } = await import("../src/lib/synthetic-config.js");
      const result = await resolveSyntheticApiKey();

      expect(result).toEqual({
        key: "jsonc-api-key",
        source: "opencode.jsonc",
      });
    });

    it("rejects arbitrary {env:VAR_NAME} syntax in opencode.json", async () => {
      process.env.MY_SYNTHETIC_KEY = "resolved-from-env";

      const { existsSync } = await import("fs");
      const { readFile } = await import("fs/promises");
      const { readAuthFile } = await import("../src/lib/opencode-auth.js");

      (existsSync as any).mockImplementation(
        (path: string) => path === join(homedir(), ".config", "opencode", "opencode.json"),
      );

      (readFile as any).mockResolvedValue(
        JSON.stringify({
          provider: {
            synthetic: {
              options: {
                apiKey: "{env:MY_SYNTHETIC_KEY}",
              },
            },
          },
        }),
      );
      (readAuthFile as any).mockResolvedValue(null);

      const { resolveSyntheticApiKey } = await import("../src/lib/synthetic-config.js");
      const result = await resolveSyntheticApiKey();

      expect(result).toBeNull();
    });

    it("returns null when {env:VAR_NAME} references unset variable", async () => {
      const { existsSync } = await import("fs");
      const { readFile } = await import("fs/promises");
      const { readAuthFile } = await import("../src/lib/opencode-auth.js");

      (existsSync as any).mockImplementation((path: string) => path.includes("opencode.json"));

      (readFile as any).mockResolvedValue(
        JSON.stringify({
          provider: {
            synthetic: {
              options: {
                apiKey: "{env:SYNTHETIC_API_KEY}",
              },
            },
          },
        }),
      );

      (readAuthFile as any).mockResolvedValue(null);

      const { resolveSyntheticApiKey } = await import("../src/lib/synthetic-config.js");
      const result = await resolveSyntheticApiKey();

      expect(result).toBeNull();
    });

    it("ignores workspace-local opencode.json when resolving provider secrets", async () => {
      const { existsSync } = await import("fs");
      const { readAuthFile } = await import("../src/lib/opencode-auth.js");

      const workspacePath = join(process.cwd(), "opencode.json");

      (existsSync as any).mockImplementation((path: string) => path === workspacePath);
      (readAuthFile as any).mockResolvedValue(null);

      const { resolveSyntheticApiKey } = await import("../src/lib/synthetic-config.js");
      const result = await resolveSyntheticApiKey();

      expect(result).toBeNull();
    });

    it("falls back to auth.json when no other sources configured", async () => {
      const { existsSync } = await import("fs");
      const { readAuthFile } = await import("../src/lib/opencode-auth.js");

      (existsSync as any).mockReturnValue(false);
      (readAuthFile as any).mockResolvedValue({
        synthetic: {
          type: "api",
          key: "auth-json-key",
        },
      });

      const { resolveSyntheticApiKey } = await import("../src/lib/synthetic-config.js");
      const result = await resolveSyntheticApiKey();

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

      const { resolveSyntheticApiKey } = await import("../src/lib/synthetic-config.js");
      const result = await resolveSyntheticApiKey();

      expect(result).toBeNull();
    });

    it("ignores empty string env vars", async () => {
      process.env.SYNTHETIC_API_KEY = "   ";

      const { existsSync } = await import("fs");
      const { readAuthFile } = await import("../src/lib/opencode-auth.js");

      (existsSync as any).mockReturnValue(false);
      (readAuthFile as any).mockResolvedValue({
        synthetic: {
          type: "api",
          key: "auth-key",
        },
      });

      const { resolveSyntheticApiKey } = await import("../src/lib/synthetic-config.js");
      const result = await resolveSyntheticApiKey();

      expect(result).toEqual({
        key: "auth-key",
        source: "auth.json",
      });
    });
  });

  describe("hasSyntheticApiKey", () => {
    it("returns true when key is configured", async () => {
      process.env.SYNTHETIC_API_KEY = "test-key";

      const { hasSyntheticApiKey } = await import("../src/lib/synthetic-config.js");
      const result = await hasSyntheticApiKey();

      expect(result).toBe(true);
    });

    it("returns false when no key is configured", async () => {
      const { existsSync } = await import("fs");
      const { readAuthFile } = await import("../src/lib/opencode-auth.js");

      (existsSync as any).mockReturnValue(false);
      (readAuthFile as any).mockResolvedValue(null);

      const { hasSyntheticApiKey } = await import("../src/lib/synthetic-config.js");
      const result = await hasSyntheticApiKey();

      expect(result).toBe(false);
    });
  });

  describe("getSyntheticKeyDiagnostics", () => {
    it("returns diagnostics with source when configured", async () => {
      process.env.SYNTHETIC_API_KEY = "diag-key";

      const { getSyntheticKeyDiagnostics } = await import("../src/lib/synthetic-config.js");
      const result = await getSyntheticKeyDiagnostics();

      expect(result.configured).toBe(true);
      expect(result.source).toBe("env:SYNTHETIC_API_KEY");
      expect(result.checkedPaths).toContain("env:SYNTHETIC_API_KEY");
    });

    it("returns diagnostics with checked paths", async () => {
      const { existsSync } = await import("fs");
      const { readAuthFile } = await import("../src/lib/opencode-auth.js");

      const expectedPath = join(homedir(), ".config", "opencode", "opencode.json");

      (existsSync as any).mockImplementation((path: string) => path === expectedPath);
      (readAuthFile as any).mockResolvedValue(null);

      const { getSyntheticKeyDiagnostics } = await import("../src/lib/synthetic-config.js");
      const result = await getSyntheticKeyDiagnostics();

      expect(result.configured).toBe(false);
      expect(result.checkedPaths).toContain(expectedPath);
    });
  });

  describe("getOpencodeConfigCandidatePaths", () => {
    it("returns trusted global paths only", async () => {
      const { getOpencodeConfigCandidatePaths } = await import("../src/lib/synthetic-config.js");
      const paths = getOpencodeConfigCandidatePaths();

      expect(paths.length).toBe(2);
      expect(paths[0].isJsonc).toBe(true);
      expect(paths[1].isJsonc).toBe(false);

      expect(paths[0].path).toContain("opencode");
      expect(paths[1].path).toContain("opencode");
    });
  });
});
