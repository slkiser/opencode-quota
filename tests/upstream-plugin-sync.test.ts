import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  failPluginId: null as null | string,
  latestByPluginId: new Map<string, any>(),
  repoRoot: "",
}));

vi.mock("node:child_process", async () => {
  const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const pathModule = await vi.importActual<typeof import("node:path")>("node:path");

  return {
    execFile: ((command: string, args: string[], callback: (error: Error | null) => void) => {
      void (async () => {
        const tarballPath = args[1];
        const destinationPath = args[4];
        const pluginId = pathModule.basename(tarballPath).replace(/-[^-]+\.tgz$/, "");

        if (testState.failPluginId === pluginId) {
          callback(new Error(`boom for ${pluginId}`));
          return;
        }

        await fs.mkdir(destinationPath, { recursive: true });
        const fixtureRoot = pathModule.join(process.cwd(), "scripts", "upstream-plugins", pluginId);
        await fs.cp(fixtureRoot, destinationPath, { recursive: true });
        callback(null);
      })().catch((error) => callback(error as Error));
    }) as any,
  };
});

vi.mock("../scripts/lib/upstream-plugin-paths.mjs", () => ({
  get repoRoot() {
    return testState.repoRoot;
  },
  get upstreamPluginReferenceRoot() {
    return `${testState.repoRoot}/scripts/upstream-plugins`;
  },
  get upstreamPluginLockPath() {
    return `${testState.repoRoot}/scripts/upstream-plugins/lock.json`;
  },
}));

vi.mock("../scripts/lib/upstream-plugin-registry.mjs", async () => {
  const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

  return {
    downloadTarball: vi.fn(async (_url: string, destinationPath: string) => {
      await fs.writeFile(destinationPath, "tarball", "utf8");
    }),
    fetchLatestPublishedPluginVersion: vi.fn(async (spec: { pluginId: string }) => {
      const latest = testState.latestByPluginId.get(spec.pluginId);
      if (!latest) {
        throw new Error(`missing latest for ${spec.pluginId}`);
      }
      return latest;
    }),
  };
});

async function seedReferenceRoot(repoRoot: string) {
  const referenceRoot = path.join(repoRoot, "scripts", "upstream-plugins");
  await mkdir(referenceRoot, { recursive: true });
  await writeFile(path.join(referenceRoot, "README.md"), "reference readme\n", "utf8");
  await writeFile(
    path.join(referenceRoot, "lock.json"),
    `${JSON.stringify(
      {
        plugins: {
          "cursor-opencode-provider": {
            npmUrl: "https://www.npmjs.com/package/cursor-opencode-provider/v/1.0.0",
            packageName: "cursor-opencode-provider",
            publishedAt: "2026-03-01T00:00:00.000Z",
            referenceDir: "scripts/upstream-plugins/cursor-opencode-provider",
            repo: "oakimov/cursor-opencode-provider",
            version: "1.0.0",
          },
          "opencode-gemini-auth": {
            npmUrl: "https://www.npmjs.com/package/opencode-gemini-auth/v/1.0.0",
            packageName: "opencode-gemini-auth",
            publishedAt: "2026-03-01T00:00:00.000Z",
            referenceDir: "scripts/upstream-plugins/opencode-gemini-auth",
            repo: "jenslys/opencode-gemini-auth",
            version: "1.0.0",
          },
          "opencode-agy-auth": {
            npmUrl: "https://www.npmjs.com/package/%40anthonyhaussman/opencode-agy-auth/v/1.0.0",
            packageName: "@anthonyhaussman/opencode-agy-auth",
            publishedAt: "2026-03-01T00:00:00.000Z",
            referenceDir: "scripts/upstream-plugins/opencode-agy-auth",
            repo: "anthonyhaussman/opencode-agy-auth",
            version: "1.0.0",
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  for (const pluginId of [
    "cursor-opencode-provider",
    "opencode-gemini-auth",
    "opencode-agy-auth",
  ]) {
    const pluginDir = path.join(referenceRoot, pluginId);
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      path.join(pluginDir, "package.json"),
      JSON.stringify({ pluginId, version: "1.0.0" }),
      "utf8",
    );
  }

  const staleDir = path.join(referenceRoot, "stale-plugin");
  await mkdir(staleDir, { recursive: true });
  await writeFile(path.join(staleDir, "package.json"), JSON.stringify({ stale: true }), "utf8");
}

describe("upstream-plugin-sync", () => {
  beforeEach(async () => {
    testState.repoRoot = await mkdtemp(path.join(os.tmpdir(), "opencode-quota-sync-test-"));
    testState.failPluginId = null;
    testState.latestByPluginId = new Map([
      [
        "cursor-opencode-provider",
        {
          npmUrl: "https://www.npmjs.com/package/cursor-opencode-provider/v/2.0.0",
          packageName: "cursor-opencode-provider",
          pluginId: "cursor-opencode-provider",
          publishedAt: "2026-03-20T00:00:00.000Z",
          referenceDir: "scripts/upstream-plugins/cursor-opencode-provider",
          repo: "oakimov/cursor-opencode-provider",
          tarballUrl:
            "https://example.test/cursor-opencode-provider/-/cursor-opencode-provider-2.0.0.tgz",
          version: "2.0.0",
        },
      ],
      [
        "opencode-gemini-auth",
        {
          npmUrl: "https://www.npmjs.com/package/opencode-gemini-auth/v/2.0.0",
          packageName: "opencode-gemini-auth",
          pluginId: "opencode-gemini-auth",
          publishedAt: "2026-03-20T00:00:00.000Z",
          referenceDir: "scripts/upstream-plugins/opencode-gemini-auth",
          repo: "jenslys/opencode-gemini-auth",
          tarballUrl: "https://example.test/opencode-gemini-auth-2.0.0.tgz",
          version: "2.0.0",
        },
      ],
      [
        "opencode-agy-auth",
        {
          npmUrl: "https://www.npmjs.com/package/%40anthonyhaussman/opencode-agy-auth/v/2.0.0",
          packageName: "@anthonyhaussman/opencode-agy-auth",
          pluginId: "opencode-agy-auth",
          publishedAt: "2026-03-20T00:00:00.000Z",
          referenceDir: "scripts/upstream-plugins/opencode-agy-auth",
          repo: "anthonyhaussman/opencode-agy-auth",
          tarballUrl:
            "https://example.test/@anthonyhaussman/opencode-agy-auth/-/opencode-agy-auth-2.0.0.tgz",
          version: "2.0.0",
        },
      ],
    ]);

    await seedReferenceRoot(testState.repoRoot);
    vi.resetModules();
  });

  afterEach(async () => {
    await rm(testState.repoRoot, {
      force: true,
      recursive: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });

  it("stages the full reference tree before swapping it into place", async () => {
    const { syncUpstreamPluginReferences } =
      await import("../scripts/lib/upstream-plugin-sync.mjs");
    const result = await syncUpstreamPluginReferences();
    const referenceRoot = path.join(testState.repoRoot, "scripts", "upstream-plugins");

    expect(result.syncedPlugins).toHaveLength(3);
    await expect(readFile(path.join(referenceRoot, "README.md"), "utf8")).resolves.toBe(
      "reference readme\n",
    );
    await expect(
      readFile(path.join(referenceRoot, "stale-plugin", "package.json"), "utf8"),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(referenceRoot, "cursor-opencode-provider", "package.json"), "utf8"),
    ).resolves.toContain('"name": "cursor-opencode-provider"');
    await expect(
      readFile(
        path.join(referenceRoot, "cursor-opencode-provider", "dist", "pricing-data.js"),
        "utf8",
      ),
    ).resolves.toContain("export const CURSOR_MODEL_COSTS = {");
    await expect(
      readFile(path.join(referenceRoot, "opencode-gemini-auth", "dist", "index.js"), "utf8"),
    ).resolves.toContain("REDACTED_GOOGLE_OAUTH_CLIENT_SECRET");
    await expect(
      readFile(path.join(referenceRoot, "opencode-agy-auth", "dist", "index.js"), "utf8"),
    ).resolves.toContain("REDACTED_GOOGLE_OAUTH_CLIENT_SECRET");
    await expect(
      readFile(path.join(referenceRoot, "opencode-agy-auth", "package.json"), "utf8"),
    ).resolves.toContain('"name": "@anthonyhaussman/opencode-agy-auth"');
    await expect(readFile(path.join(referenceRoot, "lock.json"), "utf8")).resolves.toContain(
      '"version": "2.0.0"',
    );
    await expect(readFile(path.join(referenceRoot, "lock.json"), "utf8")).resolves.toContain(
      '"packageName": "cursor-opencode-provider"',
    );
    await expect(readFile(path.join(referenceRoot, "lock.json"), "utf8")).resolves.toContain(
      '"repo": "oakimov/cursor-opencode-provider"',
    );
  });

  it("sanitizes unchanged-version copies before swapping them into place", async () => {
    const geminiLatest = testState.latestByPluginId.get("opencode-gemini-auth");
    testState.latestByPluginId.set("opencode-gemini-auth", { ...geminiLatest, version: "1.0.0" });

    const geminiDistDir = path.join(
      testState.repoRoot,
      "scripts",
      "upstream-plugins",
      "opencode-gemini-auth",
      "dist",
    );
    await mkdir(geminiDistDir, { recursive: true });
    await writeFile(
      path.join(geminiDistDir, "index.js"),
      'var GEMINI_CLIENT_ID = "UNSAFE_CLIENT_ID";\nvar GEMINI_CLIENT_SECRET = "UNSAFE_CLIENT_SECRET";\n',
      "utf8",
    );

    const { syncUpstreamPluginReferences } =
      await import("../scripts/lib/upstream-plugin-sync.mjs");
    await syncUpstreamPluginReferences();

    const referenceRoot = path.join(testState.repoRoot, "scripts", "upstream-plugins");
    const geminiBundle = await readFile(
      path.join(referenceRoot, "opencode-gemini-auth", "dist", "index.js"),
      "utf8",
    );
    expect(geminiBundle).toContain("REDACTED_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com");
    expect(geminiBundle).toContain("REDACTED_GOOGLE_OAUTH_CLIENT_SECRET");
    expect(geminiBundle).not.toContain("UNSAFE_CLIENT_ID");
    expect(geminiBundle).not.toContain("UNSAFE_CLIENT_SECRET");
  });

  it("redownloads same-version plugins when tracked identity changes", async () => {
    const cursorLatest = testState.latestByPluginId.get("cursor-opencode-provider");
    testState.latestByPluginId.set("cursor-opencode-provider", {
      ...cursorLatest,
      version: "1.0.0",
    });

    const referenceRoot = path.join(testState.repoRoot, "scripts", "upstream-plugins");
    const lockPath = path.join(referenceRoot, "lock.json");
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    lock.plugins["cursor-opencode-provider"] = {
      npmUrl: "https://www.npmjs.com/package/%40old-scope/cursor-opencode-provider/v/1.0.0",
      packageName: "@old-scope/cursor-opencode-provider",
      publishedAt: "2026-03-01T00:00:00.000Z",
      referenceDir: "scripts/upstream-plugins/cursor-opencode-provider",
      repo: "old-owner/cursor-opencode-provider",
      version: "1.0.0",
    };
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
    await writeFile(
      path.join(referenceRoot, "cursor-opencode-provider", "package.json"),
      JSON.stringify({
        name: "@old-scope/cursor-opencode-provider",
        stale: true,
        version: "1.0.0",
      }),
      "utf8",
    );

    const { syncUpstreamPluginReferences } =
      await import("../scripts/lib/upstream-plugin-sync.mjs");
    await syncUpstreamPluginReferences();

    const packageJson = await readFile(
      path.join(referenceRoot, "cursor-opencode-provider", "package.json"),
      "utf8",
    );
    expect(packageJson).toContain('"name": "cursor-opencode-provider"');
    expect(packageJson).not.toContain('"stale":true');
    await expect(readFile(lockPath, "utf8")).resolves.toContain(
      '"packageName": "cursor-opencode-provider"',
    );
  });

  it("leaves the committed reference tree untouched when staging fails", async () => {
    testState.failPluginId = "cursor-opencode-provider";

    const { syncUpstreamPluginReferences } =
      await import("../scripts/lib/upstream-plugin-sync.mjs");
    const referenceRoot = path.join(testState.repoRoot, "scripts", "upstream-plugins");

    await expect(syncUpstreamPluginReferences()).rejects.toThrow("Failed to extract");

    await expect(readFile(path.join(referenceRoot, "README.md"), "utf8")).resolves.toBe(
      "reference readme\n",
    );
    await expect(
      readFile(path.join(referenceRoot, "stale-plugin", "package.json"), "utf8"),
    ).resolves.toContain('"stale":true');
    await expect(
      readFile(path.join(referenceRoot, "cursor-opencode-provider", "package.json"), "utf8"),
    ).resolves.toContain('"version":"1.0.0"');
    await expect(readFile(path.join(referenceRoot, "lock.json"), "utf8")).resolves.toContain(
      '"version": "1.0.0"',
    );
  });
});
