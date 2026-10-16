import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { isolatedGitEnv, stubIsolatedGitEnv } from "./helpers/isolated-git-env.js";

const execFileAsync = promisify(execFile);

const testState = vi.hoisted(() => ({
  repoRoot: "",
}));

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

describe("upstream-plugin-lock", () => {
  beforeEach(async () => {
    testState.repoRoot = await mkdtemp(path.join(os.tmpdir(), "opencode-quota-lock-test-"));
    await mkdir(path.join(testState.repoRoot, "scripts", "upstream-plugins"), {
      recursive: true,
    });
    await writeFile(
      path.join(testState.repoRoot, "scripts", "upstream-plugins", "lock.json"),
      `${JSON.stringify(
        {
          plugins: {
            "opencode-gemini-auth": {
              npmUrl: "https://www.npmjs.com/package/opencode-gemini-auth/v/1.0.0",
              packageName: "opencode-gemini-auth",
              publishedAt: "2026-03-01T00:00:00.000Z",
              referenceDir: "scripts/upstream-plugins/opencode-gemini-auth",
              repo: "jenslys/opencode-gemini-auth",
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
    const lockPath = path.join(testState.repoRoot, "scripts", "upstream-plugins", "lock.json");
    const previousEntry = {
      npmUrl: "https://www.npmjs.com/package/%40old-scope/cursor-opencode-provider/v/0.4.3",
      packageName: "@old-scope/cursor-opencode-provider",
      publishedAt: "2026-04-08T14:04:58.057Z",
      referenceDir: "scripts/upstream-plugins/cursor-opencode-provider",
      repo: "old-owner/cursor-opencode-provider",
      version: "0.4.3",
    };
    await writeFile(
      lockPath,
      `${JSON.stringify({ plugins: { "cursor-opencode-provider": previousEntry } }, null, 2)}\n`,
      "utf8",
    );
    await execFileAsync("git", ["init"], { cwd: testState.repoRoot, env: isolatedGitEnv() });
    await execFileAsync("git", ["add", "scripts/upstream-plugins/lock.json"], {
      cwd: testState.repoRoot,
      env: isolatedGitEnv(),
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
      { cwd: testState.repoRoot, env: isolatedGitEnv() },
    );

    const currentEntry = {
      ...previousEntry,
      npmUrl: "https://www.npmjs.com/package/cursor-opencode-provider/v/0.4.3",
      packageName: "cursor-opencode-provider",
      repo: "oakimov/cursor-opencode-provider",
    };
    await writeFile(
      lockPath,
      `${JSON.stringify({ plugins: { "cursor-opencode-provider": currentEntry } }, null, 2)}\n`,
      "utf8",
    );

    const { readCommittedUpstreamPluginLock, readUpstreamPluginLock } =
      await import("../scripts/lib/upstream-plugin-lock.mjs");
    const { buildChangedPluginSummaries } =
      await import("../scripts/lib/upstream-plugin-review.mjs");
    // readCommittedUpstreamPluginLock runs `git show` with the inherited process.env.
    stubIsolatedGitEnv();
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
        pluginId: "cursor-opencode-provider",
        previousVersion: "0.4.3",
      },
    ]);
  });

  it("replaces an existing lock.json without leaving temp files behind", async () => {
    const { writeUpstreamPluginLock } = await import("../scripts/lib/upstream-plugin-lock.mjs");

    await writeUpstreamPluginLock({
      plugins: {
        "cursor-opencode-provider": {
          npmUrl: "https://www.npmjs.com/package/cursor-opencode-provider/v/2.0.0",
          packageName: "cursor-opencode-provider",
          publishedAt: "2026-03-20T00:00:00.000Z",
          referenceDir: "scripts/upstream-plugins/cursor-opencode-provider",
          repo: "oakimov/cursor-opencode-provider",
          version: "2.0.0",
        },
        "opencode-gemini-auth": {
          npmUrl: "https://www.npmjs.com/package/opencode-gemini-auth/v/2.0.0",
          packageName: "opencode-gemini-auth",
          publishedAt: "2026-03-20T00:00:00.000Z",
          referenceDir: "scripts/upstream-plugins/opencode-gemini-auth",
          repo: "jenslys/opencode-gemini-auth",
          version: "2.0.0",
        },
      },
    });

    const lockPath = path.join(testState.repoRoot, "scripts", "upstream-plugins", "lock.json");
    await expect(readFile(lockPath, "utf8")).resolves.toContain(`"version": "2.0.0"`);
    await expect(readFile(lockPath, "utf8")).resolves.toContain(
      `"packageName": "cursor-opencode-provider"`,
    );

    const entries = await readdir(path.dirname(lockPath));
    expect(entries.filter((entry) => entry.includes("lock.json.tmp-"))).toEqual([]);
  });
});
