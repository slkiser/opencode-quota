import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  UPSTREAM_PLUGIN_REFERENCE_ROOT,
  UPSTREAM_PLUGIN_SPECS,
} from "../scripts/lib/upstream-plugin-specs.mjs";

async function readSnapshotText(rootPath: string): Promise<string> {
  const contents: string[] = [];

  async function visit(directoryPath: string): Promise<void> {
    for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile()) {
        contents.push(await readFile(entryPath, "utf8"));
      }
    }
  }

  await visit(rootPath);
  return contents.join("\n");
}

describe("upstream plugin reference integrity", () => {
  it("keeps specs, lock metadata, and sanitized snapshots in sync", async () => {
    const lock = JSON.parse(
      await readFile(path.join(UPSTREAM_PLUGIN_REFERENCE_ROOT, "lock.json"), "utf8"),
    ) as {
      plugins: Record<
        string,
        {
          packageName: string;
          referenceDir: string;
          repo: string;
          version: string;
        }
      >;
    };

    const specIds = UPSTREAM_PLUGIN_SPECS.map((spec) => spec.pluginId).sort();
    expect(Object.keys(lock.plugins).sort()).toEqual(specIds);

    const referenceDirectories = (
      await readdir(UPSTREAM_PLUGIN_REFERENCE_ROOT, { withFileTypes: true })
    )
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(referenceDirectories).toEqual(specIds);

    for (const spec of UPSTREAM_PLUGIN_SPECS) {
      const tracked = lock.plugins[spec.pluginId];
      expect(tracked).toMatchObject({
        packageName: spec.packageName,
        referenceDir: spec.referenceDir,
        repo: spec.repo,
      });

      const packageJson = JSON.parse(
        await readFile(path.join(spec.referenceDir, "package.json"), "utf8"),
      ) as { name?: string; version?: string };
      expect(packageJson).toMatchObject({
        name: tracked.packageName,
        version: tracked.version,
      });
    }

    const agyRoot = path.join(UPSTREAM_PLUGIN_REFERENCE_ROOT, "opencode-agy-auth");
    const agyCredentialText = await readSnapshotText(agyRoot);

    expect(agyCredentialText).toContain(
      "REDACTED_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com",
    );
    expect(agyCredentialText).toContain("REDACTED_GOOGLE_OAUTH_CLIENT_SECRET");
    expect(agyCredentialText).not.toMatch(/\b\d{10,}-[a-z0-9]+\.apps\.googleusercontent\.com\b/i);
    expect(agyCredentialText).not.toMatch(/GOCSPX-[A-Za-z0-9_-]+/);
  });
});
