import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
}));

describe("neuralwatt config", () => {
  const originalEnv = process.env;
  const trustedPaths = getTrustedOpencodeConfigPaths();
  const workspacePaths = getWorkspaceOpencodeConfigPaths();
  let fsConfigMocks: Awaited<ReturnType<typeof loadFsConfigMocks>>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    resetProcessEnv(originalEnv, [
      "NEURALWATT_API_KEY",
      "MY_NEURALWATT_KEY",
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

  it("resolves from env:NEURALWATT_API_KEY", async () => {
    process.env.NEURALWATT_API_KEY = "env-key";

    const { resolveNeuralwattApiKey } = await import("../src/lib/neuralwatt-config.js");
    await expect(resolveNeuralwattApiKey()).resolves.toEqual({
      key: "env-key",
      source: "env:NEURALWATT_API_KEY",
    });
  });

  it("resolves from trusted user/global OpenCode config", async () => {
    mockTrustedConfigFile(
      fsConfigMocks,
      trustedPaths.json,
      JSON.stringify({
        provider: {
          neuralwatt: {
            options: {
              apiKey: "config-key",
            },
          },
        },
      }),
    );

    const { resolveNeuralwattApiKey } = await import("../src/lib/neuralwatt-config.js");
    await expect(resolveNeuralwattApiKey()).resolves.toEqual({
      key: "config-key",
      source: "opencode.json",
    });
  });

  it("returns null when a trusted global config env reference is unset", async () => {
    const { readAuthFile } = await import("../src/lib/opencode-auth.js");

    mockTrustedConfigFile(
      fsConfigMocks,
      trustedPaths.json,
      JSON.stringify({
        provider: {
          neuralwatt: {
            options: {
              apiKey: "{env:NEURALWATT_API_KEY}",
            },
          },
        },
      }),
    );
    (readAuthFile as any).mockResolvedValue(null);

    const { resolveNeuralwattApiKey } = await import("../src/lib/neuralwatt-config.js");
    await expect(resolveNeuralwattApiKey()).resolves.toBeNull();
  });

  it("rejects arbitrary {env:VAR_NAME} syntax in trusted global config", async () => {
    process.env.MY_NEURALWATT_KEY = "resolved-from-env";
    const { readAuthFile } = await import("../src/lib/opencode-auth.js");

    mockTrustedConfigFile(
      fsConfigMocks,
      trustedPaths.json,
      JSON.stringify({
        provider: {
          neuralwatt: {
            options: {
              apiKey: "{env:MY_NEURALWATT_KEY}",
            },
          },
        },
      }),
    );
    (readAuthFile as any).mockResolvedValue(null);

    const { resolveNeuralwattApiKey } = await import("../src/lib/neuralwatt-config.js");
    await expect(resolveNeuralwattApiKey()).resolves.toBeNull();
  });

  it.each([
    ["opencode.json", workspacePaths.json],
    ["opencode.jsonc", workspacePaths.jsonc],
  ])("ignores repo-local provider secrets from %s", async (_label, workspacePath) => {
    const { readAuthFile } = await import("../src/lib/opencode-auth.js");

    fsConfigMocks.existsSync.mockImplementation((path: string) => path === workspacePath);
    (readAuthFile as any).mockResolvedValue(null);

    const { resolveNeuralwattApiKey } = await import("../src/lib/neuralwatt-config.js");
    await expect(resolveNeuralwattApiKey()).resolves.toBeNull();
  });

  it("resolves from existing OpenCode auth when env/global config are absent", async () => {
    const { readAuthFile } = await import("../src/lib/opencode-auth.js");

    fsConfigMocks.existsSync.mockReturnValue(false);
    (readAuthFile as any).mockResolvedValueOnce({
      neuralwatt: { type: "api", key: "auth-key" },
    });

    const { resolveNeuralwattApiKey } = await import("../src/lib/neuralwatt-config.js");
    await expect(resolveNeuralwattApiKey()).resolves.toEqual({
      key: "auth-key",
      source: "auth.json",
    });
  });
});
