import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  repoRoot: "",
}));

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

describe("upstream-plugin-lock", () => {
  beforeEach(async () => {
    testState.repoRoot = await mkdtemp(path.join(os.tmpdir(), "opencode-quota-lock-test-"));
    await mkdir(path.join(testState.repoRoot, "references", "upstream-plugins"), { recursive: true });
    await writeFile(
      path.join(testState.repoRoot, "references", "upstream-plugins", "lock.json"),
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
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    vi.resetModules();
  });

  afterEach(async () => {
    await rm(testState.repoRoot, { force: true, recursive: true });
  });

  it("replaces an existing lock.json without leaving temp files behind", async () => {
    const { writeUpstreamPluginLock } = await import("../scripts/lib/upstream-plugin-lock.mjs");

    await writeUpstreamPluginLock({
      plugins: {
        "opencode-cursor-oauth": {
          npmUrl: "https://www.npmjs.com/package/%40playwo/opencode-cursor-oauth/v/2.0.0",
          packageName: "@playwo/opencode-cursor-oauth",
          publishedAt: "2026-03-20T00:00:00.000Z",
          referenceDir: "references/upstream-plugins/opencode-cursor-oauth",
          repo: "PoolPirate/opencode-cursor",
          version: "2.0.0",
        },
        "opencode-antigravity-auth": {
          npmUrl: "https://www.npmjs.com/package/opencode-antigravity-auth/v/2.0.0",
          packageName: "opencode-antigravity-auth",
          publishedAt: "2026-03-20T00:00:00.000Z",
          referenceDir: "references/upstream-plugins/opencode-antigravity-auth",
          repo: "NoeFabris/opencode-antigravity-auth",
          version: "2.0.0",
        },
      },
    });

    const lockPath = path.join(testState.repoRoot, "references", "upstream-plugins", "lock.json");
    await expect(readFile(lockPath, "utf8")).resolves.toContain(`"version": "2.0.0"`);
    await expect(readFile(lockPath, "utf8")).resolves.toContain(
      `"packageName": "@playwo/opencode-cursor-oauth"`,
    );

    const entries = await readdir(path.dirname(lockPath));
    expect(entries.filter((entry) => entry.includes("lock.json.tmp-"))).toEqual([]);
  });
});
