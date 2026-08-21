import { homedir } from "os";
import { join } from "path";
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

const mocks = vi.hoisted(() => ({
  getCredentialDatabasePaths: vi.fn(() => ["/tmp/opencode.db", "/tmp/auth-fallback.json"]),
  readAuthFileCached: vi.fn(),
}));

vi.mock("../src/lib/opencode-runtime-paths.js", () => createRuntimePathsMockModule());

vi.mock("fs", () => ({
  existsSync: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
}));

vi.mock("../src/lib/opencode-auth.js", () => ({
  getCredentialDatabasePaths: mocks.getCredentialDatabasePaths,
  readAuthFileCached: mocks.readAuthFileCached,
}));

import {
  DEFAULT_ALIBABA_AUTH_CACHE_MAX_AGE_MS,
  getAlibabaCodingPlanAuthDiagnostics,
  getOpencodeConfigCandidatePaths,
  hasAlibabaAuth,
  resolveAlibabaCodingPlanAuth,
  resolveAlibabaCodingPlanAuthCached,
} from "../src/lib/alibaba-auth.js";

describe("alibaba auth resolution", () => {
  const originalEnv = process.env;
  const trustedPaths = getTrustedOpencodeConfigPaths();
  const workspacePaths = getWorkspaceOpencodeConfigPaths();
  const expectedTrustedCandidates = [
    { path: join(homedir(), ".config", "opencode", "opencode.jsonc"), isJsonc: true },
    { path: join(homedir(), ".config", "opencode", "opencode.json"), isJsonc: false },
  ];
  let fsConfigMocks: Awaited<ReturnType<typeof loadFsConfigMocks>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetProcessEnv(originalEnv, ["ALIBABA_CODING_PLAN_API_KEY", "ALIBABA_API_KEY"]);

    mocks.getCredentialDatabasePaths
      .mockReset()
      .mockReturnValue(["/tmp/opencode.db", "/tmp/auth-fallback.json"]);
    mocks.readAuthFileCached.mockReset();

    fsConfigMocks = await loadFsConfigMocks();
    resetFsConfigMocks(fsConfigMocks);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("resolveAlibabaCodingPlanAuth", () => {
    it.each([
      ["auth is null", null],
      ["auth is undefined", undefined],
      ["alibaba entries are missing", {}],
    ])("returns none when %s", (_label, auth) => {
      expect(resolveAlibabaCodingPlanAuth(auth as any)).toEqual({ state: "none" });
      expect(hasAlibabaAuth(auth as any)).toBe(false);
    });

    it("uses the canonical alibaba-coding-plan auth entry when present", () => {
      const auth = {
        "alibaba-coding-plan": { type: "api", key: " dashscope-key ", tier: "pro" },
        alibaba: { type: "api", key: "fallback-key", tier: "lite" },
      };

      expect(resolveAlibabaCodingPlanAuth(auth as any)).toEqual({
        state: "configured",
        apiKey: "dashscope-key",
        tier: "pro",
      });
      expect(hasAlibabaAuth(auth as any)).toBe(true);
    });

    it("falls back to alibaba alias when canonical alias is absent", () => {
      const auth = {
        alibaba: { type: "api", key: " dashscope-key ", tier: "pro" },
      };

      expect(resolveAlibabaCodingPlanAuth(auth as any)).toEqual({
        state: "configured",
        apiKey: "dashscope-key",
        tier: "pro",
      });
      expect(hasAlibabaAuth(auth as any)).toBe(true);
    });

    it("returns invalid when the first present alias has no usable key", () => {
      const auth = {
        "alibaba-coding-plan": { type: "api", key: "   " },
        alibaba: { type: "api", key: "fallback-key", tier: "pro" },
      };

      expect(resolveAlibabaCodingPlanAuth(auth as any)).toEqual({
        state: "invalid",
        error: "Alibaba Coding Plan auth entry present but key is empty",
      });
      expect(hasAlibabaAuth(auth as any)).toBe(false);
    });

    it("returns invalid when the first present alias has a non-api type", () => {
      const auth = {
        "alibaba-coding-plan": { type: "oauth", key: "canonical-key" },
        alibaba: { type: "api", key: "fallback-key", tier: "pro" },
      };

      expect(resolveAlibabaCodingPlanAuth(auth as any)).toEqual({
        state: "invalid",
        error: 'Unsupported Alibaba Coding Plan auth type: "oauth"',
      });
      expect(hasAlibabaAuth(auth as any)).toBe(false);
    });

    it("uses the configured fallback tier when auth omits tier", () => {
      expect(
        resolveAlibabaCodingPlanAuth(
          {
            "alibaba-coding-plan": { type: "api", key: "dashscope-key" },
          } as any,
          "pro",
        ),
      ).toEqual({
        state: "configured",
        apiKey: "dashscope-key",
        tier: "pro",
      });
    });

    it("returns invalid for non-api auth types", () => {
      const auth = {
        alibaba: { type: "oauth", key: "dashscope-key", tier: "lite" },
      };

      expect(resolveAlibabaCodingPlanAuth(auth as any)).toEqual({
        state: "invalid",
        error: 'Unsupported Alibaba Coding Plan auth type: "oauth"',
      });
      expect(hasAlibabaAuth(auth as any)).toBe(false);
    });

    it("returns invalid for access-only auth entries", () => {
      const auth = {
        alibaba: { type: "api", access: "dashscope-key", tier: "lite" },
      };

      expect(resolveAlibabaCodingPlanAuth(auth as any)).toEqual({
        state: "invalid",
        error: "Alibaba Coding Plan auth entry present but key is empty",
      });
      expect(hasAlibabaAuth(auth as any)).toBe(false);
    });

    it("returns invalid for malformed auth entries", () => {
      expect(resolveAlibabaCodingPlanAuth({ alibaba: "bad-shape" } as any)).toEqual({
        state: "invalid",
        error: "Alibaba Coding Plan auth entry has invalid shape",
      });
    });

    it("returns invalid for unsupported tiers", () => {
      expect(
        resolveAlibabaCodingPlanAuth({
          alibaba: { type: "api", key: "dashscope-key", tier: "max" },
        } as any),
      ).toEqual({
        state: "invalid",
        error: "Unsupported Alibaba Coding Plan tier: max",
        rawTier: "max",
      });
    });
  });

  describe("resolveAlibabaCodingPlanAuthCached", () => {
    it("prefers ALIBABA_CODING_PLAN_API_KEY over opencode.db and uses the fallback tier", async () => {
      process.env.ALIBABA_CODING_PLAN_API_KEY = "env-key";
      mocks.readAuthFileCached.mockResolvedValueOnce({
        alibaba: { type: "api", key: "auth-key", tier: "max" },
      });

      await expect(resolveAlibabaCodingPlanAuthCached({ fallbackTier: "pro" })).resolves.toEqual({
        state: "configured",
        apiKey: "env-key",
        tier: "pro",
      });
      expect(mocks.readAuthFileCached).not.toHaveBeenCalled();
    });

    it("reads from trusted global config aliases", async () => {
      mockTrustedConfigFile(
        fsConfigMocks,
        trustedPaths.json,
        JSON.stringify({
          provider: {
            alibaba: {
              options: {
                apiKey: "json-key",
              },
            },
          },
        }),
      );

      await expect(resolveAlibabaCodingPlanAuthCached({ fallbackTier: "lite" })).resolves.toEqual({
        state: "configured",
        apiKey: "json-key",
        tier: "lite",
      });
      expect(mocks.readAuthFileCached).not.toHaveBeenCalled();
    });

    it("resolves allowlisted env templates from trusted config", async () => {
      process.env.ALIBABA_API_KEY = "templated-key";

      mockTrustedConfigFile(
        fsConfigMocks,
        trustedPaths.jsonc,
        `{
        "provider": {
          "alibaba-coding-plan": {
            "options": {
              "apiKey": "{env:ALIBABA_API_KEY}"
            }
          }
        }
      }`,
      );

      await expect(resolveAlibabaCodingPlanAuthCached()).resolves.toEqual({
        state: "configured",
        apiKey: "templated-key",
        tier: "lite",
      });
    });

    it.each([
      ["opencode.json", workspacePaths.json],
      ["opencode.jsonc", workspacePaths.jsonc],
    ])("ignores workspace-local %s when resolving provider secrets", async (_label, workspacePath) => {
      fsConfigMocks.existsSync.mockImplementation((path: string) => path === workspacePath);
      mocks.readAuthFileCached.mockResolvedValueOnce(null);

      await expect(resolveAlibabaCodingPlanAuthCached()).resolves.toEqual({ state: "none" });
    });

    it("falls back to opencode.db when env/config are not configured", async () => {
      mocks.readAuthFileCached.mockResolvedValueOnce({
        alibaba: { type: "api", key: "dashscope-key", tier: "pro" },
      });

      await expect(resolveAlibabaCodingPlanAuthCached()).resolves.toEqual({
        state: "configured",
        apiKey: "dashscope-key",
        tier: "pro",
      });
      expect(mocks.readAuthFileCached).toHaveBeenCalledWith({
        maxAgeMs: DEFAULT_ALIBABA_AUTH_CACHE_MAX_AGE_MS,
      });
    });

    it("returns invalid for access-only cached opencode.db", async () => {
      mocks.readAuthFileCached.mockResolvedValueOnce({
        alibaba: { type: "api", access: "dashscope-key", tier: "pro" },
      });

      await expect(resolveAlibabaCodingPlanAuthCached()).resolves.toEqual({
        state: "invalid",
        error: "Alibaba Coding Plan auth entry present but key is empty",
      });
    });

    it("surfaces invalid opencode.db tiers only when fallback auth wins", async () => {
      mocks.readAuthFileCached.mockResolvedValueOnce({
        alibaba: { type: "api", key: "dashscope-key", tier: "max" },
      });

      await expect(resolveAlibabaCodingPlanAuthCached()).resolves.toEqual({
        state: "invalid",
        error: "Unsupported Alibaba Coding Plan tier: max",
        rawTier: "max",
      });
    });

    it("clamps negative maxAgeMs to 0", async () => {
      mocks.readAuthFileCached.mockResolvedValueOnce({});

      await resolveAlibabaCodingPlanAuthCached({ maxAgeMs: -100 });
      expect(mocks.readAuthFileCached).toHaveBeenCalledWith({ maxAgeMs: 0 });
    });
  });

  describe("getAlibabaCodingPlanAuthDiagnostics", () => {
    it("reports env-based configuration with auth candidate paths", async () => {
      process.env.ALIBABA_API_KEY = "diag-key";

      await expect(getAlibabaCodingPlanAuthDiagnostics()).resolves.toEqual({
        state: "configured",
        source: "env:ALIBABA_API_KEY",
        checkedPaths: ["env:ALIBABA_API_KEY"],
        credentialDatabasePaths: ["/tmp/opencode.db", "/tmp/auth-fallback.json"],
        tier: "lite",
      });
    });

    it("reports checked trusted config paths separately from auth paths", async () => {
      mockTrustedConfigFile(fsConfigMocks, trustedPaths.json, "{}");
      mocks.readAuthFileCached.mockResolvedValueOnce(null);

      await expect(getAlibabaCodingPlanAuthDiagnostics()).resolves.toEqual({
        state: "none",
        source: null,
        checkedPaths: [trustedPaths.json],
        credentialDatabasePaths: ["/tmp/opencode.db", "/tmp/auth-fallback.json"],
      });
    });

    it("reports invalid opencode.db diagnostics when fallback auth is malformed", async () => {
      mocks.readAuthFileCached.mockResolvedValueOnce({
        alibaba: { type: "api", key: "dashscope-key", tier: "max" },
      });

      await expect(getAlibabaCodingPlanAuthDiagnostics()).resolves.toEqual({
        state: "invalid",
        source: "opencode.db",
        checkedPaths: [],
        credentialDatabasePaths: ["/tmp/opencode.db", "/tmp/auth-fallback.json"],
        error: "Unsupported Alibaba Coding Plan tier: max",
        rawTier: "max",
      });
    });
  });

  describe("getOpencodeConfigCandidatePaths", () => {
    it("returns trusted global paths only", () => {
      const paths = getOpencodeConfigCandidatePaths();

      expect(paths).toEqual(expectedTrustedCandidates);
    });
  });
});
