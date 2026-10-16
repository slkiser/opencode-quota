import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mockFiles, mockAuth, testPaths } = vi.hoisted(() => {
  const separator = process.platform === "win32" ? "\\" : "/";
  const join = (...parts: string[]) => parts.join(separator);
  const root = join(process.cwd(), ".cursor-detection-test");
  const home = join(root, "home");
  const config = join(root, "config");
  return {
    mockFiles: new Map<string, string>(),
    mockAuth: { value: null as Record<string, unknown> | null },
    testPaths: {
      home,
      credentialDatabase: join(root, "opencode.db"),
      cursorAuth: join(home, ".config", "cursor", "auth.json"),
      config,
      opencodeConfig: join(config, "opencode.json"),
    },
  };
});

vi.mock("fs", () => ({
  existsSync: vi.fn((path: string) => mockFiles.has(path)),
}));

vi.mock("fs/promises", () => ({
  readFile: vi.fn(async (path: string) => {
    if (!mockFiles.has(path)) {
      throw new Error(`missing: ${path}`);
    }
    return mockFiles.get(path)!;
  }),
}));

vi.mock("os", async () => {
  const actual = await vi.importActual<typeof import("os")>("os");
  return {
    ...actual,
    homedir: () => testPaths.home,
    platform: () => "linux",
  };
});

vi.mock("../src/lib/opencode-auth.js", () => ({
  getCredentialDatabasePaths: () => [testPaths.credentialDatabase],
  readAuthFile: vi.fn(async () => mockAuth.value),
}));

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirs: () => ({ configDir: testPaths.config }),
}));

import {
  inspectCursorAuthPresence,
  inspectCursorOpenCodeIntegration,
} from "../src/lib/cursor-detection.js";

const legacyAuthFile = JSON.stringify({ accessToken: "legacy-token" });

describe("cursor detection", () => {
  beforeEach(() => {
    mockFiles.clear();
    mockAuth.value = null;
    delete process.env.CURSOR_ACP_HOME_DIR;
    delete process.env.CURSOR_API_KEY;
  });

  it.each([
    [
      "an OAuth login in the OpenCode database before Cursor's own file",
      { cursor: { type: "oauth", refresh: "refresh-token" } },
      legacyAuthFile,
      {
        state: "present",
        selectedPath: testPaths.credentialDatabase,
        presentPaths: [testPaths.credentialDatabase, testPaths.cursorAuth],
      },
    ],
    [
      "Cursor's own auth file when the database credential is invalid",
      { cursor: { type: "oauth" } },
      legacyAuthFile,
      { state: "present", selectedPath: testPaths.cursorAuth },
    ],
    [
      "an invalid Cursor credential in the OpenCode database",
      { cursor: { type: "oauth" } },
      undefined,
      {
        state: "invalid",
        selectedPath: testPaths.credentialDatabase,
        error:
          "Cursor credential in the OpenCode database is missing a valid OAuth token or API key",
      },
    ],
    [
      "a Cursor login OpenCode could not return, with its reason",
      { cursor: { type: "oauth", resolveError: "refresh_failed: HTTP 401" } },
      undefined,
      {
        state: "invalid",
        selectedPath: testPaths.credentialDatabase,
        error: "OpenCode could not read this login: refresh_failed: HTTP 401",
      },
    ],
    [
      // The credential reader maps OpenCode 2's stored `{ type: "key", key }` to `type: "api"`.
      "a Cursor API key credential in the OpenCode database",
      { cursor: { type: "api", key: "crsr_test-key" } },
      undefined,
      { state: "present", selectedPath: testPaths.credentialDatabase },
    ],
    [
      "a Cursor API key credential without a key",
      { cursor: { type: "api", key: " " } },
      undefined,
      { state: "invalid", selectedPath: testPaths.credentialDatabase },
    ],
    [
      "an unreadable Cursor auth file",
      null,
      "{",
      { state: "invalid", selectedPath: testPaths.cursorAuth },
    ],
    ["no login at all", null, undefined, { state: "missing" }],
  ])("reports %s", async (_label, auth, cursorAuthFile, expected) => {
    mockFiles.set(testPaths.credentialDatabase, "");
    mockAuth.value = auth;
    if (cursorAuthFile !== undefined) mockFiles.set(testPaths.cursorAuth, cursorAuthFile);

    expect(await inspectCursorAuthPresence()).toMatchObject(expected);
  });

  it("accepts the CURSOR_API_KEY environment variable", async () => {
    process.env.CURSOR_API_KEY = "crsr_env-key";

    expect(await inspectCursorAuthPresence()).toMatchObject({
      state: "present",
      selectedPath: "env:CURSOR_API_KEY",
    });
  });

  it.each([
    [
      "legacy plugin and provider.cursor keys",
      {
        plugin: ["cursor-opencode-provider/plugin/opencode2"],
        provider: { cursor: { name: "Cursor" } },
      },
      true,
      true,
    ],
    [
      "OpenCode 2 native plugins and providers keys",
      {
        plugins: [{ package: "cursor-opencode-provider/plugin/opencode2", options: {} }],
        providers: { cursor: { name: "Cursor" } },
      },
      true,
      true,
    ],
    [
      "a legacy cursor runtime id as a provider, not a plugin",
      { plugin: ["some-other-plugin"], provider: { "cursor-acp": { name: "Cursor ACP" } } },
      false,
      true,
    ],
  ])("detects %s", async (_label, config, pluginEnabled, providerConfigured) => {
    mockFiles.set(testPaths.opencodeConfig, JSON.stringify(config));

    expect(await inspectCursorOpenCodeIntegration()).toMatchObject({
      pluginEnabled,
      providerConfigured,
      matchedPaths: [testPaths.opencodeConfig],
    });
  });

  it.each([
    ...[
      "cursor-opencode-provider",
      "cursor-opencode-provider/plugin/opencode2",
      "cursor-opencode-provider/server",
      "cursor-opencode-provider@0.7.3",
      "cursor-opencode-provider@latest/plugin/opencode2",
      "cursor-opencode-provider/plugin/opencode2@0.7.3",
      " Cursor-OpenCode-Provider/Plugin/OpenCode2 ",
    ].map((spec) => [spec, true] as const),
    // OpenCode 1-only Cursor companions and other entries are no longer detected.
    ...[
      "@playwo/opencode-cursor-oauth",
      "cursor-acp",
      "@rama_nigg/open-cursor",
      "PoolPirate/opencode-cursor",
      "cursor-opencode-provider/plugin",
      "cursor-opencode-provider/plugin/v2",
      "@someone/cursor-opencode-provider",
    ].map((spec) => [spec, false] as const),
  ])("plugin spec %j -> detected %s", async (spec, detected) => {
    mockFiles.set(testPaths.opencodeConfig, JSON.stringify({ plugin: [spec] }));

    expect(await inspectCursorOpenCodeIntegration()).toMatchObject({
      pluginEnabled: detected,
      providerConfigured: false,
      matchedPaths: detected ? [testPaths.opencodeConfig] : [],
    });
  });
});
