import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockFiles, testPaths } = vi.hoisted(() => {
  const separator = process.platform === "win32" ? "\\" : "/";
  const join = (...parts: string[]) => parts.join(separator);
  const root = join(process.cwd(), ".cursor-detection-test");
  const home = join(root, "home");
  const config = join(root, "config");
  return {
    mockFiles: new Map<string, string>(),
    testPaths: {
      home,
      auth: join(root, "auth.json"),
      cursorAuth: join(home, ".config", "cursor", "auth.json"),
      config,
      opencodeConfig: join(config, "opencode.json"),
      data: join(root, "data"),
      cache: join(root, "cache"),
      state: join(root, "state"),
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
  getAuthPaths: () => [testPaths.auth],
}));

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirCandidates: () => ({
    dataDirs: [testPaths.data],
    configDirs: [testPaths.config],
    cacheDirs: [testPaths.cache],
    stateDirs: [testPaths.state],
  }),
}));

describe("cursor detection", () => {
  beforeEach(() => {
    mockFiles.clear();
    vi.resetModules();
    delete process.env.CURSOR_ACP_HOME_DIR;
  });

  it("prefers Cursor OAuth auth in OpenCode auth.json", async () => {
    mockFiles.set(
      testPaths.auth,
      JSON.stringify({
        cursor: {
          type: "oauth",
          refresh: "refresh-token",
        },
      }),
    );
    mockFiles.set(testPaths.cursorAuth, JSON.stringify({ accessToken: "legacy-token" }));

    const { inspectCursorAuthPresence } = await import("../src/lib/cursor-detection.js");
    const result = await inspectCursorAuthPresence();

    expect(result.state).toBe("present");
    expect(result.selectedPath).toBe(testPaths.auth);
    expect(result.presentPaths).toContain(testPaths.auth);
    expect(result.presentPaths).toContain(testPaths.cursorAuth);
  });

  it("detects the canonical Cursor companion package and provider.cursor config", async () => {
    mockFiles.set(
      testPaths.opencodeConfig,
      JSON.stringify({
        plugin: ["@playwo/opencode-cursor-oauth"],
        provider: {
          cursor: {
            name: "Cursor",
          },
        },
      }),
    );

    const { CURSOR_CANONICAL_PLUGIN_PACKAGE, inspectCursorOpenCodeIntegration } = await import(
      "../src/lib/cursor-detection.js"
    );
    const result = await inspectCursorOpenCodeIntegration();

    expect(CURSOR_CANONICAL_PLUGIN_PACKAGE).toBe("@playwo/opencode-cursor-oauth");
    expect(result.pluginEnabled).toBe(true);
    expect(result.providerConfigured).toBe(true);
    expect(result.matchedPaths).toEqual([testPaths.opencodeConfig]);
  });

  it("keeps legacy Cursor plugin names as compatibility aliases", async () => {
    const aliases = [
      "opencode-cursor-oauth",
      "opencode-cursor",
      "cursor-acp",
      "open-cursor",
      "@rama_nigg/open-cursor",
      "PoolPirate/opencode-cursor",
    ];

    const { inspectCursorOpenCodeIntegration } = await import("../src/lib/cursor-detection.js");

    for (const alias of aliases) {
      mockFiles.clear();
      mockFiles.set(
        testPaths.opencodeConfig,
        JSON.stringify({
          plugin: [alias],
        }),
      );

      const result = await inspectCursorOpenCodeIntegration();

      expect(result.pluginEnabled, alias).toBe(true);
      expect(result.providerConfigured, alias).toBe(false);
      expect(result.matchedPaths, alias).toEqual([testPaths.opencodeConfig]);
    }
  });

  it("detects legacy cursor runtime ids in provider config without treating them as plugins", async () => {
    mockFiles.set(
      testPaths.opencodeConfig,
      JSON.stringify({
        plugin: ["some-other-plugin"],
        provider: {
          "cursor-acp": {
            name: "Cursor ACP",
          },
        },
      }),
    );

    const { inspectCursorOpenCodeIntegration } = await import("../src/lib/cursor-detection.js");
    const result = await inspectCursorOpenCodeIntegration();

    expect(result.pluginEnabled).toBe(false);
    expect(result.providerConfigured).toBe(true);
    expect(result.matchedPaths).toEqual([testPaths.opencodeConfig]);
  });
});
