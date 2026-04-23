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
  getAuthPaths: vi.fn(() => ["/tmp/auth.json"]),
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
  getAuthPaths: mocks.getAuthPaths,
  readAuthFileCached: mocks.readAuthFileCached,
}));

import {
  DEFAULT_ZAI_AUTH_CACHE_MAX_AGE_MS,
  getOpencodeConfigCandidatePaths,
  getZaiAuthDiagnostics,
  resolveZaiAuth,
  resolveZaiAuthCached,
} from "../src/lib/zai-auth.js";

const withZaiAuth = (entry: unknown) => ({
  "zai-coding-plan": entry,
});

describe("zai auth resolution", () => {
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
    resetProcessEnv(originalEnv, ["ZAI_API_KEY", "ZAI_CODING_PLAN_API_KEY"]);

    mocks.getAuthPaths.mockReset().mockReturnValue(["/tmp/auth.json"]);
    mocks.readAuthFileCached.mockReset();

    fsConfigMocks = await loadFsConfigMocks();
    resetFsConfigMocks(fsConfigMocks);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("resolveZaiAuth", () => {
    it.each([
      ["auth is null", null, { state: "none" }],
      ["auth is undefined", undefined, { state: "none" }],
      ["zai-coding-plan entry is missing", {}, { state: "none" }],
    ])("returns %j when %s", (_label, auth, expected) => {
      expect(resolveZaiAuth(auth as any)).toEqual(expected);
    });

    it.each([
      [
        "auth entry is not an object",
        withZaiAuth("bad-shape"),
        { state: "invalid", error: "Z.ai auth entry has invalid shape" },
      ],
      [
        "auth type is missing or invalid",
        withZaiAuth({ type: { bad: true }, key: "key" }),
        { state: "invalid", error: "Z.ai auth entry present but type is missing or invalid" },
      ],
      [
        "type is not api",
        withZaiAuth({ type: "oauth", key: "key" }),
        { state: "invalid", error: 'Unsupported Z.ai auth type: "oauth"' },
      ],
      [
        "invalid auth type text is sanitized",
        withZaiAuth({ type: "\u001b[31moauth\nretry\u001b[0m", key: "key" }),
        { state: "invalid", error: 'Unsupported Z.ai auth type: "oauth retry"' },
      ],
      [
        "key is empty",
        withZaiAuth({ type: "api", key: "" }),
        { state: "invalid", error: "Z.ai auth entry present but key is empty" },
      ],
    ])("returns %j when %s", (_label, auth, expected) => {
      expect(resolveZaiAuth(auth as any)).toEqual(expected);
    });

    it("returns configured when a trimmed key is present", () => {
      expect(resolveZaiAuth(withZaiAuth({ type: "api", key: " zai-key " }) as any)).toEqual({
        state: "configured",
        apiKey: "zai-key",
      });
    });
  });

  describe("resolveZaiAuthCached", () => {
    it("prefers ZAI_API_KEY over invalid auth.json", async () => {
      process.env.ZAI_API_KEY = "env-key";
      mocks.readAuthFileCached.mockResolvedValueOnce(withZaiAuth({ type: "oauth", key: "token" }));

      await expect(resolveZaiAuthCached()).resolves.toEqual({
        state: "configured",
        apiKey: "env-key",
      });
      expect(mocks.readAuthFileCached).not.toHaveBeenCalled();
    });

    it("reads from trusted global config aliases in provider-key order", async () => {
      mockTrustedConfigFile(
        fsConfigMocks,
        trustedPaths.json,
        JSON.stringify({
          provider: {
            zai: {
              options: {
                apiKey: "{env:NOT_ALLOWED}",
              },
            },
            glm: {
              options: {
                apiKey: "glm-key",
              },
            },
          },
        }),
      );

      await expect(resolveZaiAuthCached()).resolves.toEqual({
        state: "configured",
        apiKey: "glm-key",
      });
      expect(mocks.readAuthFileCached).not.toHaveBeenCalled();
    });

    it.each([
      ["opencode.json", workspacePaths.json],
      ["opencode.jsonc", workspacePaths.jsonc],
    ])("ignores workspace-local %s when resolving provider secrets", async (_label, workspacePath) => {
      fsConfigMocks.existsSync.mockImplementation((path: string) => path === workspacePath);
      mocks.readAuthFileCached.mockResolvedValueOnce(null);

      await expect(resolveZaiAuthCached()).resolves.toEqual({ state: "none" });
    });

    it("falls back to auth.json when env/config are not configured", async () => {
      mocks.readAuthFileCached.mockResolvedValueOnce(withZaiAuth({ type: "api", key: "zai-key" }));

      await expect(resolveZaiAuthCached()).resolves.toEqual({
        state: "configured",
        apiKey: "zai-key",
      });
      expect(mocks.readAuthFileCached).toHaveBeenCalledWith({
        maxAgeMs: DEFAULT_ZAI_AUTH_CACHE_MAX_AGE_MS,
      });
    });

    it("surfaces invalid auth.json when the fallback entry wins", async () => {
      mocks.readAuthFileCached.mockResolvedValueOnce(withZaiAuth({ type: "oauth", key: "token" }));

      await expect(resolveZaiAuthCached()).resolves.toEqual({
        state: "invalid",
        error: 'Unsupported Z.ai auth type: "oauth"',
      });
    });

    it("clamps negative maxAgeMs to 0", async () => {
      mocks.readAuthFileCached.mockResolvedValueOnce({});

      await resolveZaiAuthCached({ maxAgeMs: -1 });
      expect(mocks.readAuthFileCached).toHaveBeenCalledWith({ maxAgeMs: 0 });
    });
  });

  describe("getZaiAuthDiagnostics", () => {
    it("reports env/config checked paths separately from auth paths", async () => {
      process.env.ZAI_CODING_PLAN_API_KEY = "diag-key";

      await expect(getZaiAuthDiagnostics()).resolves.toEqual({
        state: "configured",
        source: "env:ZAI_CODING_PLAN_API_KEY",
        checkedPaths: ["env:ZAI_CODING_PLAN_API_KEY"],
        authPaths: ["/tmp/auth.json"],
      });
    });

    it("reports invalid auth.json diagnostics when fallback auth is malformed", async () => {
      mocks.readAuthFileCached.mockResolvedValueOnce(withZaiAuth({ type: "oauth", key: "token" }));

      await expect(getZaiAuthDiagnostics()).resolves.toEqual({
        state: "invalid",
        source: "auth.json",
        checkedPaths: [],
        authPaths: ["/tmp/auth.json"],
        error: 'Unsupported Z.ai auth type: "oauth"',
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
