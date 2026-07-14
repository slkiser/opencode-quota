import { describe, expect, it } from "vitest";
import { access, readFile } from "node:fs/promises";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
  main?: string;
  bin?: Record<string, string>;
  exports?: Record<string, { default?: string; types?: string }>;
  "oc-plugin"?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  engines?: Record<string, string>;
  packageManager?: string;
  scripts?: Record<string, string>;
};

const pnpmWorkspace = await readFile(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8");
const ciWorkflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const publishWorkflow = await readFile(
  new URL("../.github/workflows/publish-npm.yml", import.meta.url),
  "utf8",
);
const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

describe("package manifest compatibility", () => {
  it("requires pnpm 11+ development tooling while requiring Node 20+ at runtime", () => {
    const packageManagerMatch = pkg.packageManager?.match(/^pnpm@(\d+)\.\d+\.\d+(?:[+-].*)?$/);

    expect(packageManagerMatch).not.toBeNull();
    expect(Number(packageManagerMatch?.[1])).toBeGreaterThanOrEqual(11);
    expect(pkg.engines?.node).toBe(">=20.0.0");
  });

  it("keeps plugin SDK dependencies aligned without asserting an OpenCode engine minimum", () => {
    expect(pkg.peerDependencies?.["@opencode-ai/plugin"]).toBe("^1.4.3");
    expect(pkg.devDependencies?.["@opencode-ai/plugin"]).toBe("^1.4.3");
    expect(readme).toContain("Node.js `>= 20` is required.");
    expect(readme).not.toContain("OpenCode `>= 1.4.3`");
    expect(pkg.engines).not.toHaveProperty("opencode");
  });

  it("hardens pnpm dependency resolution against fresh-package supply-chain attacks", () => {
    expect(pnpmWorkspace).toContain("minimumReleaseAge: 1440");
    expect(pnpmWorkspace).toContain("minimumReleaseAgeStrict: true");
    expect(pnpmWorkspace).toContain("minimumReleaseAgeIgnoreMissingTime: false");
    expect(pnpmWorkspace).toContain("blockExoticSubdeps: true");
    expect(pnpmWorkspace).toContain("allowBuilds:");
    expect(pnpmWorkspace).toContain("esbuild: true");
    expect(pnpmWorkspace).toContain("msgpackr-extract: true");
  });

  it("cleans generated dist output before building", () => {
    expect(pkg.scripts?.build).toContain("node scripts/clean-dist.mjs && tsc");
  });

  it("ships explicit server, tui, and init bin entrypoints for OpenCode", () => {
    expect(pkg.main).toBe("./dist/index.js");
    expect(pkg.bin).toEqual({
      "opencode-quota": "./dist/bin/opencode-quota.js",
    });
    expect(pkg["oc-plugin"]).toEqual(["server", "tui"]);
    expect(pkg.dependencies?.["@clack/prompts"]).toBeTruthy();
    expect(pkg.exports?.["."]).toEqual({
      default: "./dist/index.js",
      types: "./dist/index.d.ts",
    });
    expect(pkg.exports?.["./server"]).toEqual({
      default: "./dist/index.js",
      types: "./dist/index.d.ts",
    });
    expect(pkg.exports?.["./tui"]).toEqual({
      default: "./dist/tui.js",
      types: "./dist/tui.d.ts",
    });
  });

  it("does not leave stale Crof generated artifacts in active dist", async () => {
    const staleCrofDistPaths = [
      "../dist/lib/crof-config.d.ts",
      "../dist/lib/crof-config.d.ts.map",
      "../dist/lib/crof-config.js",
      "../dist/lib/crof-config.js.map",
      "../dist/lib/crof.d.ts",
      "../dist/lib/crof.d.ts.map",
      "../dist/lib/crof.js",
      "../dist/lib/crof.js.map",
      "../dist/providers/crof.d.ts",
      "../dist/providers/crof.d.ts.map",
      "../dist/providers/crof.js",
      "../dist/providers/crof.js.map",
    ];

    await Promise.all(
      staleCrofDistPaths.map(async (path) => {
        await expect(access(new URL(path, import.meta.url))).rejects.toThrow();
      }),
    );
  });

  it("locks packed-install smoke coverage to supported Node versions and shipped entrypoints", () => {
    expect(ciWorkflow).toContain("node-version: [20.x, 22.x]");
    expect(ciWorkflow).toContain('await import("@slkiser/opencode-quota");');
    expect(ciWorkflow).toContain('await import("@slkiser/opencode-quota/server");');
    expect(ciWorkflow).toContain("./node_modules/.bin/opencode-quota --help");
    expect(ciWorkflow).toContain('grep -F "opencode-quota init"');
    expect(ciWorkflow).toContain('grep -F "opencode-quota show"');
    expect(ciWorkflow).toContain('grep -F "opencode-quota update"');
  });

  it("smoke-tests the compiled TUI package export without importing the OpenTUI runtime", () => {
    expect(ciWorkflow).toContain("@slkiser/opencode-quota/tui");
    expect(ciWorkflow).toContain('import.meta.resolve("@slkiser/opencode-quota/tui")');
    expect(ciWorkflow).toContain('readFile(tuiExportPath, "utf8")');
    expect(ciWorkflow).toContain("dist\\/tui\\.js");
    expect(ciWorkflow).not.toContain('await import("@slkiser/opencode-quota/tui")');
  });

  it("preserves tag-derived release versioning and the publish validation gates", () => {
    expect(publishWorkflow).toContain('VERSION="${TAG#v}"');
    expect(publishWorkflow).toContain(
      'pnpm version "$VERSION" --no-git-tag-version --allow-same-version',
    );
    expect(publishWorkflow).toContain("run: pnpm run verify:release-version");
    expect(publishWorkflow).toContain("run: pnpm install --frozen-lockfile");
    expect(publishWorkflow).toContain("run: pnpm run typecheck");
    expect(publishWorkflow).toContain("run: pnpm run build");
    expect(publishWorkflow).toContain("run: pnpm test");
    expect(publishWorkflow).toContain("run: npm publish --access public");
  });
});
