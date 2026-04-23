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
  DEFAULT_MINIMAX_AUTH_CACHE_MAX_AGE_MS,
  getMiniMaxAuthDiagnostics,
  getOpencodeConfigCandidatePaths,
  resolveMiniMaxAuth,
  resolveMiniMaxAuthCached,
} from "../src/lib/minimax-auth.js";

const withMiniMaxAuth = (entry: unknown) => ({
  "minimax-coding-plan": entry,
});

describe("minimax auth resolution", () => {
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
    resetProcessEnv(originalEnv, ["MINIMAX_CODING_PLAN_API_KEY", "MINIMAX_API_KEY"]);

    mocks.getAuthPaths.mockReset().mockReturnValue(["/tmp/auth.json"]);
    mocks.readAuthFileCached.mockReset();

    fsConfigMocks = await loadFsConfigMocks();
    resetFsConfigMocks(fsConfigMocks);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("resolveMiniMaxAuth", () => {
    it.each([
      ["auth is null", null, { state: "none" }],
      ["auth is undefined", undefined, { state: "none" }],
      ["minimax-coding-plan entry is missing", {}, { state: "none" }],
    ])("returns %j when %s", (_label, auth, expected) => {
      expect(resolveMiniMaxAuth(auth as any)).toEqual(expected);
    });

    it.each([
      [
        "type is not 'api'",
        withMiniMaxAuth({ type: "oauth", key: "some-key" }),
        { state: "invalid", error: 'Unsupported MiniMax auth type: "oauth"' },
      ],
      [
        "invalid auth type text is sanitized",
        withMiniMaxAuth({ type: "\u001b[31moauth\nretry\u001b[0m", key: "some-key" }),
        { state: "invalid", error: 'Unsupported MiniMax auth type: "oauth retry"' },
      ],
      [
        "auth entry is not an object",
        withMiniMaxAuth("bad-shape"),
        { state: "invalid", error: "MiniMax auth entry has invalid shape" },
      ],
      [
        "auth type is missing or invalid",
        withMiniMaxAuth({ type: { bad: true }, key: 123 }),
        { state: "invalid", error: "MiniMax auth entry present but type is missing or invalid" },
      ],
      [
        "type is api but credentials are empty",
        withMiniMaxAuth({ type: "api", key: "", access: "" }),
        { state: "invalid", error: "MiniMax auth entry present but credentials are empty" },
      ],
    ])("returns %j when %s", (_label, auth, expected) => {
      expect(resolveMiniMaxAuth(auth as any)).toEqual(expected);
    });

    it.each([
      [
        "key when both key and access are present",
        withMiniMaxAuth({ type: "api", key: "primary-key", access: "access-key" }),
        { state: "configured", apiKey: "primary-key" },
      ],
      [
        "access when key is missing",
        withMiniMaxAuth({ type: "api", access: "access-token" }),
        { state: "configured", apiKey: "access-token" },
      ],
    ])("returns %j when using %s", (_label, auth, expected) => {
      expect(resolveMiniMaxAuth(auth as any)).toEqual(expected);
    });
  });

  describe("resolveMiniMaxAuthCached", () => {
    it("prefers MINIMAX_CODING_PLAN_API_KEY over MINIMAX_API_KEY and auth.json", async () => {
      process.env.MINIMAX_CODING_PLAN_API_KEY = "primary-env-key";
      process.env.MINIMAX_API_KEY = "fallback-env-key";
      mocks.readAuthFileCached.mockResolvedValueOnce(
        withMiniMaxAuth({ type: "oauth", key: "broken-auth" }),
      );

      await expect(resolveMiniMaxAuthCached()).resolves.toEqual({
        state: "configured",
        apiKey: "primary-env-key",
      });
      expect(mocks.readAuthFileCached).not.toHaveBeenCalled();
    });

    it("reads from trusted global config aliases", async () => {
      mockTrustedConfigFile(
        fsConfigMocks,
        trustedPaths.json,
        JSON.stringify({
          provider: {
            minimax: {
              options: {
                apiKey: "json-key",
              },
            },
          },
        }),
      );

      await expect(resolveMiniMaxAuthCached()).resolves.toEqual({
        state: "configured",
        apiKey: "json-key",
      });
      expect(mocks.readAuthFileCached).not.toHaveBeenCalled();
    });

    it.each([
      ["opencode.json", workspacePaths.json],
      ["opencode.jsonc", workspacePaths.jsonc],
    ])("ignores workspace-local %s when resolving provider secrets", async (_label, workspacePath) => {
      fsConfigMocks.existsSync.mockImplementation((path: string) => path === workspacePath);
      mocks.readAuthFileCached.mockResolvedValueOnce(null);

      await expect(resolveMiniMaxAuthCached()).resolves.toEqual({ state: "none" });
    });

    it("falls back to auth.json and preserves access fallback", async () => {
      mocks.readAuthFileCached.mockResolvedValueOnce(
        withMiniMaxAuth({ type: "api", access: "access-token" }),
      );

      await expect(resolveMiniMaxAuthCached()).resolves.toEqual({
        state: "configured",
        apiKey: "access-token",
      });
      expect(mocks.readAuthFileCached).toHaveBeenCalledWith({
        maxAgeMs: DEFAULT_MINIMAX_AUTH_CACHE_MAX_AGE_MS,
      });
    });

    it("masks invalid auth.json when trusted config is configured", async () => {
      mockTrustedConfigFile(
        fsConfigMocks,
        trustedPaths.json,
        JSON.stringify({
          provider: {
            "minimax-coding-plan": {
              options: {
                apiKey: "json-key",
              },
            },
          },
        }),
      );
      mocks.readAuthFileCached.mockResolvedValueOnce(
        withMiniMaxAuth({ type: "oauth", key: "broken-auth" }),
      );

      await expect(resolveMiniMaxAuthCached()).resolves.toEqual({
        state: "configured",
        apiKey: "json-key",
      });
      expect(mocks.readAuthFileCached).not.toHaveBeenCalled();
    });

    it("clamps negative maxAgeMs to 0", async () => {
      mocks.readAuthFileCached.mockResolvedValueOnce({});

      await resolveMiniMaxAuthCached({ maxAgeMs: -500 });
      expect(mocks.readAuthFileCached).toHaveBeenCalledWith({ maxAgeMs: 0 });
    });
  });

  describe("getMiniMaxAuthDiagnostics", () => {
    it("reports env/config checked paths separately from auth paths", async () => {
      process.env.MINIMAX_API_KEY = "diag-key";

      await expect(getMiniMaxAuthDiagnostics()).resolves.toEqual({
        state: "configured",
        source: "env:MINIMAX_API_KEY",
        checkedPaths: ["env:MINIMAX_API_KEY"],
        authPaths: ["/tmp/auth.json"],
      });
    });

    it("reports invalid auth.json diagnostics when fallback auth is malformed", async () => {
      mocks.readAuthFileCached.mockResolvedValueOnce(
        withMiniMaxAuth({ type: "oauth", key: "some-key" }),
      );

      await expect(getMiniMaxAuthDiagnostics()).resolves.toEqual({
        state: "invalid",
        source: "auth.json",
        checkedPaths: [],
        authPaths: ["/tmp/auth.json"],
        error: 'Unsupported MiniMax auth type: "oauth"',
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
