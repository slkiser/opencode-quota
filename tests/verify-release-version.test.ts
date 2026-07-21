import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const scriptPath = fileURLToPath(new URL("../scripts/verify-release-version.mjs", import.meta.url));
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

function runWithRef(githubRef?: string) {
  const env = { ...process.env };
  if (githubRef === undefined) delete env.GITHUB_REF;
  else env.GITHUB_REF = githubRef;

  return spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
  });
}

describe("release version verification", () => {
  it("skips successfully when the workflow is not running on a tag", () => {
    const result = runWithRef();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No tag ref detected");
  });

  it("accepts v-prefixed and plain tags that match package.json", () => {
    for (const tag of [`v${pkg.version}`, pkg.version]) {
      const result = runWithRef(`refs/tags/${tag}`);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`matches package.json ${pkg.version}`);
    }
  });

  it("rejects a tag that does not match package.json", () => {
    const result = runWithRef(`refs/tags/v${pkg.version}-mismatch`);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Version mismatch");
  });

  it("rejects an empty tag ref", () => {
    const result = runWithRef("refs/tags/");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unable to parse tag version");
  });
});
