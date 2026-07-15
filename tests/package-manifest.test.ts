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
const packedSmoke = await readFile(
  new URL("../scripts/smoke-packed-package.mjs", import.meta.url),
  "utf8",
);

describe("package manifest compatibility", () => {
  it("requires pnpm 11+ development tooling while requiring Node 22+ at runtime", () => {
    const packageManagerMatch = pkg.packageManager?.match(/^pnpm@(\d+)\.\d+\.\d+(?:[+-].*)?$/);

    expect(packageManagerMatch).not.toBeNull();
    expect(Number(packageManagerMatch?.[1])).toBeGreaterThanOrEqual(11);
    expect(pkg.engines?.node).toBe(">=22.0.0");
    expect(pkg.devDependencies?.typescript).toBe("^5.9.3");
  });

  it("keeps plugin SDK dependencies aligned without asserting an OpenCode engine minimum", () => {
    expect(pkg.peerDependencies?.["@opencode-ai/plugin"]).toBe("^1.4.3");
    expect(pkg.devDependencies?.["@opencode-ai/plugin"]).toBe("^1.4.3");
    expect(readme).toContain("Node.js `>= 22` is required.");
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

  it("locks the complete release matrix to Node 24 build/package and Node 22/24 runtime smoke", () => {
    expect(ciWorkflow).toContain("fetch-depth: 0");
    expect(ciWorkflow).toContain("node-version: [22.x, 24.x]");
    expect(ciWorkflow).toContain("node-version: 24.x");
    expect(ciWorkflow).toContain("run: pnpm run format:check");
    expect(ciWorkflow).toContain("run: pnpm run verify:typescript-version");
    expect(ciWorkflow).toContain("run: pnpm run verify:v4-history");
    expect(ciWorkflow).toContain("run: pnpm run test:four-surfaces");
    expect(ciWorkflow).toContain("node scripts/verify-package-contents.mjs");
    expect(ciWorkflow).toContain("run: node scripts/smoke-packed-package.mjs package-artifacts");
    expect(packedSmoke).toContain('await import("@slkiser/opencode-quota");');
    expect(packedSmoke).toContain('await import("@slkiser/opencode-quota/server");');
    expect(packedSmoke).toContain('"opencode-quota init"');
    expect(packedSmoke).toContain('"opencode-quota show"');
    expect(packedSmoke).toContain('"opencode-quota update"');
  });

  it("keeps npm publication on a strict root allowlist", () => {
    expect((pkg as { files?: string[] }).files).toEqual(["dist", "README.md", "LICENSE"]);
    expect(pkg.scripts?.["verify:package-contents"]).toBe(
      "node scripts/verify-package-contents.mjs",
    );
    expect(pkg.scripts?.["verify:release-package"]).toBe("node scripts/verify-release-package.mjs");
  });

  it("smoke-tests the compiled TUI package export without importing the OpenTUI runtime", () => {
    expect(packedSmoke).toContain("@slkiser/opencode-quota/tui");
    expect(packedSmoke).toContain('import.meta.resolve("@slkiser/opencode-quota/tui")');
    expect(packedSmoke).toContain('readFile(tuiExportPath, "utf8")');
    expect(packedSmoke).toContain("dist\\\\/tui\\\\.js");
    expect(packedSmoke).not.toContain('await import("@slkiser/opencode-quota/tui")');
  });

  it("preserves tag-derived release versioning and the publish validation gates", () => {
    expect(publishWorkflow).toContain('VERSION="${TAG#v}"');
    expect(publishWorkflow).toContain(
      'pnpm version "$VERSION" --no-git-tag-version --allow-same-version',
    );
    expect(publishWorkflow).toContain("run: pnpm run verify:release-version");
    expect(publishWorkflow).toContain("run: pnpm install --frozen-lockfile");
    expect(publishWorkflow).toContain("run: pnpm run format:check");
    expect(publishWorkflow).toContain("run: pnpm run verify:typescript-version");
    expect(publishWorkflow).toContain("run: pnpm run verify:v4-history");
    expect(publishWorkflow).toContain("run: pnpm run typecheck");
    expect(publishWorkflow).toContain("run: pnpm run build");
    expect(publishWorkflow).toContain("run: pnpm test");
    expect(publishWorkflow).toContain("run: pnpm run test:four-surfaces");
    expect(publishWorkflow).toContain("run: pnpm run verify:release-package");
    expect(publishWorkflow).toContain("run: npm publish --access public");
  });
});
