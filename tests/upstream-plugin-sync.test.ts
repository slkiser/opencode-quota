import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
        const fixtureRoot = pathModule.join(process.cwd(), "references", "upstream-plugins", pluginId);
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
    return `${testState.repoRoot}/references/upstream-plugins`;
  },
  get upstreamPluginLockPath() {
    return `${testState.repoRoot}/references/upstream-plugins/lock.json`;
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
  const referenceRoot = path.join(repoRoot, "references", "upstream-plugins");
  await mkdir(referenceRoot, { recursive: true });
  await writeFile(path.join(referenceRoot, "README.md"), "reference readme\n", "utf8");
  await writeFile(
    path.join(referenceRoot, "lock.json"),
    `${JSON.stringify(
      {
        plugins: {
          "opencode-antigravity-auth": {
            npmUrl: "https://www.npmjs.com/package/opencode-antigravity-auth/v/1.0.0",
            packageName: "opencode-antigravity-auth",
            publishedAt: "2026-03-01T00:00:00.000Z",
            referenceDir: "references/upstream-plugins/opencode-antigravity-auth",
            repo: "NoeFabris/opencode-antigravity-auth",
            version: "1.0.0",
          },
          "opencode-cursor-oauth": {
            npmUrl: "https://www.npmjs.com/package/opencode-cursor-oauth/v/1.0.0",
            packageName: "opencode-cursor-oauth",
            publishedAt: "2026-03-01T00:00:00.000Z",
            referenceDir: "references/upstream-plugins/opencode-cursor-oauth",
            repo: "ephraimduncan/opencode-cursor",
            version: "1.0.0",
          },
          "opencode-qwencode-auth": {
            npmUrl: "https://www.npmjs.com/package/opencode-qwencode-auth/v/1.0.0",
            packageName: "opencode-qwencode-auth",
            publishedAt: "2026-03-01T00:00:00.000Z",
            referenceDir: "references/upstream-plugins/opencode-qwencode-auth",
            repo: "gustavodiasdev/opencode-qwencode-auth",
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
    "opencode-antigravity-auth",
    "opencode-cursor-oauth",
    "opencode-qwencode-auth",
  ]) {
    const pluginDir = path.join(referenceRoot, pluginId);
    await mkdir(pluginDir, { recursive: true });
    await writeFile(path.join(pluginDir, "package.json"), JSON.stringify({ pluginId, version: "1.0.0" }), "utf8");
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
        "opencode-antigravity-auth",
        {
          npmUrl: "https://www.npmjs.com/package/opencode-antigravity-auth/v/2.0.0",
          packageName: "opencode-antigravity-auth",
          pluginId: "opencode-antigravity-auth",
          publishedAt: "2026-03-20T00:00:00.000Z",
          referenceDir: "references/upstream-plugins/opencode-antigravity-auth",
          repo: "NoeFabris/opencode-antigravity-auth",
          tarballUrl: "https://example.test/opencode-antigravity-auth-2.0.0.tgz",
          version: "2.0.0",
        },
      ],
      [
        "opencode-cursor-oauth",
        {
          npmUrl: "https://www.npmjs.com/package/opencode-cursor-oauth/v/2.0.0",
          packageName: "opencode-cursor-oauth",
          pluginId: "opencode-cursor-oauth",
          publishedAt: "2026-03-20T00:00:00.000Z",
          referenceDir: "references/upstream-plugins/opencode-cursor-oauth",
          repo: "ephraimduncan/opencode-cursor",
          tarballUrl: "https://example.test/opencode-cursor-oauth-2.0.0.tgz",
          version: "2.0.0",
        },
      ],
      [
        "opencode-qwencode-auth",
        {
          npmUrl: "https://www.npmjs.com/package/opencode-qwencode-auth/v/2.0.0",
          packageName: "opencode-qwencode-auth",
          pluginId: "opencode-qwencode-auth",
          publishedAt: "2026-03-20T00:00:00.000Z",
          referenceDir: "references/upstream-plugins/opencode-qwencode-auth",
          repo: "gustavodiasdev/opencode-qwencode-auth",
          tarballUrl: "https://example.test/opencode-qwencode-auth-2.0.0.tgz",
          version: "2.0.0",
        },
      ],
    ]);

    await seedReferenceRoot(testState.repoRoot);
    vi.resetModules();
  });

  afterEach(async () => {
    await rm(testState.repoRoot, { force: true, recursive: true });
  });

  it("stages the full reference tree before swapping it into place", async () => {
    const { syncUpstreamPluginReferences } = await import("../scripts/lib/upstream-plugin-sync.mjs");
    const result = await syncUpstreamPluginReferences();
    const referenceRoot = path.join(testState.repoRoot, "references", "upstream-plugins");

    expect(result.syncedPlugins).toHaveLength(3);
    await expect(readFile(path.join(referenceRoot, "README.md"), "utf8")).resolves.toBe("reference readme\n");
    await expect(readFile(path.join(referenceRoot, "stale-plugin", "package.json"), "utf8")).rejects.toThrow();
    await expect(
      readFile(path.join(referenceRoot, "opencode-antigravity-auth", "dist", "src", "constants.js"), "utf8"),
    ).resolves.toContain("REDACTED_GOOGLE_OAUTH_CLIENT_SECRET");
    await expect(readFile(path.join(referenceRoot, "opencode-cursor-oauth", "package.json"), "utf8")).resolves.toContain(
      "\"name\": \"opencode-cursor-oauth\"",
    );
    await expect(readFile(path.join(referenceRoot, "opencode-cursor-oauth", "dist", "models.js"), "utf8")).resolves.toContain(
      "if (discovered && discovered.length > 0) {",
    );
    await expect(readFile(path.join(referenceRoot, "opencode-cursor-oauth", "dist", "proxy.js"), "utf8")).resolves.toContain(
      "messages: normalizedMessages",
    );
    await expect(readFile(path.join(referenceRoot, "lock.json"), "utf8")).resolves.toContain("\"version\": \"2.0.0\"");
  });

  it("leaves the committed reference tree untouched when staging fails", async () => {
    testState.failPluginId = "opencode-cursor-oauth";

    const { syncUpstreamPluginReferences } = await import("../scripts/lib/upstream-plugin-sync.mjs");
    const referenceRoot = path.join(testState.repoRoot, "references", "upstream-plugins");

    await expect(syncUpstreamPluginReferences()).rejects.toThrow(
      "Failed to extract",
    );

    await expect(readFile(path.join(referenceRoot, "README.md"), "utf8")).resolves.toBe("reference readme\n");
    await expect(readFile(path.join(referenceRoot, "stale-plugin", "package.json"), "utf8")).resolves.toContain(
      "\"stale\":true",
    );
    await expect(readFile(path.join(referenceRoot, "opencode-cursor-oauth", "package.json"), "utf8")).resolves.toContain(
      "\"version\":\"1.0.0\"",
    );
    await expect(readFile(path.join(referenceRoot, "lock.json"), "utf8")).resolves.toContain("\"version\": \"1.0.0\"");
  });
});
