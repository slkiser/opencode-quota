import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
    env: { ...process.env, ...env },
  });
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
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

async function createHistoryRepo(root: string): Promise<string> {
  await mkdir(root, { recursive: true });
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Release Gate Test"]);
  git(root, ["config", "user.email", "release-gate@example.invalid"]);
  await writeFile(path.join(root, "README.md"), "allowed\n", "utf8");
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
      "/images/",
      "opencode.json",
      "tui.json",
      "",
    ].join("\n"),
    "utf8",
  );
  git(root, ["add", "README.md", ".gitignore"]);
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

  it("keeps TypeScript on 5.9 and the v4 history free of local-only files", () => {
    const typescript = run(typescriptScript);
    expect(typescript.status).toBe(0);
    expect(typescript.stdout).toContain("TypeScript v4 freeze verified");

    const history = run(historyScript);
    expect(history.status).toBe(0);
    expect(history.stdout).toContain("V4 history privacy verified");
  });

  it("rejects every forced-added private path from temporary commit history", async () => {
    const historyRepo = path.join(tempDir, "history");
    const base = await createHistoryRepo(historyRepo);
    const forbidden = [
      "AGENTS.md",
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
      "opencode-quota-logo-dark.svg",
      "opencode-quota-logo-light.svg",
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
