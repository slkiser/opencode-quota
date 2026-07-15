import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const packageScript = fileURLToPath(
  new URL("../scripts/verify-package-contents.mjs", import.meta.url),
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

function run(script: string, args: string[] = []) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
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

  it("rejects repository, local-only, test, script, and logo files from npm", async () => {
    const forbidden = [
      "AGENTS.md",
      "docs/adr/0001-universal-quota-source-model.md",
      "docs/readme/v4-release-readiness.md",
      "references/local/v4.0.0-consolidated-plan.md",
      "references/upstream-plugins/README.md",
      "tests/package-manifest.test.ts",
      "scripts/verify-release-version.mjs",
      "opencode-quota-logo-dark.svg",
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
});
