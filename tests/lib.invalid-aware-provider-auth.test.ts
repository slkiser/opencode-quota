import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  InvalidAwareApiKeyContractModule,
  ProviderApiKeyContractDescriptor,
} from "./helpers/provider-api-key-contract.js";
import {
  authWithEntry,
  configWithProviders,
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
  getCredentialDatabasePaths: vi.fn(() => ["/tmp/opencode.db"]),
  readAuthFileCached: vi.fn(),
}));

vi.mock("../src/lib/opencode-runtime-paths.js", () => createRuntimePathsMockModule());
vi.mock("fs", () => ({ existsSync: vi.fn() }));
vi.mock("fs/promises", () => ({ readFile: vi.fn() }));
vi.mock("../src/lib/opencode-auth.js", () => ({
  getCredentialDatabasePaths: authMocks.getCredentialDatabasePaths,
  readAuthFileCached: authMocks.readAuthFileCached,
}));

type InvalidAwareDescriptor = ProviderApiKeyContractDescriptor<InvalidAwareApiKeyContractModule> & {
  displayName: string;
  defaultCacheMaxAgeMs: number;
};

const providers = [
  {
    name: "Kimi",
    displayName: "Kimi",
    envVars: ["KIMI_API_KEY", "KIMI_CODE_API_KEY"],
    providerKeys: ["kimi-for-coding", "kimi-code", "kimi"],
    authKeys: ["kimi-for-coding", "kimi-code", "kimi"],
    defaultCacheMaxAgeMs: 5_000,
    load: async () => {
      const module = await import("../src/lib/kimi-auth.js");
      return {
        parseAuth: module.resolveKimiAuth,
        resolve: module.resolveKimiAuthCached,
        diagnostics: module.getKimiAuthDiagnostics,
        getConfigCandidates: module.getOpencodeConfigCandidatePaths,
      };
    },
  },
  {
    name: "Z.ai",
    displayName: "Z.ai",
    envVars: ["ZAI_API_KEY", "ZAI_CODING_PLAN_API_KEY"],
    providerKeys: ["zai", "zai-coding-plan", "glm"],
    authKeys: ["zai-coding-plan"],
    defaultCacheMaxAgeMs: 5_000,
    load: async () => {
      const module = await import("../src/lib/zai-auth.js");
      return {
        parseAuth: module.resolveZaiAuth,
        resolve: module.resolveZaiAuthCached,
        diagnostics: module.getZaiAuthDiagnostics,
        getConfigCandidates: module.getOpencodeConfigCandidatePaths,
      };
    },
  },
  {
    name: "Zhipu",
    displayName: "Zhipu",
    envVars: ["ZHIPU_API_KEY", "ZHIPU_CODING_PLAN_API_KEY"],
    providerKeys: ["zhipu", "zhipu-coding-plan", "zhipuai-coding-plan", "glm-coding-plan"],
    authKeys: ["zhipu-coding-plan", "zhipuai-coding-plan"],
    defaultCacheMaxAgeMs: 5_000,
    load: async () => {
      const module = await import("../src/lib/zhipu-auth.js");
      return {
        parseAuth: module.resolveZhipuAuth,
        resolve: module.resolveZhipuAuthCached,
        diagnostics: module.getZhipuAuthDiagnostics,
        getConfigCandidates: module.getOpencodeConfigCandidatePaths,
      };
    },
  },
] satisfies InvalidAwareDescriptor[];

describe("invalid-aware provider auth", () => {
  const originalEnv = process.env;
  const trustedPaths = getTrustedOpencodeConfigPaths();
  const workspacePaths = getWorkspaceOpencodeConfigPaths();
  let fsMocks: Awaited<ReturnType<typeof loadFsConfigMocks>>;

  function resetFixture(): void {
    resetContractEnv(originalEnv, providers);
    resetFsConfigMocks(fsMocks);
    authMocks.getCredentialDatabasePaths.mockReset().mockReturnValue(["/tmp/opencode.db"]);
    authMocks.readAuthFileCached.mockReset().mockResolvedValue(null);
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    fsMocks = await loadFsConfigMocks();
    resetFixture();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("parses missing, malformed, unsupported, empty, and configured auth exactly", async () => {
    for (const provider of providers) {
      const module = await provider.load();
      const withEntry = (entry: unknown) => authWithEntry(provider.authKeys[0], entry);

      expect(module.parseAuth(null), `${provider.name} null`).toEqual({ state: "none" });
      expect(module.parseAuth({}), `${provider.name} missing`).toEqual({ state: "none" });
      expect(module.parseAuth(withEntry("bad-shape")), `${provider.name} shape`).toEqual({
        state: "invalid",
        error: `${provider.displayName} auth entry has invalid shape`,
      });
      expect(
        module.parseAuth(withEntry({ type: { bad: true }, key: "key" })),
        `${provider.name} type`,
      ).toEqual({
        state: "invalid",
        error: `${provider.displayName} auth entry present but type is missing or invalid`,
      });
      expect(
        module.parseAuth(withEntry({ type: "oauth", key: "key" })),
        `${provider.name} unsupported`,
      ).toEqual({
        state: "invalid",
        error: `Unsupported ${provider.displayName} auth type: "oauth"`,
      });
      expect(
        module.parseAuth(withEntry({ type: "api", key: " " })),
        `${provider.name} empty`,
      ).toEqual({
        state: "invalid",
        error: `${provider.displayName} auth entry present but key is empty`,
      });
      expect(
        module.parseAuth(withEntry({ type: "api", key: " contract-key " })),
        `${provider.name} configured`,
      ).toEqual({ state: "configured", apiKey: "contract-key" });
    }
  });

  it("sanitizes, bounds, and supplies a fallback for unsupported auth types", async () => {
    for (const provider of providers) {
      const module = await provider.load();
      const authKey = provider.authKeys[0];

      expect(
        module.parseAuth(authWithEntry(authKey, { type: "\u001b[31moauth\nretry\u001b[0m" })),
        provider.name,
      ).toEqual({
        state: "invalid",
        error: `Unsupported ${provider.displayName} auth type: "oauth retry"`,
      });
      expect(
        module.parseAuth(authWithEntry(authKey, { type: "\u001b[31m" })),
        `${provider.name} fallback`,
      ).toEqual({
        state: "invalid",
        error: `Unsupported ${provider.displayName} auth type: "unknown"`,
      });
      expect(
        module.parseAuth(authWithEntry(authKey, { type: "x".repeat(130) })),
        `${provider.name} bound`,
      ).toEqual({
        state: "invalid",
        error: `Unsupported ${provider.displayName} auth type: "${"x".repeat(120)}"`,
      });
    }
  });

  it("preserves auth aliases and first-present alias behavior", async () => {
    for (const provider of providers) {
      const module = await provider.load();
      for (const authKey of provider.authKeys) {
        expect(
          module.parseAuth(authWithEntry(authKey, { type: "api", key: `${authKey}-key` })),
          `${provider.name} ${authKey}`,
        ).toEqual({ state: "configured", apiKey: `${authKey}-key` });
      }

      if (provider.authKeys.length > 1) {
        expect(
          module.parseAuth({
            [provider.authKeys[0]]: { type: "oauth", key: "ignored" },
            [provider.authKeys[1]]: { type: "api", key: "later-key" },
          }),
          `${provider.name} first present`,
        ).toEqual({
          state: "invalid",
          error: `Unsupported ${provider.displayName} auth type: "oauth"`,
        });
      }
    }
  });

  it("keeps environment order and prevents lower-priority auth reads", async () => {
    for (const provider of providers) {
      const module = await provider.load();
      resetFixture();
      process.env[provider.envVars[0]] = "first-key";
      process.env[provider.envVars[1]] = "second-key";
      authMocks.readAuthFileCached.mockResolvedValue(
        authWithEntry(provider.authKeys[0], { type: "oauth" }),
      );

      await expect(module.resolve(), provider.name).resolves.toEqual({
        state: "configured",
        apiKey: "first-key",
      });
      expect(authMocks.readAuthFileCached, provider.name).not.toHaveBeenCalled();

      resetFixture();
      process.env[provider.envVars[1]] = "second-key";
      await expect(module.resolve(), `${provider.name} second env`).resolves.toEqual({
        state: "configured",
        apiKey: "second-key",
      });
    }
  });

  it("uses trusted provider aliases in order and never workspace config", async () => {
    for (const provider of providers) {
      const module = await provider.load();
      resetFixture();
      mockTrustedConfigFile(
        fsMocks,
        trustedPaths.jsonc,
        configWithProviders({
          [provider.providerKeys[0]]: { options: { apiKey: "{env:NOT_ALLOWED}" } },
          [provider.providerKeys.at(-1)!]: { options: { apiKey: "alias-key" } },
        }),
      );
      await expect(module.resolve(), provider.name).resolves.toEqual({
        state: "configured",
        apiKey: "alias-key",
      });
      expect(authMocks.readAuthFileCached, provider.name).not.toHaveBeenCalled();

      for (const workspacePath of [workspacePaths.json, workspacePaths.jsonc]) {
        resetFixture();
        mockExistingConfigPath(fsMocks, workspacePath);
        await expect(module.resolve(), `${provider.name} workspace`).resolves.toEqual({
          state: "none",
        });
      }
    }
  });

  it("preserves strict auth fallback, invalid state, and cache age calls", async () => {
    for (const provider of providers) {
      const module = await provider.load();
      resetFixture();
      authMocks.readAuthFileCached.mockResolvedValue(
        authWithEntry(provider.authKeys[0], { type: "api", key: "auth-key" }),
      );
      await expect(module.resolve(), provider.name).resolves.toEqual({
        state: "configured",
        apiKey: "auth-key",
      });
      expect(authMocks.readAuthFileCached, provider.name).toHaveBeenLastCalledWith({
        maxAgeMs: provider.defaultCacheMaxAgeMs,
      });

      authMocks.readAuthFileCached.mockResolvedValue(
        authWithEntry(provider.authKeys[0], { type: "oauth" }),
      );
      await expect(module.resolve(), `${provider.name} invalid`).resolves.toEqual({
        state: "invalid",
        error: `Unsupported ${provider.displayName} auth type: "oauth"`,
      });

      await module.resolve({ maxAgeMs: -1 });
      expect(authMocks.readAuthFileCached, `${provider.name} clamp`).toHaveBeenLastCalledWith({
        maxAgeMs: 0,
      });
    }
  });

  it("reports configured, invalid, and absent diagnostics without secrets", async () => {
    for (const provider of providers) {
      const module = await provider.load();
      resetFixture();
      process.env[provider.envVars[1]] = "diag-key";
      await expect(module.diagnostics(), provider.name).resolves.toEqual({
        state: "configured",
        source: `env:${provider.envVars[1]}`,
        checkedPaths: [`env:${provider.envVars[1]}`],
        credentialDatabasePaths: ["/tmp/opencode.db"],
      });

      resetFixture();
      authMocks.readAuthFileCached.mockResolvedValue(
        authWithEntry(provider.authKeys[0], { type: "oauth" }),
      );
      const invalid = await module.diagnostics();
      expect(invalid, `${provider.name} invalid`).toEqual({
        state: "invalid",
        source: "opencode.db",
        checkedPaths: [],
        credentialDatabasePaths: ["/tmp/opencode.db"],
        error: `Unsupported ${provider.displayName} auth type: "oauth"`,
      });
      expect(JSON.stringify(invalid), `${provider.name} secret-free`).not.toContain("diag-key");

      resetFixture();
      await expect(module.diagnostics(), `${provider.name} absent`).resolves.toEqual({
        state: "none",
        source: null,
        checkedPaths: [],
        credentialDatabasePaths: ["/tmp/opencode.db"],
      });
      expect(module.getConfigCandidates(), provider.name).toEqual(
        expectedTrustedConfigCandidates(),
      );
    }
  });
});
