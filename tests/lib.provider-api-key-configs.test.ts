import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProviderApiKeyContractDescriptor,
  SimpleApiKeyContractModule,
} from "./helpers/provider-api-key-contract.js";
import {
  authWithEntry,
  configWithApiKey,
  expectedTrustedConfigCandidates,
  resetContractEnv,
} from "./helpers/provider-api-key-contract.js";
import {
  createRuntimePathsMockModule,
  getTrustedOpencodeConfigPaths,
  getWorkspaceOpencodeConfigPaths,
  loadFsConfigMocks,
  mockExistingConfigPath,
  mockTrustedConfigFile,
  resetFsConfigMocks,
} from "./helpers/trusted-config-test-harness.js";

const authMocks = vi.hoisted(() => ({
  readAuthFile: vi.fn(),
}));

vi.mock("../src/lib/opencode-runtime-paths.js", () => createRuntimePathsMockModule());
vi.mock("fs", () => ({ existsSync: vi.fn() }));
vi.mock("fs/promises", () => ({ readFile: vi.fn() }));
vi.mock("../src/lib/opencode-auth.js", () => ({
  getCredentialDatabasePaths: () => ["/tmp/opencode.db"],
  readAuthFile: authMocks.readAuthFile,
}));

const providers = [
  {
    name: "Chutes",
    envVars: ["CHUTES_API_KEY"],
    providerKeys: ["chutes"],
    authKeys: ["chutes"],
    load: async () => {
      const module = await import("../src/lib/chutes-config.js");
      return {
        resolve: module.resolveChutesApiKey,
        has: module.hasChutesApiKey,
        diagnostics: module.getChutesKeyDiagnostics,
        getConfigCandidates: module.getOpencodeConfigCandidatePaths,
      };
    },
  },
  {
    name: "Synthetic",
    envVars: ["SYNTHETIC_API_KEY"],
    providerKeys: ["synthetic"],
    authKeys: ["synthetic"],
    load: async () => {
      const module = await import("../src/lib/synthetic-config.js");
      return {
        resolve: module.resolveSyntheticApiKey,
        has: module.hasSyntheticApiKey,
        diagnostics: module.getSyntheticKeyDiagnostics,
        getConfigCandidates: module.getOpencodeConfigCandidatePaths,
      };
    },
  },
  {
    name: "NanoGPT",
    envVars: ["NANOGPT_API_KEY", "NANO_GPT_API_KEY"],
    providerKeys: ["nanogpt", "nano-gpt"],
    authKeys: ["nanogpt", "nano-gpt"],
    load: async () => {
      const module = await import("../src/lib/nanogpt-config.js");
      return {
        resolve: module.resolveNanoGptApiKey,
        has: module.hasNanoGptApiKey,
        diagnostics: module.getNanoGptKeyDiagnostics,
        getConfigCandidates: module.getOpencodeConfigCandidatePaths,
      };
    },
  },
  {
    name: "Ollama Cloud",
    envVars: ["OLLAMA_API_KEY"],
    providerKeys: ["ollama-cloud"],
    authKeys: ["ollama-cloud"],
    load: async () => {
      const module = await import("../src/lib/ollama-cloud-config.js");
      return {
        resolve: module.resolveOllamaCloudApiKey,
        has: module.hasOllamaCloudApiKey,
        diagnostics: module.getOllamaCloudKeyDiagnostics,
        getConfigCandidates: module.getOpencodeConfigCandidatePaths,
      };
    },
  },
  {
    name: "Kilo Gateway",
    envVars: ["KILO_API_KEY"],
    providerKeys: ["kilo"],
    authKeys: ["kilo"],
    load: async () => {
      const module = await import("../src/lib/kilo-config.js");
      return {
        resolve: module.resolveKiloApiKey,
        has: module.hasKiloApiKey,
        diagnostics: module.getKiloKeyDiagnostics,
        getConfigCandidates: module.getOpencodeConfigCandidatePaths,
      };
    },
  },
  {
    name: "DeepSeek",
    envVars: ["DEEPSEEK_API_KEY"],
    providerKeys: ["deepseek"],
    authKeys: ["deepseek"],
    load: async () => {
      const module = await import("../src/lib/deepseek-auth.js");
      return {
        resolve: module.resolveDeepSeekApiKey,
        has: module.hasDeepSeekApiKey,
        diagnostics: module.getDeepSeekKeyDiagnostics,
        getConfigCandidates: module.getOpencodeConfigCandidatePaths,
      };
    },
  },
] satisfies Array<ProviderApiKeyContractDescriptor<SimpleApiKeyContractModule>>;

describe("simple provider API key configs", () => {
  const originalEnv = process.env;
  const trustedPaths = getTrustedOpencodeConfigPaths();
  const workspacePaths = getWorkspaceOpencodeConfigPaths();
  let fsMocks: Awaited<ReturnType<typeof loadFsConfigMocks>>;

  function resetFixture(): void {
    resetContractEnv(originalEnv, providers);
    resetFsConfigMocks(fsMocks);
    authMocks.readAuthFile.mockReset().mockResolvedValue(null);
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    fsMocks = await loadFsConfigMocks();
    resetFixture();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("preserves public environment, has, and diagnostics behavior", async () => {
    for (const provider of providers) {
      resetFixture();
      process.env[provider.envVars[0]] = "contract-key";
      const module = await provider.load();

      await expect(module.resolve(), provider.name).resolves.toEqual({
        key: "contract-key",
        source: `env:${provider.envVars[0]}`,
      });
      await expect(module.has(), provider.name).resolves.toBe(true);
      await expect(module.diagnostics(), provider.name).resolves.toEqual({
        configured: true,
        source: `env:${provider.envVars[0]}`,
        checkedPaths: [`env:${provider.envVars[0]}`],
        credentialDatabasePaths: ["/tmp/opencode.db"],
      });
    }
  });

  it("reads trusted JSON and JSONC provider aliases", async () => {
    for (const provider of providers) {
      const module = await provider.load();
      for (const [path, source, providerKey] of [
        [trustedPaths.json, "opencode.json", provider.providerKeys[0]],
        [trustedPaths.jsonc, "opencode.jsonc", provider.providerKeys.at(-1)!],
      ] as const) {
        resetFixture();
        mockTrustedConfigFile(fsMocks, path, configWithApiKey(providerKey, "contract-key"));
        await expect(module.resolve(), `${provider.name} ${source}`).resolves.toEqual({
          key: "contract-key",
          source,
        });
      }
    }
  });

  it("keeps environment before config before strict opencode.db", async () => {
    for (const provider of providers) {
      const module = await provider.load();

      resetFixture();
      process.env[provider.envVars[0]] = "env-key";
      mockTrustedConfigFile(
        fsMocks,
        trustedPaths.json,
        configWithApiKey(provider.providerKeys[0], "config-key"),
      );
      authMocks.readAuthFile.mockResolvedValue(
        authWithEntry(provider.authKeys[0], { type: "api", key: "auth-key" }),
      );
      await expect(module.resolve(), provider.name).resolves.toEqual({
        key: "env-key",
        source: `env:${provider.envVars[0]}`,
      });
      expect(authMocks.readAuthFile, provider.name).not.toHaveBeenCalled();

      resetFixture();
      mockTrustedConfigFile(
        fsMocks,
        trustedPaths.json,
        configWithApiKey(provider.providerKeys[0], "config-key"),
      );
      authMocks.readAuthFile.mockResolvedValue(
        authWithEntry(provider.authKeys[0], { type: "api", key: "auth-key" }),
      );
      await expect(module.resolve(), provider.name).resolves.toEqual({
        key: "config-key",
        source: "opencode.json",
      });
      expect(authMocks.readAuthFile, provider.name).not.toHaveBeenCalled();

      resetFixture();
      authMocks.readAuthFile.mockResolvedValue(
        authWithEntry(provider.authKeys[0], { type: "api", key: " auth-key " }),
      );
      await expect(module.resolve(), provider.name).resolves.toEqual({
        key: "auth-key",
        source: "opencode.db",
      });

      authMocks.readAuthFile.mockResolvedValue(
        authWithEntry(provider.authKeys[0], { type: "oauth", key: "oauth-key" }),
      );
      await expect(module.resolve(), `${provider.name} malformed auth`).resolves.toBeNull();
    }
  });

  it("rejects unapproved config env templates and workspace secrets", async () => {
    for (const provider of providers) {
      const module = await provider.load();

      resetFixture();
      process.env.NOT_ALLOWED = "workspace-secret";
      mockTrustedConfigFile(
        fsMocks,
        trustedPaths.json,
        configWithApiKey(provider.providerKeys[0], "{env:NOT_ALLOWED}"),
      );
      await expect(module.resolve(), `${provider.name} env template`).resolves.toBeNull();

      for (const workspacePath of [workspacePaths.json, workspacePaths.jsonc]) {
        resetFixture();
        mockExistingConfigPath(fsMocks, workspacePath);
        await expect(module.resolve(), `${provider.name} workspace`).resolves.toBeNull();
      }
    }
  });

  it("reports only trusted checked config and auth paths", async () => {
    for (const provider of providers) {
      resetFixture();
      mockTrustedConfigFile(fsMocks, trustedPaths.json, "{}");
      const module = await provider.load();
      await expect(module.diagnostics(), provider.name).resolves.toEqual({
        configured: false,
        source: null,
        checkedPaths: [trustedPaths.json],
        credentialDatabasePaths: ["/tmp/opencode.db"],
      });
      expect(module.getConfigCandidates(), provider.name).toEqual(
        expectedTrustedConfigCandidates(),
      );
    }
  });

  it("preserves NanoGPT environment and auth alias order", async () => {
    const provider = providers.find((candidate) => candidate.name === "NanoGPT")!;
    const module = await provider.load();

    resetFixture();
    process.env.NANOGPT_API_KEY = "first-key";
    process.env.NANO_GPT_API_KEY = "second-key";
    await expect(module.resolve()).resolves.toEqual({
      key: "first-key",
      source: "env:NANOGPT_API_KEY",
    });

    resetFixture();
    process.env.NANO_GPT_API_KEY = "second-key";
    await expect(module.resolve()).resolves.toEqual({
      key: "second-key",
      source: "env:NANO_GPT_API_KEY",
    });

    resetFixture();
    authMocks.readAuthFile.mockResolvedValue(
      authWithEntry("nano-gpt", { type: "api", key: "alias-key" }),
    );
    await expect(module.resolve()).resolves.toEqual({
      key: "alias-key",
      source: "opencode.db",
    });
  });
});
