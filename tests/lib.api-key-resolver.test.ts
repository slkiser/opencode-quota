import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { homedir } from "os";
import { join } from "path";

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

import {
  extractAuthApiKeyEntry,
  getApiKeyCheckedPaths,
  resolveApiKey,
  resolveApiKeyFromEnvAndConfig,
} from "../src/lib/api-key-resolver.js";

describe("api-key-resolver", () => {
  const workspaceJsonPath = join(process.cwd(), "opencode.json");
  const trustedJsonPath = join(homedir(), ".config", "opencode", "opencode.json");

  beforeEach(async () => {
    vi.clearAllMocks();

    const { existsSync } = await import("fs");
    const { readFile } = await import("fs/promises");
    (existsSync as any).mockReset().mockReturnValue(false);
    (readFile as any).mockReset();
  });

  afterEach(() => {
    delete process.env.TEST_PROVIDER_KEY;
    vi.restoreAllMocks();
  });

  it("keeps environment first, trusted JSONC before JSON, and auth.json last", async () => {
    const { existsSync } = await import("fs");
    const { readFile } = await import("fs/promises");
    const trustedJsoncPath = join(homedir(), ".config", "opencode", "opencode.jsonc");
    const readAuth = vi.fn().mockResolvedValue({ apiKey: "auth-key" });
    const config = {
      envVars: [{ name: "TEST_PROVIDER_KEY", source: "env" as const }],
      extractFromConfig: (value: unknown) =>
        typeof (value as { apiKey?: unknown }).apiKey === "string"
          ? (value as { apiKey: string }).apiKey
          : null,
      extractFromAuth: (value: unknown) =>
        typeof (value as { apiKey?: unknown })?.apiKey === "string"
          ? (value as { apiKey: string }).apiKey
          : null,
      configJsonSource: "opencode.json" as const,
      configJsoncSource: "opencode.jsonc" as const,
      authSource: "auth.json" as const,
    };

    process.env.TEST_PROVIDER_KEY = "env-key";
    await expect(resolveApiKey(config, readAuth)).resolves.toEqual({
      key: "env-key",
      source: "env",
    });
    expect(readFile).not.toHaveBeenCalled();
    expect(readAuth).not.toHaveBeenCalled();

    delete process.env.TEST_PROVIDER_KEY;
    (existsSync as any).mockImplementation(
      (path: string) => path === trustedJsoncPath || path === trustedJsonPath,
    );
    (readFile as any).mockImplementation(async (path: string) =>
      path === trustedJsoncPath
        ? '{ // preferred\n "apiKey": "jsonc-key",\n}'
        : JSON.stringify({ apiKey: "json-key" }),
    );
    await expect(resolveApiKey(config, readAuth)).resolves.toEqual({
      key: "jsonc-key",
      source: "opencode.jsonc",
    });
    expect((readFile as any).mock.calls.map((call: unknown[]) => call[0])).toEqual([
      trustedJsoncPath,
    ]);
    expect(readAuth).not.toHaveBeenCalled();

    (existsSync as any).mockReturnValue(false);
    (readFile as any).mockReset();
    await expect(resolveApiKey(config, readAuth)).resolves.toEqual({
      key: "auth-key",
      source: "auth.json",
    });
    expect(readAuth).toHaveBeenCalledOnce();
  });

  it("defaults secret-bearing config resolution to trusted global paths only", async () => {
    const { existsSync } = await import("fs");
    const { readFile } = await import("fs/promises");

    (existsSync as any).mockImplementation(
      (path: string) => path === workspaceJsonPath || path === trustedJsonPath,
    );
    (readFile as any).mockImplementation(async (path: string) => {
      if (path === workspaceJsonPath) {
        return JSON.stringify({ apiKey: "workspace-key" });
      }
      if (path === trustedJsonPath) {
        return JSON.stringify({ apiKey: "trusted-key" });
      }
      throw new Error(`Unexpected read: ${path}`);
    });

    await expect(
      resolveApiKeyFromEnvAndConfig({
        envVars: [],
        extractFromConfig: (config) =>
          typeof (config as { apiKey?: unknown }).apiKey === "string"
            ? ((config as { apiKey: string }).apiKey as string)
            : null,
        configJsonSource: "opencode.json",
        configJsoncSource: "opencode.jsonc",
      }),
    ).resolves.toEqual({
      key: "trusted-key",
      source: "opencode.json",
    });

    expect((readFile as any).mock.calls.map((call: unknown[]) => call[0])).toEqual([
      trustedJsonPath,
    ]);
  });

  it("defaults checked-path diagnostics to trusted global paths only", async () => {
    const { existsSync } = await import("fs");

    (existsSync as any).mockImplementation(
      (path: string) => path === workspaceJsonPath || path === trustedJsonPath,
    );

    expect(
      getApiKeyCheckedPaths({
        envVarNames: [],
      }),
    ).toEqual([trustedJsonPath]);
  });

  it("extracts only strict api key auth entries", () => {
    expect(
      extractAuthApiKeyEntry(
        {
          provider: { type: "api", key: " auth-key " },
        },
        ["provider"],
      ),
    ).toBe("auth-key");

    expect(
      extractAuthApiKeyEntry(
        {
          provider: { type: "api", access: "access-token" },
        },
        ["provider"],
      ),
    ).toBeNull();

    expect(
      extractAuthApiKeyEntry(
        {
          provider: { type: "oauth", key: "auth-key" },
        },
        ["provider"],
      ),
    ).toBeNull();
  });
});
