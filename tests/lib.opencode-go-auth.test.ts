import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";
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
  readCredentialRows: vi.fn(async () => []),
  formatCredentialDisplayNames: vi.fn(),
  queryOpenCodeGoQuota: vi.fn(),
  readFile: vi.fn(),
  lstat: vi.fn(),
}));

vi.mock("../src/lib/opencode-runtime-paths.js", () => createRuntimePathsMockModule());
vi.mock("fs", () => ({ existsSync: vi.fn() }));
vi.mock("fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("fs/promises")>()),
  readFile: authMocks.readFile,
  lstat: authMocks.lstat,
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  readFile: authMocks.readFile,
  lstat: authMocks.lstat,
}));
vi.mock("../src/lib/opencode-auth.js", () => ({
  getCredentialDatabasePaths: authMocks.getCredentialDatabasePaths,
  readAuthFileCached: authMocks.readAuthFileCached,
  readCredentialRows: authMocks.readCredentialRows,
  formatCredentialDisplayNames: authMocks.formatCredentialDisplayNames,
}));
vi.mock("../src/lib/opencode-go.js", () => ({
  queryOpenCodeGoQuota: authMocks.queryOpenCodeGoQuota,
}));

import {
  DEFAULT_OPENCODE_GO_AUTH_CACHE_MAX_AGE_MS,
  getOpenCodeGoAuthDiagnostics,
  getOpencodeConfigCandidatePaths,
  resolveOpenCodeGoAuth,
  resolveOpenCodeGoAuthCached,
} from "../src/lib/opencode-go-auth.js";
import { auditObsoleteUpdateSources } from "../src/lib/scoped-update-migration.js";

const originalEnv = process.env;
const trustedPaths = getTrustedOpencodeConfigPaths();
const workspacePaths = getWorkspaceOpencodeConfigPaths();
let fsMocks: Awaited<ReturnType<typeof loadFsConfigMocks>>;

function authEntry(entry: unknown): Record<string, unknown> {
  return { opencode: entry };
}

function resetFixture(): void {
  process.env = { ...originalEnv };
  for (const name of [
    "OPENCODE_API_KEY",
    "OPENCODE_GO_WORKSPACE_ID",
    "OPENCODE_GO_AUTH_COOKIE",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "NOT_ALLOWED",
  ]) {
    delete process.env[name];
  }
  resetFsConfigMocks(fsMocks);
  authMocks.getCredentialDatabasePaths.mockReset().mockReturnValue(["/tmp/opencode.db"]);
  authMocks.readAuthFileCached.mockReset().mockResolvedValue(null);
  authMocks.lstat
    .mockReset()
    .mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
}

describe("OpenCode Go auth resolution", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    fsMocks = await loadFsConfigMocks();
    resetFixture();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("parses only the canonical opencode API record", () => {
    expect(resolveOpenCodeGoAuth(null)).toEqual({ state: "none" });
    expect(resolveOpenCodeGoAuth({})).toEqual({ state: "none" });
    expect(resolveOpenCodeGoAuth([])).toEqual({ state: "none" });
    expect(resolveOpenCodeGoAuth(authEntry(null))).toEqual({ state: "none" });
    expect(resolveOpenCodeGoAuth(authEntry("key"))).toEqual({
      state: "invalid",
      error: "OpenCode Go auth entry has invalid shape",
    });
    expect(resolveOpenCodeGoAuth(authEntry([]))).toEqual({
      state: "invalid",
      error: "OpenCode Go auth entry present but type is missing or invalid",
    });
    expect(resolveOpenCodeGoAuth(authEntry({ type: "oauth", key: "ignored" }))).toEqual({
      state: "invalid",
      error: "OpenCode Go auth entry has unsupported type",
    });
    expect(resolveOpenCodeGoAuth(authEntry({ type: "api", key: " " }))).toEqual({
      state: "invalid",
      error: "OpenCode Go auth entry present but key is empty",
    });
    expect(resolveOpenCodeGoAuth(authEntry({ type: "api", key: " go-key " }))).toEqual({
      state: "configured",
      apiKey: "go-key",
    });
  });

  it("rejects unrelated alias auth keys", () => {
    for (const alias of ["opencode-go-subscription", "openai", "zen"]) {
      expect(resolveOpenCodeGoAuth({ [alias]: { type: "api", key: "alias-key" } })).toEqual({
        state: "none",
      });
    }
  });

  it("accepts the opencode-go opencode.db key written by `opencode auth login -p opencode-go`", () => {
    expect(resolveOpenCodeGoAuth({ "opencode-go": { type: "api", key: "cli-key" } })).toEqual({
      state: "configured",
      apiKey: "cli-key",
    });
    // The legacy `opencode` key still works as a fallback.
    expect(resolveOpenCodeGoAuth({ opencode: { type: "api", key: "legacy-key" } })).toEqual({
      state: "configured",
      apiKey: "legacy-key",
    });
  });

  it("prefers the opencode-go opencode.db key over the legacy opencode fallback", () => {
    const auth = {
      "opencode-go": { type: "api", key: "cli-key" },
      opencode: { type: "api", key: "legacy-key" },
    };
    expect(resolveOpenCodeGoAuth(auth)).toEqual({
      state: "configured",
      apiKey: "cli-key",
    });
  });

  it.each([
    ["null", null, "none"],
    ["an invalid shape", "key", "invalid"],
    ["missing a type", {}, "invalid"],
    ["an unsupported type", { type: "oauth", key: "ignored" }, "invalid"],
    ["an empty key", { type: "api", key: " " }, "invalid"],
  ])("does not use legacy auth when opencode-go is %s", (_case, primary, state) => {
    expect(
      resolveOpenCodeGoAuth({
        "opencode-go": primary,
        opencode: { type: "api", key: "legacy-key" },
      }),
    ).toMatchObject({ state });
  });

  it("prefers OPENCODE_API_KEY and does not read lower-priority auth", async () => {
    process.env.OPENCODE_API_KEY = " env-key ";
    authMocks.readAuthFileCached.mockResolvedValue(authEntry({ type: "oauth", key: "ignored" }));

    await expect(resolveOpenCodeGoAuthCached()).resolves.toEqual({
      state: "configured",
      apiKey: "env-key",
    });
    expect(authMocks.readAuthFileCached).not.toHaveBeenCalled();
  });

  it("uses canonical trusted global provider.opencode-go.options.apiKey first", async () => {
    mockTrustedConfigFile(
      fsMocks,
      trustedPaths.jsonc,
      JSON.stringify({
        provider: {
          "opencode-go": { options: { apiKey: "canonical-key" } },
          opencode: { options: { apiKey: "legacy-key" } },
        },
      }),
    );

    await expect(resolveOpenCodeGoAuthCached()).resolves.toEqual({
      state: "configured",
      apiKey: "canonical-key",
    });
    expect(authMocks.readAuthFileCached).not.toHaveBeenCalled();

    resetFixture();
    mockTrustedConfigFile(
      fsMocks,
      trustedPaths.json,
      JSON.stringify({ provider: { opencode: { options: { apiKey: "legacy-key" } } } }),
    );
    await expect(resolveOpenCodeGoAuthCached()).resolves.toEqual({
      state: "configured",
      apiKey: "legacy-key",
    });

    resetFixture();
    mockExistingConfigPath(fsMocks, workspacePaths.json);
    await expect(resolveOpenCodeGoAuthCached()).resolves.toEqual({ state: "none" });
  });

  it("keeps canonical config precedence and diagnostics unchanged after obsolete-source audit", async () => {
    const configDir = dirname(trustedPaths.json);
    const obsoletePath = join(configDir, "opencode-quota", "opencode-go.json");
    const canonicalCanary = "canonical-go-key-canary";
    const fallbackCanary = "fallback-go-key-canary";
    process.env.OPENCODE_GO_WORKSPACE_ID = "obsolete-go-workspace-canary";
    process.env.OPENCODE_GO_AUTH_COOKIE = "obsolete-go-cookie-canary";
    mockTrustedConfigFile(
      fsMocks,
      trustedPaths.json,
      JSON.stringify({
        provider: {
          "opencode-go": { options: { apiKey: canonicalCanary } },
          opencode: { options: { apiKey: fallbackCanary } },
        },
      }),
    );
    authMocks.lstat.mockImplementation(async (path: string) => {
      if (path === obsoletePath) return {};
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });

    const beforeResult = await resolveOpenCodeGoAuthCached();
    const beforeDiagnostics = await getOpenCodeGoAuthDiagnostics();
    const readsBeforeAudit = authMocks.readFile.mock.calls.length;
    const findings = await auditObsoleteUpdateSources({
      env: process.env,
      configDirs: [configDir],
      primaryConfigDir: configDir,
    });
    expect(authMocks.readFile).toHaveBeenCalledTimes(readsBeforeAudit);
    expect(process.env.OPENCODE_GO_WORKSPACE_ID).toBe("obsolete-go-workspace-canary");
    expect(process.env.OPENCODE_GO_AUTH_COOKIE).toBe("obsolete-go-cookie-canary");
    const afterResult = await resolveOpenCodeGoAuthCached();
    const afterDiagnostics = await getOpenCodeGoAuthDiagnostics();

    expect(beforeResult).toEqual({ state: "configured", apiKey: canonicalCanary });
    expect(afterResult).toEqual(beforeResult);
    expect(afterDiagnostics).toEqual(beforeDiagnostics);
    expect(findings).toEqual(
      expect.arrayContaining([
        { kind: "obsolete-go-env", name: "OPENCODE_GO_WORKSPACE_ID" },
        { kind: "obsolete-go-env", name: "OPENCODE_GO_AUTH_COOKIE" },
        { kind: "obsolete-go-file", path: obsoletePath },
      ]),
    );
    const publicBoundary = JSON.stringify({ findings, beforeDiagnostics, afterDiagnostics });
    for (const canary of [
      canonicalCanary,
      fallbackCanary,
      "obsolete-go-workspace-canary",
      "obsolete-go-cookie-canary",
    ]) {
      expect(publicBoundary).not.toContain(canary);
    }
    expect(authMocks.readAuthFileCached).not.toHaveBeenCalled();
  });

  it("continues past blank env and unusable config to canonical opencode.db", async () => {
    process.env.OPENCODE_API_KEY = " ";
    mockTrustedConfigFile(
      fsMocks,
      trustedPaths.json,
      JSON.stringify({ provider: { opencode: { options: { apiKey: "{env:NOT_ALLOWED}" } } } }),
    );
    authMocks.readAuthFileCached.mockResolvedValue(authEntry({ type: "api", key: "auth-key" }));

    await expect(resolveOpenCodeGoAuthCached()).resolves.toEqual({
      state: "configured",
      apiKey: "auth-key",
    });
    expect(authMocks.readAuthFileCached).toHaveBeenCalledWith({
      maxAgeMs: DEFAULT_OPENCODE_GO_AUTH_CACHE_MAX_AGE_MS,
    });
  });

  it("uses a fixed unsupported-type error without leaking type or key secrets", async () => {
    const secret = "distinctive-go-secret";
    const auth = authEntry({ type: secret, key: secret });
    authMocks.readAuthFileCached.mockResolvedValue(auth);

    expect(resolveOpenCodeGoAuth(auth)).toEqual({
      state: "invalid",
      error: "OpenCode Go auth entry has unsupported type",
    });
    await expect(resolveOpenCodeGoAuthCached()).resolves.toEqual({
      state: "invalid",
      error: "OpenCode Go auth entry has unsupported type",
    });
    const diagnostics = await getOpenCodeGoAuthDiagnostics({ maxAgeMs: -1 });
    expect(diagnostics).toEqual({
      state: "invalid",
      source: "opencode.db",
      checkedPaths: expect.any(Array),
      credentialDatabasePaths: ["/tmp/opencode.db"],
      error: "OpenCode Go auth entry has unsupported type",
    });
    expect(JSON.stringify(diagnostics)).not.toContain(secret);
    expect(authMocks.readAuthFileCached).toHaveBeenLastCalledWith({ maxAgeMs: 0 });

    const { opencodeGoProvider } = await import("../src/providers/opencode-go.js");
    const result = await opencodeGoProvider.fetch(createProviderAvailabilityContext());
    expect(result.errors).toContainEqual({
      label: "OpenCode Go",
      message: "OpenCode Go auth entry has unsupported type",
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(authMocks.queryOpenCodeGoQuota).not.toHaveBeenCalled();
  });

  it("reports exact configured source and shared trusted paths", async () => {
    process.env.OPENCODE_API_KEY = "diagnostic-key";

    await expect(getOpenCodeGoAuthDiagnostics()).resolves.toMatchObject({
      state: "configured",
      source: "env:OPENCODE_API_KEY",
      checkedPaths: ["env:OPENCODE_API_KEY"],
      credentialDatabasePaths: ["/tmp/opencode.db"],
    });
    expect(getOpencodeConfigCandidatePaths()).toEqual([
      { path: trustedPaths.jsonc, isJsonc: true },
      { path: trustedPaths.json, isJsonc: false },
    ]);
  });
});
