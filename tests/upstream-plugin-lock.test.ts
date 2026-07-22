import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileAsync = promisify(execFile);

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
    await mkdir(path.join(testState.repoRoot, "references", "upstream-plugins"), {
      recursive: true,
    });
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

  it("reads the committed lock when synchronized metadata remains uncommitted", async () => {
    const lockPath = path.join(testState.repoRoot, "references", "upstream-plugins", "lock.json");
    const previousEntry = {
      npmUrl: "https://www.npmjs.com/package/opencode-cursor-oauth/v/0.4.3",
      packageName: "opencode-cursor-oauth",
      publishedAt: "2026-04-08T14:04:58.057Z",
      referenceDir: "references/upstream-plugins/opencode-cursor-oauth",
      repo: "old-owner/opencode-cursor",
      version: "0.4.3",
    };
    await writeFile(
      lockPath,
      `${JSON.stringify({ plugins: { "opencode-cursor-oauth": previousEntry } }, null, 2)}\n`,
      "utf8",
    );
    await execFileAsync("git", ["init"], { cwd: testState.repoRoot });
    await execFileAsync("git", ["add", "references/upstream-plugins/lock.json"], {
      cwd: testState.repoRoot,
    });
    await execFileAsync(
      "git",
      [
        "-c",
        "user.name=Upstream Test",
        "-c",
        "user.email=upstream@example.test",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "baseline",
      ],
      { cwd: testState.repoRoot },
    );

    const currentEntry = {
      ...previousEntry,
      npmUrl: "https://www.npmjs.com/package/%40playwo/opencode-cursor-oauth/v/0.4.3",
      packageName: "@playwo/opencode-cursor-oauth",
      repo: "PoolPirate/opencode-cursor",
    };
    await writeFile(
      lockPath,
      `${JSON.stringify({ plugins: { "opencode-cursor-oauth": currentEntry } }, null, 2)}\n`,
      "utf8",
    );

    const { readCommittedUpstreamPluginLock, readUpstreamPluginLock } =
      await import("../scripts/lib/upstream-plugin-lock.mjs");
    const { buildChangedPluginSummaries } =
      await import("../scripts/lib/upstream-plugin-review.mjs");
    const committedLock = await readCommittedUpstreamPluginLock({
      repositoryRoot: testState.repoRoot,
      lockPath,
    });
    const synchronizedLock = await readUpstreamPluginLock();

    expect(buildChangedPluginSummaries(committedLock, synchronizedLock)).toEqual([
      {
        changeKind: "metadata",
        changedFields: ["packageName", "repo", "npmUrl"],
        currentVersion: "0.4.3",
        pluginId: "opencode-cursor-oauth",
        previousVersion: "0.4.3",
      },
    ]);
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
