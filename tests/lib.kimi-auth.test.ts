import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createRuntimePathsMockModule,
  getTrustedOpencodeConfigPaths,
  getWorkspaceOpencodeConfigPaths,
  loadFsConfigMocks,
  mockTrustedConfigFile,
  resetFsConfigMocks,
  resetProcessEnv,
} from "./helpers/trusted-config-test-harness.js";

const mocks = vi.hoisted(() => ({
  getAuthPaths: vi.fn(() => ["/tmp/auth.json"]),
  readAuthFileCached: vi.fn(),
}));

vi.mock("../src/lib/opencode-runtime-paths.js", () => createRuntimePathsMockModule());
vi.mock("fs", () => ({ existsSync: vi.fn() }));
vi.mock("fs/promises", () => ({ readFile: vi.fn() }));
vi.mock("../src/lib/opencode-auth.js", () => ({
  getAuthPaths: mocks.getAuthPaths,
  readAuthFileCached: mocks.readAuthFileCached,
}));

import {
  DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS,
  getKimiCnAuthDiagnostics,
  getKimiGlobalAuthDiagnostics,
  getOpencodeConfigCandidatePaths,
  resolveKimiCnAuth,
  resolveKimiCnAuthCached,
  resolveKimiCnAuthWithDiagnosticsCached,
  resolveKimiGlobalAuth,
  resolveKimiGlobalAuthCached,
  resolveKimiGlobalAuthWithDiagnosticsCached,
} from "../src/lib/kimi-auth.js";

const kimiEnvKeys = ["KIMI_GLOBAL_API_KEY", "KIMI_CN_API_KEY", "KIMI_API_KEY", "KIMI_CODE_API_KEY"];

function apiEntry(key: string) {
  return { type: "api", key };
}

describe("Kimi regional auth resolution", () => {
  const originalEnv = process.env;
  const trustedPaths = getTrustedOpencodeConfigPaths();
  const workspacePaths = getWorkspaceOpencodeConfigPaths();
  let fsConfigMocks: Awaited<ReturnType<typeof loadFsConfigMocks>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetProcessEnv(originalEnv, kimiEnvKeys);
    mocks.getAuthPaths.mockReset().mockReturnValue(["/tmp/auth.json"]);
    mocks.readAuthFileCached.mockReset().mockResolvedValue(null);
    fsConfigMocks = await loadFsConfigMocks();
    resetFsConfigMocks(fsConfigMocks);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("binds strict auth.json entries to their own regional endpoint", () => {
    expect(resolveKimiGlobalAuth({ "kimi-code-plan-global": apiEntry("global-key") })).toEqual({
      state: "configured",
      apiKey: "global-key",
      endpoint: "global",
    });
    expect(resolveKimiCnAuth({ "kimi-code-plan-cn": apiEntry("cn-key") })).toEqual({
      state: "configured",
      apiKey: "cn-key",
      endpoint: "cn",
    });
  });

  it("keeps legacy auth.json aliases CN-only", () => {
    const auth = {
      "kimi-for-coding": apiEntry("legacy-key"),
      "kimi-code": apiEntry("second-key"),
      kimi: apiEntry("third-key"),
    };

    expect(resolveKimiGlobalAuth(auth)).toEqual({ state: "none" });
    expect(resolveKimiCnAuth(auth)).toEqual({
      state: "configured",
      apiKey: "legacy-key",
      endpoint: "cn",
    });
  });

  it("uses only KIMI_GLOBAL_API_KEY for Global", async () => {
    process.env.KIMI_CN_API_KEY = "cn-key";
    process.env.KIMI_API_KEY = "legacy-key";
    process.env.KIMI_CODE_API_KEY = "legacy-code-key";

    await expect(resolveKimiGlobalAuthCached()).resolves.toEqual({ state: "none" });

    process.env.KIMI_GLOBAL_API_KEY = "global-key";
    await expect(resolveKimiGlobalAuthCached()).resolves.toEqual({
      state: "configured",
      apiKey: "global-key",
      endpoint: "global",
    });
  });

  it("uses CN env precedence before legacy env vars", async () => {
    process.env.KIMI_CN_API_KEY = "cn-key";
    process.env.KIMI_API_KEY = "legacy-key";
    process.env.KIMI_CODE_API_KEY = "legacy-code-key";

    await expect(resolveKimiCnAuthCached()).resolves.toEqual({
      state: "configured",
      apiKey: "cn-key",
      endpoint: "cn",
    });

    delete process.env.KIMI_CN_API_KEY;
    await expect(resolveKimiCnAuthCached()).resolves.toEqual({
      state: "configured",
      apiKey: "legacy-key",
      endpoint: "cn",
    });

    delete process.env.KIMI_API_KEY;
    await expect(resolveKimiCnAuthCached()).resolves.toEqual({
      state: "configured",
      apiKey: "legacy-code-key",
      endpoint: "cn",
    });
  });

  it("never exposes the Global env key to CN", async () => {
    process.env.KIMI_GLOBAL_API_KEY = "global-only-secret";
    await expect(resolveKimiCnAuthCached()).resolves.toEqual({ state: "none" });
  });

  it("keeps trusted config keys isolated by region", async () => {
    mockTrustedConfigFile(
      fsConfigMocks,
      trustedPaths.json,
      JSON.stringify({
        provider: {
          "kimi-code-plan-global": { options: { apiKey: "global-config-key" } },
          "kimi-code-plan-cn": { options: { apiKey: "cn-config-key" } },
        },
      }),
    );

    await expect(resolveKimiGlobalAuthCached()).resolves.toMatchObject({
      state: "configured",
      apiKey: "global-config-key",
      endpoint: "global",
    });
    await expect(resolveKimiCnAuthCached()).resolves.toMatchObject({
      state: "configured",
      apiKey: "cn-config-key",
      endpoint: "cn",
    });
  });

  it("does not let Global consume CN or legacy trusted config aliases", async () => {
    mockTrustedConfigFile(
      fsConfigMocks,
      trustedPaths.json,
      JSON.stringify({ provider: { kimi: { options: { apiKey: "cn-secret" } } } }),
    );

    await expect(resolveKimiGlobalAuthCached()).resolves.toEqual({ state: "none" });
    await expect(resolveKimiCnAuthCached()).resolves.toMatchObject({
      state: "configured",
      apiKey: "cn-secret",
      endpoint: "cn",
    });
  });

  it("does not let CN consume Global trusted config or auth.json", async () => {
    mockTrustedConfigFile(
      fsConfigMocks,
      trustedPaths.json,
      JSON.stringify({
        provider: { "kimi-code-plan-global": { options: { apiKey: "global-config-key" } } },
      }),
    );
    mocks.readAuthFileCached.mockResolvedValue({
      "kimi-code-plan-global": apiEntry("global-auth-key"),
    });

    await expect(resolveKimiCnAuthCached()).resolves.toEqual({ state: "none" });
  });

  it("prefers trusted opencode.jsonc over opencode.json", async () => {
    fsConfigMocks.existsSync.mockImplementation(
      (path: string) => path === trustedPaths.jsonc || path === trustedPaths.json,
    );
    fsConfigMocks.readFile.mockImplementation(async (path: string) =>
      path === trustedPaths.jsonc
        ? '// preferred JSONC\n{"provider":{"kimi-code-plan-global":{"options":{"apiKey":"jsonc-key"}}}}'
        : JSON.stringify({
            provider: { "kimi-code-plan-global": { options: { apiKey: "json-key" } } },
          }),
    );

    await expect(resolveKimiGlobalAuthCached()).resolves.toMatchObject({
      state: "configured",
      apiKey: "jsonc-key",
      endpoint: "global",
    });
  });

  it.each([
    ["opencode.json", workspacePaths.json],
    ["opencode.jsonc", workspacePaths.jsonc],
  ])("ignores workspace-local %s secrets", async (_label, workspacePath) => {
    fsConfigMocks.existsSync.mockImplementation((path: string) => path === workspacePath);

    await expect(resolveKimiGlobalAuthCached()).resolves.toEqual({ state: "none" });
    await expect(resolveKimiCnAuthCached()).resolves.toEqual({ state: "none" });
  });

  it("keeps malformed auth region-local and sanitizes the error", async () => {
    mocks.readAuthFileCached.mockResolvedValue({
      "kimi-code-plan-global": { type: "\u001b[31moauth\nretry\u001b[0m", key: "secret" },
      "kimi-code-plan-cn": apiEntry("cn-key"),
    });

    await expect(resolveKimiGlobalAuthCached()).resolves.toEqual({
      state: "invalid",
      error: 'Unsupported Kimi auth type: "oauth retry"',
    });
    await expect(resolveKimiCnAuthCached()).resolves.toEqual({
      state: "configured",
      apiKey: "cn-key",
      endpoint: "cn",
    });
  });

  it("returns auth and sanitized provenance from one regional resolution", async () => {
    process.env.KIMI_GLOBAL_API_KEY = "do-not-leak-global-key";
    process.env.KIMI_CN_API_KEY = "do-not-leak-cn-key";

    const [global, cn] = await Promise.all([
      resolveKimiGlobalAuthWithDiagnosticsCached(),
      resolveKimiCnAuthWithDiagnosticsCached(),
    ]);

    expect(global).toEqual({
      auth: {
        state: "configured",
        apiKey: "do-not-leak-global-key",
        endpoint: "global",
      },
      diagnostics: {
        state: "configured",
        source: "env:KIMI_GLOBAL_API_KEY",
        endpoint: "global",
        checkedPaths: ["env:KIMI_GLOBAL_API_KEY"],
        authPaths: ["/tmp/auth.json"],
      },
    });
    expect(cn.auth).toEqual({
      state: "configured",
      apiKey: "do-not-leak-cn-key",
      endpoint: "cn",
    });
    expect(cn.diagnostics).toMatchObject({
      state: "configured",
      source: "env:KIMI_CN_API_KEY",
      endpoint: "cn",
    });
    expect(JSON.stringify([global.diagnostics, cn.diagnostics])).not.toContain("do-not-leak");
  });

  it("reports source metadata without credential material", async () => {
    process.env.KIMI_GLOBAL_API_KEY = "do-not-leak-global-key";
    process.env.KIMI_CN_API_KEY = "do-not-leak-cn-key";

    const [globalDiagnostics, cnDiagnostics] = await Promise.all([
      getKimiGlobalAuthDiagnostics(),
      getKimiCnAuthDiagnostics(),
    ]);

    expect(globalDiagnostics).toMatchObject({
      state: "configured",
      source: "env:KIMI_GLOBAL_API_KEY",
      endpoint: "global",
      authPaths: ["/tmp/auth.json"],
    });
    expect(cnDiagnostics).toMatchObject({
      state: "configured",
      source: "env:KIMI_CN_API_KEY",
      endpoint: "cn",
      authPaths: ["/tmp/auth.json"],
    });
    const serialized = JSON.stringify([globalDiagnostics, cnDiagnostics]);
    expect(serialized).not.toContain("do-not-leak-global-key");
    expect(serialized).not.toContain("do-not-leak-cn-key");
  });

  it("uses the default auth cache age and clamps negative overrides", async () => {
    await resolveKimiGlobalAuthCached();
    expect(mocks.readAuthFileCached).toHaveBeenLastCalledWith({
      maxAgeMs: DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS,
    });

    await resolveKimiCnAuthCached({ maxAgeMs: -1 });
    expect(mocks.readAuthFileCached).toHaveBeenLastCalledWith({ maxAgeMs: 0 });
  });

  it("returns only trusted global config candidates", () => {
    expect(getOpencodeConfigCandidatePaths()).toEqual([
      { path: join(homedir(), ".config", "opencode", "opencode.jsonc"), isJsonc: true },
      { path: join(homedir(), ".config", "opencode", "opencode.json"), isJsonc: false },
    ]);
  });
});
