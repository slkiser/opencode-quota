import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { isolatedGitEnv } from "./helpers/isolated-git-env.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const packageScript = fileURLToPath(
  new URL("../.github/scripts/verify-package-contents.mjs", import.meta.url),
);
const artifactScript = fileURLToPath(
  new URL("../.github/scripts/verify-release-artifact.mjs", import.meta.url),
);
const historyScript = fileURLToPath(
  new URL("../.github/scripts/verify-v4-history.mjs", import.meta.url),
);
const typescriptScript = fileURLToPath(
  new URL("../.github/scripts/verify-typescript-version.mjs", import.meta.url),
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
    if (typeof target === "string") add(target);
    else for (const value of Object.values(target)) add(value);
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
  await mkdir(path.join(root, ".github/images"), { recursive: true });
  await writeFile(
    path.join(root, ".github/images/opencode-quota-logo-dark.svg"),
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
  git(root, [
    "add",
    "README.md",
    ".gitignore",
    "images/opencode-quota-logo-dark.svg",
    ".github/images/opencode-quota-logo-dark.svg",
  ]);
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
      "TypeScript 7.0.2 and @opencode/plugin 2.2.5 lock entries verified",
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
      "opencode-quota/opencode.db",
      "images/private-smoke.png",
      ".github/images/private-smoke.png",
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
  });

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

  it("matches full-tree checks for deleted, merged, renamed, shared and indexed paths", async () => {
    const historyRepo = path.join(tempDir, "planted-history");
    const base = await createHistoryRepo(historyRepo);
    const mainBranch = git(historyRepo, ["symbolic-ref", "--short", "HEAD"]);
    git(historyRepo, ["config", "core.quotePath", "false"]);

    // This branch starts outside the checked range, and carries a file from that parent.
    git(historyRepo, ["checkout", "-q", "--orphan", "outside"]);
    git(historyRepo, ["rm", "-rf", "."]);
    await writeFiles(historyRepo, ["docs/reports/carried.md"]);
    git(historyRepo, ["add", "-f", "."]);
    git(historyRepo, ["commit", "-qm", "outside parent"]);
    const outside = git(historyRepo, ["rev-parse", "HEAD"]);
    git(historyRepo, ["checkout", "-q", mainBranch]);
    git(historyRepo, [
      "merge",
      "-q",
      "--allow-unrelated-histories",
      "--no-ff",
      "outside",
      "-m",
      "carry",
    ]);
    const carriedBase = git(historyRepo, ["rev-parse", "HEAD"]);

    const deleted = "nested/.env.deleted";
    const merged = "docs/reports/side branch é.md";
    const renamed = "prompt-exports/renamed.md";
    const sharedAllowed = "docs/readme/shared/notes.md";
    const sharedForbidden = "local-live-tests/shared/notes.md";
    const indexed = "references/local/index only é.md";

    await writeFiles(historyRepo, [deleted, "rename-me.md"]);
    git(historyRepo, ["add", "-f", "."]);
    git(historyRepo, ["commit", "-qm", "add then delete"]);
    git(historyRepo, ["rm", deleted]);
    git(historyRepo, ["commit", "-qm", "delete private file"]);

    git(historyRepo, ["checkout", "-qb", "side"]);
    await writeFiles(historyRepo, [merged]);
    git(historyRepo, ["add", "-f", "."]);
    git(historyRepo, ["commit", "-qm", "side branch private file"]);
    git(historyRepo, ["checkout", "-q", mainBranch]);
    await mkdir(path.join(historyRepo, "prompt-exports"), { recursive: true });
    await rename(path.join(historyRepo, "rename-me.md"), path.join(historyRepo, renamed));
    await writeFiles(historyRepo, [sharedAllowed, sharedForbidden]);
    // Identical tree IDs at allowed and forbidden prefixes must be checked separately.
    await writeFile(
      path.join(historyRepo, sharedForbidden),
      await readFile(path.join(historyRepo, sharedAllowed)),
    );
    git(historyRepo, ["add", "-f", "."]);
    git(historyRepo, ["commit", "-qm", "rename and reuse subtree"]);
    git(historyRepo, ["merge", "-q", "--no-ff", "side", "-m", "merge side"]);
    git(historyRepo, ["commit", "--allow-empty", "-qm", "reuse root tree"]);
    await writeFiles(historyRepo, [indexed]);
    git(historyRepo, ["add", "-f", "."]);

    const forbidden = new Set([
      "docs/reports/carried.md",
      deleted,
      merged,
      renamed,
      sharedForbidden,
      indexed,
    ]);
    // A slow reference enumerates every full commit tree, including merged parents.
    for (const historyBase of [base, carriedBase]) {
      const commits = git(historyRepo, ["rev-list", `${historyBase}..HEAD`]).split("\n");
      const violations: string[] = [];
      for (const commit of commits) {
        const files = git(historyRepo, ["ls-tree", "-rz", "--name-only", commit]).split("\0");
        for (const file of files) {
          if (forbidden.has(file)) violations.push(`${commit} ${file}`);
        }
      }
      for (const file of git(historyRepo, ["ls-files", "-z"]).split("\0")) {
        if (forbidden.has(file)) violations.push(`index ${file}`);
      }
      const result = run(historyScript, [], {
        V4_HISTORY_BASE: historyBase,
        V4_HISTORY_REPO: historyRepo,
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        "Forbidden local-only files are tracked in the v4 history or current index:\n" +
          violations.map((violation) => `- ${violation}\n`).join(""),
      );
    }
    // Both parents excluded by carriedBase still supply files in every descendant tree.
    expect(git(historyRepo, ["merge-base", "--is-ancestor", outside, carriedBase])).toBe("");
  });

  it("reads exact Unicode and quoted paths regardless of Git quoting settings", async () => {
    const historyRepo = path.join(tempDir, "odd-paths");
    const base = await createHistoryRepo(historyRepo);
    const forbidden = ["nested é/.env.local", "docs/reports/space é.md"];
    if (process.platform !== "win32") forbidden.push('nested\tline\nquote"/.env');
    await writeFiles(historyRepo, forbidden);
    git(historyRepo, ["add", "-f", "."]);
    git(historyRepo, ["commit", "-qm", "odd paths"]);
    const commit = git(historyRepo, ["rev-parse", "HEAD"]);
    for (const quotePath of ["true", "false"]) {
      git(historyRepo, ["config", "core.quotePath", quotePath]);
      const result = run(historyScript, [], {
        V4_HISTORY_BASE: base,
        V4_HISTORY_REPO: historyRepo,
      });
      expect(result.status).toBe(1);
      for (const file of forbidden) {
        expect(result.stderr).toContain(`- ${commit} ${file}\n`);
        expect(result.stderr).toContain(`- index ${file}\n`);
      }
    }
  });

  it("preserves Git failures for a missing base and a base outside HEAD's ancestry", async () => {
    const historyRepo = path.join(tempDir, "invalid-base");
    await createHistoryRepo(historyRepo);
    const mainBranch = git(historyRepo, ["symbolic-ref", "--short", "HEAD"]);
    git(historyRepo, ["checkout", "-qb", "side"]);
    git(historyRepo, ["commit", "--allow-empty", "-qm", "side only"]);
    const side = git(historyRepo, ["rev-parse", "HEAD"]);
    git(historyRepo, ["checkout", "-q", mainBranch]);
    for (const base of ["missing-base", side]) {
      const result = run(historyScript, [], {
        V4_HISTORY_BASE: base,
        V4_HISTORY_REPO: historyRepo,
      });
      const expected = spawnSync(
        "git",
        base === side
          ? ["merge-base", "--is-ancestor", side, "HEAD"]
          : ["cat-file", "-e", `${base}^{commit}`],
        {
          cwd: historyRepo,
          encoding: "utf8",
          env: isolatedGitEnv(),
        },
      );
      expect(result.status).toBe(expected.status);
      expect(result.stdout).toBe(expected.stdout);
      expect(result.stderr).toBe(expected.stderr);
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
      "opencode-quota/opencode.db",
      "tests/package-manifest.test.ts",
      ".github/scripts/verify-release-version.mjs",
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
