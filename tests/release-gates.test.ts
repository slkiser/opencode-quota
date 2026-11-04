import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { isolatedGitEnv } from "./helpers/isolated-git-env.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const packageScript = fileURLToPath(
  new URL("../scripts/verify-package-contents.mjs", import.meta.url),
);
const artifactScript = fileURLToPath(
  new URL("../scripts/verify-release-artifact.mjs", import.meta.url),
);
const historyScript = fileURLToPath(new URL("../scripts/verify-v4-history.mjs", import.meta.url));
const typescriptScript = fileURLToPath(
  new URL("../scripts/verify-typescript-version.mjs", import.meta.url),
);
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
  main: string;
  types: string;
  bin: Record<string, string>;
  exports: Record<string, Record<string, string>>;
};

function run(script: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...isolatedGitEnv(), ...env },
  });
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: isolatedGitEnv() });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function requiredPackageFiles(): string[] {
  const paths = new Set([
    "LICENSE",
    "README.md",
    "package.json",
    "dist/data/modelsdev-pricing.min.json",
  ]);
  const add = (value: string) => paths.add(value.replace(/^\.\//, ""));

  add(pkg.main);
  add(pkg.types);
  for (const value of Object.values(pkg.bin)) add(value);
  for (const target of Object.values(pkg.exports)) {
    for (const value of Object.values(target)) add(value);
  }
  return [...paths];
}

async function writeFiles(root: string, files: string[]) {
  await Promise.all(
    files.map(async (file) => {
      const fullPath = path.join(root, file);
      await mkdir(path.dirname(fullPath), { recursive: true });
      await writeFile(fullPath, `private test fixture: ${file}\n`, "utf8");
    }),
  );
}

function gitWithInput(cwd: string, args: string[], input: Buffer | string): string {
  const result = spawnSync("git", args, { cwd, input, env: isolatedGitEnv() });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.toString().trim();
}

// Current git only writes canonical folder modes, so odd tree entries are written by hand.
function commitHandMadeEntry(repo: string, base: string, modeAndName: string, objectId: string) {
  const baseTree = spawnSync("git", ["cat-file", "tree", `${base}^{tree}`], {
    cwd: repo,
    env: isolatedGitEnv(),
  }).stdout;
  const entry = Buffer.concat([
    Buffer.from(`${modeAndName}\0`, "utf8"),
    Buffer.from(objectId, "hex"),
  ]);
  const tree = gitWithInput(
    repo,
    ["hash-object", "-t", "tree", "--literally", "-w", "--stdin"],
    Buffer.concat([baseTree, entry]),
  );
  const commit = git(repo, ["commit-tree", tree, "-p", base, "-m", "hand-made entry"]);
  git(repo, ["update-ref", "HEAD", commit]);
  return commit;
}

async function createHistoryRepo(root: string): Promise<string> {
  await mkdir(root, { recursive: true });
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Release Gate Test"]);
  git(root, ["config", "user.email", "release-gate@example.invalid"]);
  await writeFile(path.join(root, "README.md"), "allowed\n", "utf8");
  await mkdir(path.join(root, "images"), { recursive: true });
  await writeFile(
    path.join(root, "images/opencode-quota-logo-dark.svg"),
    "public image fixture\n",
    "utf8",
  );
  await writeFile(
    path.join(root, ".gitignore"),
    [
      "/AGENTS.md",
      ".env",
      ".env.*",
      ".npmrc",
      "/.agents/",
      "/.codex/",
      "/docs/*",
      "/references/*",
      "/prompt-exports/",
      "/opencode-quota/",
      "/local-live-tests/",
      "opencode.json",
      "tui.json",
      "",
    ].join("\n"),
    "utf8",
  );
  git(root, ["add", "README.md", ".gitignore", "images/opencode-quota-logo-dark.svg"]);
  git(root, ["commit", "-qm", "base"]);
  return git(root, ["rev-parse", "HEAD"]);
}

describe("v4 release gates", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "opencode-quota-release-gates-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("verifies TypeScript 7 and accepts clean v4 history", async () => {
    const typescript = run(typescriptScript);
    expect(typescript.status).toBe(0);
    expect(typescript.stdout).toContain(
      "TypeScript 7.0.2 and @opencode-ai/plugin 1.19.5 lock entries verified",
    );

    const historyRepo = path.join(tempDir, "clean-history");
    const base = await createHistoryRepo(historyRepo);
    const history = run(historyScript, [], {
      V4_HISTORY_BASE: base,
      V4_HISTORY_REPO: historyRepo,
    });
    expect(history.status).toBe(0);
    expect(history.stdout).toContain("V4 history privacy verified");
  });

  it("keeps temp-repo git away from the repository named by a git hook's GIT_DIR", async () => {
    const hookRepo = path.join(tempDir, "hook-repo");
    await mkdir(hookRepo);
    git(hookRepo, ["init", "-q"]);
    git(hookRepo, [
      "-c",
      "user.name=Hook Repo",
      "-c",
      "user.email=hook-repo@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "hook repo head",
    ]);
    const hookRepoHead = git(hookRepo, ["rev-parse", "HEAD"]);
    const hookGitDir = path.join(hookRepo, ".git");

    vi.stubEnv("GIT_DIR", hookGitDir);
    vi.stubEnv("GIT_INDEX_FILE", path.join(hookGitDir, "index"));
    const historyRepo = path.join(tempDir, "history-under-hook");
    const base = await createHistoryRepo(historyRepo);
    const history = run(historyScript, [], {
      V4_HISTORY_BASE: base,
      V4_HISTORY_REPO: historyRepo,
    });
    vi.unstubAllEnvs();

    expect(history.status).toBe(0);
    expect(git(historyRepo, ["log", "-1", "--format=%H %s"])).toBe(`${base} base`);
    expect(git(hookRepo, ["rev-parse", "HEAD"])).toBe(hookRepoHead);
    expect(git(hookRepo, ["config", "--get", "core.bare"])).toBe("false");
    expect(git(hookRepo, ["config", "--local", "--list"])).not.toContain("user.");
    expect(git(hookRepo, ["ls-files"])).toBe("");
  });

  it("rejects every forced-added private path from temporary commit history", async () => {
    const historyRepo = path.join(tempDir, "history");
    const base = await createHistoryRepo(historyRepo);
    const forbidden = [
      "AGENTS.md",
      "src/AGENTS.md",
      "src/lib/AGENTS.md",
      ".env.local",
      ".npmrc",
      "nested/.env",
      "nested/.env.production",
      "nested/.npmrc",
      "nested/opencode.json",
      "nested/tui.json",
      ".agents/plans/v4.md",
      ".codex/session.json",
      "docs/adr/0001-private.md",
      "docs/plans/v4.md",
      "docs/reports/v4.md",
      "docs/provider-auth-resolution.local.md",
      "docs/readme/v4-release-readiness.md",
      "references/local/opencode-1.18.2/package.json",
      "references/branches/private-plan.md",
      "prompt-exports/session.md",
      "opencode-quota/auth.json",
      "images/private-smoke.png",
      "local-live-tests/google-agy/account.json",
      "local-live-tests/openai/account.json",
      "local-live-tests/notes.txt",
      "opencode.json",
      "tui.json",
    ];

    await writeFiles(historyRepo, forbidden);
    git(historyRepo, ["add", "-f", "--", ...forbidden]);
    git(historyRepo, ["commit", "-qm", "force add private files"]);

    const result = run(historyScript, [], {
      V4_HISTORY_BASE: base,
      V4_HISTORY_REPO: historyRepo,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Forbidden local-only files");
    for (const file of forbidden) expect(result.stderr).toContain(file);
  }, 30_000);

  it("rejects a forced-added private path in the current index", async () => {
    const historyRepo = path.join(tempDir, "index");
    const base = await createHistoryRepo(historyRepo);
    const forbidden = "references/local/private-report.md";

    await writeFiles(historyRepo, [forbidden]);
    git(historyRepo, ["add", "-f", "--", forbidden]);

    const result = run(historyScript, [], {
      V4_HISTORY_BASE: base,
      V4_HISTORY_REPO: historyRepo,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`index ${forbidden}`);
  });

  it.each(["040000", "40755"])("opens a folder stored with the hand-made mode %s", async (mode) => {
    const historyRepo = path.join(tempDir, `folder-mode-${mode}`);
    const base = await createHistoryRepo(historyRepo);
    const blob = gitWithInput(historyRepo, ["hash-object", "-w", "--stdin"], "private\n");
    const innerTree = gitWithInput(historyRepo, ["mktree"], `100644 blob ${blob}\tAGENTS.md\n`);
    const commit = commitHandMadeEntry(historyRepo, base, `${mode} zodd`, innerTree);

    const result = run(historyScript, [], {
      V4_HISTORY_BASE: base,
      V4_HISTORY_REPO: historyRepo,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${commit} zodd/AGENTS.md`);
  });

  it.each([
    ["an invalid mode", "100x644 zokay", (blob: string) => blob],
    ["no mode separator", "zzzzzzzzzz", (blob: string) => blob],
    ["a cut-off object id", "100644 zokay", (blob: string) => blob.slice(0, 20)],
  ])("rejects a tree entry with %s without hanging", async (_case, modeAndName, objectId) => {
    const historyRepo = path.join(tempDir, "malformed-entry");
    const base = await createHistoryRepo(historyRepo);
    const blob = gitWithInput(historyRepo, ["hash-object", "-w", "--stdin"], "allowed\n");
    commitHandMadeEntry(historyRepo, base, modeAndName, objectId(blob));

    const result = spawnSync(process.execPath, [historyScript], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 20_000,
      env: { ...isolatedGitEnv(), V4_HISTORY_BASE: base, V4_HISTORY_REPO: historyRepo },
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Invalid git tree");
  });

  it("fails without hanging when a folder entry points at a large file", async () => {
    const historyRepo = path.join(tempDir, "folder-is-file");
    const base = await createHistoryRepo(historyRepo);
    // Larger than a pipe buffer, so a reply the script stops reading would block git.
    const blob = gitWithInput(historyRepo, ["hash-object", "-w", "--stdin"], "x".repeat(2_000_000));
    commitHandMadeEntry(historyRepo, base, "40000 zbroken", blob);

    const result = spawnSync(process.execPath, [historyScript], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 20_000,
      env: { ...isolatedGitEnv(), V4_HISTORY_BASE: base, V4_HISTORY_REPO: historyRepo },
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(blob);
  });

  it("checks complete merged trees, deleted and renamed paths, and the index with five git processes", async () => {
    const historyRepo = path.join(tempDir, "merged-history");
    await createHistoryRepo(historyRepo);
    git(historyRepo, ["config", "core.quotePath", "false"]);
    await writeFiles(historyRepo, ["docs/carried.md", "rename.txt"]);
    git(historyRepo, ["add", "-f", "."]);
    git(historyRepo, ["commit", "-qm", "base with a carried private file"]);
    const base = git(historyRepo, ["rev-parse", "HEAD"]);
    const mainBranch = git(historyRepo, ["symbolic-ref", "--short", "HEAD"]);

    // This file is inherited from the excluded base, not added in the checked range.
    await writeFiles(historyRepo, ["nested/.env"]);
    git(historyRepo, ["add", "-f", "."]);
    git(historyRepo, ["commit", "-qm", "temporary private file"]);
    const deleted = git(historyRepo, ["rev-parse", "HEAD"]);
    git(historyRepo, ["rm", "nested/.env", "docs/carried.md"]);
    git(historyRepo, ["commit", "-qm", "delete private files"]);

    git(historyRepo, ["checkout", "-qb", "side"]);
    const sidePath = "local-live-tests/space café.txt";
    await writeFiles(historyRepo, [sidePath]);
    git(historyRepo, ["add", "-f", "."]);
    git(historyRepo, ["commit", "-qm", "private side branch file"]);
    const side = git(historyRepo, ["rev-parse", "HEAD"]);

    git(historyRepo, ["checkout", "-q", mainBranch]);
    await mkdir(path.join(historyRepo, "prompt-exports"));
    git(historyRepo, ["mv", "rename.txt", "prompt-exports/renamed.txt"]);
    // Identical subtree and blob IDs must still be checked under each path prefix.
    for (const directory of ["src", "docs", "references/upstream-plugins"]) {
      await mkdir(path.join(historyRepo, directory), { recursive: true });
      await writeFile(path.join(historyRepo, directory, "shared.txt"), "same blob\n");
    }
    git(historyRepo, ["add", "-f", "."]);
    git(historyRepo, ["commit", "-qm", "rename and reuse a subtree at different paths"]);
    const renamed = git(historyRepo, ["rev-parse", "HEAD"]);
    git(historyRepo, ["merge", "--no-ff", "-qm", "merge side", "side"]);
    const merged = git(historyRepo, ["rev-parse", "HEAD"]);
    git(historyRepo, ["commit", "--allow-empty", "-qm", "reuse the entire merged tree"]);
    const repeated = git(historyRepo, ["rev-parse", "HEAD"]);
    const indexPath = "nested/.env.index only café";
    await writeFiles(historyRepo, [indexPath]);
    git(historyRepo, ["add", "-f", "--", indexPath]);

    const tracePath = path.join(tempDir, "git-trace.json");
    const result = run(historyScript, [], {
      V4_HISTORY_BASE: base,
      V4_HISTORY_REPO: historyRepo,
      GIT_TRACE2_EVENT: tracePath,
    });
    const pathsByCommit = new Map([
      [deleted, ["docs/carried.md", "nested/.env"]],
      [side, [sidePath]],
      [renamed, ["docs/shared.txt", "prompt-exports/renamed.txt"]],
      [merged, ["docs/shared.txt", sidePath, "prompt-exports/renamed.txt"]],
      [repeated, ["docs/shared.txt", sidePath, "prompt-exports/renamed.txt"]],
    ]);
    const expected = git(historyRepo, ["rev-list", `${base}..HEAD`])
      .split("\n")
      .flatMap((commit) => (pathsByCommit.get(commit) ?? []).map((file) => `${commit} ${file}`));
    expected.push(
      "index docs/shared.txt",
      `index ${sidePath}`,
      `index ${indexPath}`,
      "index prompt-exports/renamed.txt",
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      `Forbidden local-only files are tracked in the v4 history or current index:\n${expected
        .map((violation) => `- ${violation}\n`)
        .join("")}`,
    );
    const gitStarts = (await readFile(tracePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string; argv?: string[] })
      .filter((event) => event.event === "start");
    expect(gitStarts).toHaveLength(5);
    expect(gitStarts.filter((event) => event.argv?.includes("--batch"))).toHaveLength(1);
  }, 30_000);

  it("checks paths with quoting characters and whitespace exactly", async () => {
    const historyRepo = path.join(tempDir, "odd-paths");
    const base = await createHistoryRepo(historyRepo);
    git(historyRepo, ["config", "core.protectNTFS", "false"]);
    const forbidden = [
      'docs/quoted "café".md',
      "local-live-tests/tab\tand newline\n.txt",
      "nested café/.env",
      "prompt-exports/trailing space ",
    ];
    // Populate the index directly: these Git paths need not be legal Windows filenames.
    const blob = git(historyRepo, ["hash-object", "-w", "README.md"]);
    for (const file of forbidden) {
      git(historyRepo, ["update-index", "--add", "--cacheinfo", `100644,${blob},${file}`]);
    }
    git(historyRepo, ["update-index", "--add", "--cacheinfo", `120000,${blob},nested/.env.link`]);
    git(historyRepo, ["update-index", "--add", "--cacheinfo", `160000,${base},.codex`]);
    git(historyRepo, ["commit", "-qm", "odd private filenames"]);
    const commit = git(historyRepo, ["rev-parse", "HEAD"]);

    const result = run(historyScript, [], {
      V4_HISTORY_BASE: base,
      V4_HISTORY_REPO: historyRepo,
    });
    expect(result.status).toBe(1);
    for (const file of [...forbidden, "nested/.env.link", ".codex"]) {
      expect(result.stderr).toContain(`- ${commit} ${file}\n`);
      expect(result.stderr).toContain(`- index ${file}\n`);
    }
  });

  it("accepts only required dist output and the three allowed root files", async () => {
    const manifestPath = path.join(tempDir, "allowed.json");
    await writeFile(
      manifestPath,
      JSON.stringify({ files: requiredPackageFiles().map((entry) => ({ path: entry })) }),
      "utf8",
    );

    const result = run(packageScript, [manifestPath]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("npm contents verified");
  });

  it("rejects all nonessential, repository, agent, local, documentation, and logo files", async () => {
    const forbidden = [
      "AGENTS.md",
      ".agents/plans/v4.md",
      ".codex/session.json",
      "docs/adr/0001-universal-quota-source-model.md",
      "docs/provider-auth-resolution.local.md",
      "docs/readme/v4-release-readiness.md",
      "docs/plans/v4.0.0-roadmap.md",
      "references/local/opencode-1.18.2/package.json",
      "references/local/v4.0.0-consolidated-plan.md",
      "references/upstream-plugins/README.md",
      "prompt-exports/review.md",
      "opencode-quota/auth.json",
      "tests/package-manifest.test.ts",
      "scripts/verify-release-version.mjs",
      "images/opencode-quota-logo-dark.svg",
      "images/opencode-quota-logo-light.svg",
      "images/opencode-quota_opencode-quota-sidebar.webp",
      "images/opencode-quota_opencode-quota-statusbar.webp",
      "images/opencode-quota_opencode-quota-toast.webp",
      "images/opencode-quota_opencode-quota-tokens-command.webp",
    ];
    const manifestPath = path.join(tempDir, "forbidden.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        files: [...requiredPackageFiles(), ...forbidden].map((entry) => ({ path: entry })),
      }),
      "utf8",
    );

    const result = run(packageScript, [manifestPath]);
    expect(result.status).toBe(1);
    for (const file of forbidden) expect(result.stderr).toContain(file);
  });

  it("rejects a package missing a required public entrypoint", async () => {
    const manifestPath = path.join(tempDir, "missing.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        files: requiredPackageFiles()
          .filter((entry) => entry !== "dist/tui.js")
          .map((entry) => ({ path: entry })),
      }),
      "utf8",
    );

    const result = run(packageScript, [manifestPath]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("dist/tui.js");
  });

  it("verifies one exact release tarball and rejects content tampering", async () => {
    const artifactDir = path.join(tempDir, "artifact");
    const filename = "slkiser-opencode-quota-4.0.0.tgz";
    const tarballPath = path.join(artifactDir, filename);
    const contents = Buffer.from("exact release artifact");
    await mkdir(artifactDir);
    await writeFile(tarballPath, contents);
    await writeFile(
      path.join(artifactDir, "release-artifact.json"),
      `${JSON.stringify(
        {
          version: 1,
          filename,
          sha256: createHash("sha256").update(contents).digest("hex"),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const valid = run(artifactScript, [artifactDir]);
    expect(valid.status).toBe(0);
    expect(valid.stdout).toContain("Release artifact verified");

    await writeFile(tarballPath, "tampered");
    const tampered = run(artifactScript, [artifactDir]);
    expect(tampered.status).toBe(1);
    expect(tampered.stderr).toContain("SHA-256 mismatch");
  });
});
