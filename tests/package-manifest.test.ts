import { describe, expect, it } from "vitest";
import { access, readFile } from "node:fs/promises";

const pkg = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
) as {
  main?: string;
  bin?: Record<string, string>;
  exports?: Record<string, { default?: string; types?: string }>;
  "oc-plugin"?: string[];
  dependencies?: Record<string, string>;
  engines?: Record<string, string>;
  packageManager?: string;
  scripts?: Record<string, string>;
};

const pnpmWorkspace = await readFile(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8");
const ciWorkflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

describe("package manifest compatibility", () => {
  it("requires pnpm 11+ development tooling while requiring Node 20+ at runtime", () => {
    const packageManagerMatch = pkg.packageManager?.match(/^pnpm@(\d+)\.\d+\.\d+(?:[+-].*)?$/);

    expect(packageManagerMatch).not.toBeNull();
    expect(Number(packageManagerMatch?.[1])).toBeGreaterThanOrEqual(11);
    expect(pkg.engines?.node).toBe(">=20.0.0");
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
      default: "./dist/tui.tsx",
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

  it("smoke-tests the TUI package export by resolving and reading it, not importing raw TSX", () => {
    expect(ciWorkflow).toContain("@slkiser/opencode-quota/tui");
    expect(ciWorkflow).toContain('import.meta.resolve("@slkiser/opencode-quota/tui")');
    expect(ciWorkflow).toContain('readFile(tuiExportPath, "utf8")');
    expect(ciWorkflow).not.toContain('await import("@slkiser/opencode-quota/tui")');
  });
});
