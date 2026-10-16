import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";
import { parse } from "yaml";

interface WorkflowStep {
  id?: string;
  name?: string;
  env?: Record<string, string>;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  "runs-on"?: string;
  if?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
  strategy?: { matrix?: Record<string, unknown[]> };
}

interface Workflow {
  on?: Record<string, unknown>;
  jobs: Record<string, WorkflowJob>;
}

const text = (path: string) => readFile(new URL(path, import.meta.url), "utf8");
const pkg = JSON.parse(await text("../package.json"));
const pnpmWorkspace = await text("../pnpm-workspace.yaml");
const tsconfig = JSON.parse(await text("../tsconfig.json"));
const viteConfig = await text("../vite.config.ts");
const lefthookConfig = parse(await text("../lefthook.yml"));
const ciWorkflow = parse(await text("../.github/workflows/ci.yml")) as Workflow;
const publishWorkflow = parse(await text("../.github/workflows/publish-npm.yml")) as Workflow;
const packedSmoke = await text("../scripts/smoke-packed-package.mjs");

// Pinned to a commit; Vite+ installs the pnpm named in package.json `packageManager`.
const SETUP_VP = "voidzero-dev/setup-vp@68f39c78aaf39be468cabd2afb09c162574c84af";

// The build's `tsc` is the type check, and `pnpm test` runs the cross-surface test.
const VERIFY_COMMAND =
  "pnpm run check && pnpm run verify:typescript-version && pnpm run verify:v4-history && pnpm run build && pnpm test && pnpm run verify:package-contents";

function namedStep(job: WorkflowJob, name: string): WorkflowStep {
  const step = job.steps?.find((candidate) => candidate.name === name);
  expect(step, `Missing workflow step: ${name}`).toBeDefined();
  return step as WorkflowStep;
}

function usesStep(job: WorkflowJob, action: string): WorkflowStep | undefined {
  return job.steps?.find((step) => step.uses === action);
}

/** Every named step exists, in this order. */
function expectOrdered(job: WorkflowJob, names: string[]): void {
  const indexes = names.map((name) => job.steps?.findIndex((step) => step.name === name) ?? -1);
  expect(
    indexes.every((index) => index >= 0),
    `Missing one of: ${names.join(", ")}`,
  ).toBe(true);
  expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
}

/** `pnpm verify` runs exactly once, and none of the commands it already runs is repeated. */
function expectCanonicalVerificationOnly(job: WorkflowJob): void {
  const runLines =
    job.steps?.flatMap((step) =>
      (step.run ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    ) ?? [];
  expect(runLines.filter((line) => line === "pnpm verify")).toEqual(["pnpm verify"]);
  for (const component of VERIFY_COMMAND.split(" && ")) {
    expect(runLines).not.toContain(component);
  }
}

function expectSinglePack(job: WorkflowJob): void {
  const packs = job.steps?.filter((step) => step.run?.includes("pnpm run pack:release-package"));
  expect(packs).toHaveLength(1);
}

describe("package manifest compatibility", () => {
  it("pins the runtime, toolchain, entrypoints and published files in package.json", () => {
    const pnpmMajor = String(pkg.packageManager).match(/^pnpm@(\d+)\.\d+\.\d+(?:[+-].*)?$/)?.[1];
    expect(Number(pnpmMajor)).toBeGreaterThanOrEqual(11);
    expect(pkg.scripts?.build).toContain("node scripts/clean-dist.mjs && tsc");
    expect(pkg.pnpm?.strictPeerDependencies).not.toBe(false);

    const entry = (main: string) => ({
      default: `./dist/${main}.js`,
      types: `./dist/${main}.d.ts`,
    });
    const expected: Array<[section: string, key: string | null, value: unknown]> = [
      ["engines", "node", "^22.13.0 || >=23.4.0"],
      ["engines", "opencode", undefined],
      ["devDependencies", "typescript", "7.0.2"],
      ["devDependencies", "yaml", "^2.8.3"],
      ["peerDependencies", "@opencode/plugin", "2.0.28"],
      ["devDependencies", "@opencode/plugin", "2.0.28"],
      ["dependencies", "@opentui/core", "^0.5.10"],
      ["dependencies", "@opentui/solid", "^0.5.10"],
      ["pnpm", "peerDependencyRules", undefined],
      // Vite+ is the only formatter and linter; Lefthook the only hook runner.
      ["devDependencies", "vite-plus", "1.2.0"],
      ["devDependencies", "@biomejs/biome", undefined],
      ["devDependencies", "prettier", undefined],
      ["devDependencies", "eslint", undefined],
      ["devDependencies", "oxlint", undefined],
      ["scripts", "format", "vp fmt"],
      ["scripts", "format:check", undefined],
      ["scripts", "lint", "vp lint"],
      ["scripts", "check", "vp check"],
      // Vite+ runs the tests too (Vitest 5 inside vite-plus); no separate Vitest.
      ["devDependencies", "vitest", undefined],
      ["scripts", "test", "vp test run"],
      ["scripts", "test:watch", "vp test watch"],
      ["scripts", "verify:v4-formatting", undefined],
      ["devDependencies", "lefthook", "2.0.15"],
      ["devDependencies", "husky", undefined],
      ["devDependencies", "lint-staged", undefined],
      ["scripts", "prepare", "lefthook install"],
      // The OpenTelemetry API ships; the metrics SDK stays host-owned.
      ["optionalDependencies", null, undefined],
      ["dependencies", "@opentelemetry/api", "^1.9.1"],
      ["devDependencies", "@opentelemetry/api", undefined],
      ["peerDependencies", "@opentelemetry/api", undefined],
      ["peerDependenciesMeta", "@opentelemetry/api", undefined],
      ["devDependencies", "@opentelemetry/sdk-metrics", "2.10.0"],
      ["dependencies", "@opentelemetry/sdk-metrics", undefined],
      ["peerDependencies", "@opentelemetry/sdk-metrics", undefined],
      // One ordered repository gate, and a release-only alias on top of it.
      ["scripts", "verify", VERIFY_COMMAND],
      ["scripts", "release:check", "pnpm verify && pnpm run verify:release-version"],
      ["scripts", "build:check", undefined],
      ["scripts", "test:four-surfaces", undefined],
      // `pnpm run upstream:prepare-review` still runs the standalone type check.
      ["scripts", "typecheck", "tsc --noEmit"],
      ["main", null, "./dist/index.js"],
      ["bin", null, { "opencode-quota": "./dist/bin/opencode-quota.js" }],
      ["oc-plugin", null, undefined],
      ["exports", ".", entry("index")],
      ["exports", "./server", entry("index")],
      ["exports", "./tui", entry("tui")],
      ["files", null, ["dist", "README.md", "LICENSE"]],
      ["scripts", "verify:package-contents", "node scripts/verify-package-contents.mjs"],
      ["scripts", "pack:release-package", "node scripts/pack-release-package.mjs"],
      ["scripts", "verify:release-package", "node scripts/verify-release-package.mjs"],
    ];
    for (const [section, key, value] of expected) {
      const actual = key === null ? pkg[section] : pkg[section]?.[key];
      expect(actual, `package.json ${section} ${key ?? ""}`).toEqual(value);
    }
  });

  it("keeps the tool configs the gates rely on, and none of the removed tools", async () => {
    expect(tsconfig.compilerOptions?.types).toEqual(["node"]);
    expect(viteConfig).toContain('import { defineConfig } from "vite-plus";');
    expect(viteConfig).toContain('categories: { correctness: "error" }');
    // The build's tsc, on the pinned TypeScript, is the only type check.
    expect(viteConfig).not.toMatch(/typeAware|typeCheck/);
    expect(lefthookConfig["pre-commit"]?.commands).toEqual({
      check: {
        glob: "**/*.{js,cjs,mjs,jsx,ts,tsx,json,jsonc,css}",
        run: "pnpm exec vp check --fix --no-error-on-unmatched-pattern {staged_files}",
        stage_fixed: true,
      },
    });
    expect(lefthookConfig["pre-push"]?.commands).toEqual({ verify: { run: "pnpm verify" } });
    // Hardens dependency resolution against fresh-package supply-chain attacks.
    expect(parse(pnpmWorkspace).allowBuilds).toEqual({
      esbuild: true,
      lefthook: true,
      "msgpackr-extract": true,
      protobufjs: false,
    });

    const staleCrof = ["lib/crof-config", "lib/crof", "providers/crof"].flatMap((base) =>
      [".d.ts", ".d.ts.map", ".js", ".js.map"].map((ext) => `../dist/${base}${ext}`),
    );
    const removed = [
      "../.prettierignore",
      "../.prettierrc.json",
      "../scripts/verify-v4-formatting.mjs",
      "../.husky",
      "../.lintstagedrc",
      "../biome.json",
      "../vitest.config.ts",
      ...staleCrof,
    ];
    for (const path of removed) {
      await expect(access(new URL(path, import.meta.url)), path).rejects.toThrow();
    }
  });

  it.each([
    [
      "the TypeScript version check (peer mismatch reported, not suppressed)",
      "../scripts/verify-typescript-version.mjs",
      [
        'const EXPECTED_TYPESCRIPT_VERSION = "7.0.2";',
        'const EXPECTED_PLUGIN_VERSION = "2.0.28";',
        'const EXPECTED_OPENTUI_SPECIFIER = "^0.5.10";',
        'const EXPECTED_OPENTUI_VERSION = "0.5.10";',
        'const BUN_FFI_STRUCTS_VERSION = "0.3.1";',
        'const BUN_FFI_TYPESCRIPT_PEER = "^5";',
        "Known unmet peer:",
      ],
      [/TypeScript v4 freeze|\^5\.9/],
    ],
    [
      "pnpm-workspace.yaml",
      "../pnpm-workspace.yaml",
      [
        "minimumReleaseAge: 1440",
        "minimumReleaseAgeStrict: true",
        "minimumReleaseAgeIgnoreMissingTime: false",
        "blockExoticSubdeps: true",
        "vite@*: npm:@voidzero-dev/vite-plus-core@1.2.0",
      ],
      [
        /peerDependencyRules|allowedVersions|ignoreMissing|strictPeerDependencies:\s*false/,
        /minimumReleaseAgeExclude/,
      ],
    ],
    ["the README", "../README.md", ["Node.js `22.13+` or `23.4+`"], ["OpenCode `>= 1.4.3`"]],
    ["the pack script", "../scripts/pack-release-package.mjs", [], ["HUSKY", "LEFTHOOK"]],
    ["the contents check", "../scripts/verify-package-contents.mjs", [], ["HUSKY", "LEFTHOOK"]],
    ["the release check", "../scripts/verify-release-package.mjs", [], ["HUSKY", "LEFTHOOK"]],
    [
      "the packed-package smoke (public imports, CLI, compiled TUI, OpenTelemetry)",
      "../scripts/smoke-packed-package.mjs",
      [
        'await import("@slkiser/opencode-quota");',
        'await import("@slkiser/opencode-quota/server");',
        '"opencode-quota show"',
        '"opencode-quota status"',
        "@slkiser/opencode-quota/tui",
        'import.meta.resolve("@slkiser/opencode-quota/tui")',
        'readFile(tuiExportPath, "utf8")',
        "dist\\\\/tui\\\\.js",
        'const { metrics } = await import("@opentelemetry/api");',
        'assert.equal(typeof metrics.getMeter, "function");',
        'assert.equal(pkg.dependencies?.["@opentelemetry/api"], "^1.9.1");',
        '["devDependencies", "optionalDependencies", "peerDependencies"]',
        'assert.equal(pkg.peerDependenciesMeta?.["@opentelemetry/api"], undefined);',
        'rootPackage.devDependencies?.["@opentelemetry/sdk-metrics"]',
        '["install", "--omit=dev", `@opentelemetry/sdk-metrics@${sdkMetricsVersion}`]',
        "smoke-packed-real-otel.mjs",
        '"happy"',
        '"disabled"',
        '"no-global-provider"',
        '"failing-infrastructure"',
        'identity: "packed-runtime-dependency"',
      ],
      [
        '"opencode-quota init"',
        '"opencode-quota update"',
        'await import("@slkiser/opencode-quota/tui")',
        "@opentelemetry/api@",
        'assert.rejects(import("@opentelemetry/api"))',
        'identity: "packed-absent"',
        "absentOptionalDependencySmoke",
        '"node_modules", "@opentelemetry", "api"',
      ],
    ],
    [
      "the real OpenTelemetry smoke fixture",
      "../scripts/fixtures/smoke-packed-real-otel.mjs",
      [
        "new MeterProvider({ readers: [reader] })",
        "new PeriodicExportingMetricReader",
        "new InMemoryMetricExporter",
        "metrics.setGlobalMeterProvider(provider)",
        "await provider.forceFlush()",
        "await sdk.provider.shutdown()",
        "buildQuotaExport",
        "disposeQuotaTelemetryOwner",
      ],
      [],
    ],
  ])(
    "keeps %s",
    async (_name, path, has: Array<string | RegExp>, lacks: Array<string | RegExp>) => {
      const source = await text(path);
      for (const pattern of has) expect(source).toMatch(pattern);
      for (const pattern of lacks) expect(source).not.toMatch(pattern);
    },
  );

  it("smokes the packed package after installing it, then installs the metrics SDK", () => {
    const tarballInstall = packedSmoke.indexOf(
      'run("npm", ["install", "--omit=dev", tarball], workdir);',
    );
    const moduleSmoke = packedSmoke.indexOf(
      'run(process.execPath, ["--input-type=module", "--eval", moduleSmoke], workdir);',
    );
    const sdkInstall = packedSmoke.indexOf("`@opentelemetry/sdk-metrics@${sdkMetricsVersion}`");
    expect(tarballInstall).toBeGreaterThanOrEqual(0);
    expect(moduleSmoke).toBeGreaterThan(tarballInstall);
    expect(sdkInstall).toBeGreaterThan(moduleSmoke);
  });

  it("runs canonical verification on Ubuntu and Windows before exact-artifact smoke", () => {
    expect(Object.keys(ciWorkflow.jobs).sort()).toEqual([
      "pnpm-quality",
      "runtime-smoke",
      "windows-verify",
    ]);
    const quality = ciWorkflow.jobs["pnpm-quality"];
    const windows = ciWorkflow.jobs["windows-verify"];
    expect(windows["runs-on"]).toBe("windows-latest");
    for (const job of [quality, windows]) {
      expect(usesStep(job, "actions/checkout@v6")?.with?.["fetch-depth"]).toBe(0);
      expect(usesStep(job, "actions/setup-node@v6")?.with?.["node-version"]).toBe("24.x");
      expect(namedStep(job, "Install dependencies")).toEqual(
        expect.objectContaining({
          uses: SETUP_VP,
          with: {
            "node-manager": false,
            cache: true,
            "run-install": 'args: ["--frozen-lockfile"]\n',
          },
        }),
      );
      expect(job.steps?.some((step) => step.run?.includes("corepack"))).toBe(false);
      expect(namedStep(job, "Run canonical verification").run).toBe("pnpm verify");
      expectCanonicalVerificationOnly(job);
    }

    const pack = "Pack and audit exact npm artifact once";
    expect(namedStep(quality, pack).run).toBe("pnpm run pack:release-package package-artifacts");
    expectOrdered(quality, ["Install dependencies", "Run canonical verification", pack]);
    expectSinglePack(quality);
    expect(namedStep(quality, "Upload exact npm artifact")).toEqual(
      expect.objectContaining({
        uses: "actions/upload-artifact@v7",
        with: expect.objectContaining({
          name: "package-tarball",
          path: "package-artifacts/*",
          "if-no-files-found": "error",
        }),
      }),
    );

    const smoke = ciWorkflow.jobs["runtime-smoke"];
    expect(smoke.needs).toBe("pnpm-quality");
    expect(smoke.strategy?.matrix?.["node-version"]).toEqual(["22.x", "24.x"]);
    expect(namedStep(smoke, "Download exact npm artifact").with).toEqual({
      name: "package-tarball",
      path: "package-artifacts",
    });
    expect(
      namedStep(smoke, "Smoke exact npm artifact on Node ${{ matrix.node-version }}").run,
    ).toBe("node scripts/smoke-packed-package.mjs package-artifacts");
  });

  it("publishes only a release-tag artifact after both exact-artifact smoke jobs", () => {
    expect(publishWorkflow.on).toEqual({ release: { types: ["published"] } });
    expect(Object.keys(publishWorkflow.jobs).sort()).toEqual([
      "backfill-version",
      "point-next-at-stable",
      "publish",
      "release-package",
      "runtime-smoke",
    ]);
    const releasePackage = publishWorkflow.jobs["release-package"];
    const smoke = publishWorkflow.jobs["runtime-smoke"];
    const publish = publishWorkflow.jobs.publish;
    const backfill = publishWorkflow.jobs["backfill-version"];
    const artifact = { name: "release-package", path: "package-artifacts" };

    const checkout = namedStep(releasePackage, "Checkout release tag");
    expect(checkout.uses).toBe("actions/checkout@v6");
    expect(checkout.with).toEqual({
      ref: "${{ github.sha }}",
      "fetch-depth": 0,
      "fetch-tags": true,
    });
    expect(usesStep(releasePackage, "actions/setup-node@v6")?.with?.["node-version"]).toBe(24);
    expectOrdered(releasePackage, [
      "Assert release ref, tag, and commit match",
      "Sync package version from release tag",
      "Verify package version matches release tag",
      "Install dependencies",
      "Run canonical verification",
      "Pack and audit the release artifact once",
      "Upload exact release artifact",
    ]);
    const identityRun = namedStep(releasePackage, "Assert release ref, tag, and commit match").run;
    expect(identityRun).toContain('CHECKED_OUT_SHA="$(git rev-parse HEAD)"');
    expect(identityRun).toContain('TAG_SHA="$(git rev-parse "$RELEASE_TAG^{commit}")"');
    expect(namedStep(releasePackage, "Sync package version from release tag").run).toContain(
      'pnpm version "$VERSION" --no-git-tag-version --allow-same-version',
    );
    for (const [name, run] of [
      ["Verify package version matches release tag", "pnpm run verify:release-version"],
      ["Run canonical verification", "pnpm verify"],
      [
        "Pack and audit the release artifact once",
        "pnpm run pack:release-package package-artifacts",
      ],
    ]) {
      expect(namedStep(releasePackage, name).run).toBe(run);
    }
    expectCanonicalVerificationOnly(releasePackage);
    expectSinglePack(releasePackage);
    expect(namedStep(releasePackage, "Upload exact release artifact").with).toEqual({
      name: "release-package",
      path: "package-artifacts/*",
      "if-no-files-found": "error",
    });

    expect(smoke.needs).toBe("release-package");
    expect(smoke.strategy?.matrix?.["node-version"]).toEqual(["22.x", "24.x"]);
    expect(namedStep(smoke, "Download exact release artifact").with).toEqual(artifact);
    expect(
      namedStep(smoke, "Smoke exact release artifact on Node ${{ matrix.node-version }}").run,
    ).toBe("node scripts/smoke-packed-package.mjs package-artifacts");

    expect(publish.needs).toEqual(["release-package", "runtime-smoke"]);
    expect(publish.permissions).toEqual({ contents: "read", "id-token": "write" });
    expect(namedStep(publish, "Download exact release artifact").with).toEqual(artifact);
    expectOrdered(publish, ["Choose npm dist-tag", "Verify and publish exact release artifact"]);
    const publishStep = namedStep(publish, "Verify and publish exact release artifact");
    expect(publishStep.env).toEqual({ DIST_TAG: "${{ steps.dist-tag.outputs.dist-tag }}" });
    const publishRun = publishStep.run ?? "";
    expect(publishRun).toContain("node scripts/verify-release-artifact.mjs package-artifacts");
    expect(publishRun).toContain(
      'npm publish "./${TARBALLS[0]}" --tag "$DIST_TAG" --access public --provenance --ignore-scripts',
    );
    for (const forbidden of ['npm publish "${TARBALLS[0]}"', "pnpm pack", "pnpm run build"]) {
      expect(publishRun).not.toContain(forbidden);
    }

    for (const job of [releasePackage, smoke, publish, backfill]) {
      const checkouts = job.steps?.filter((step) => step.uses === "actions/checkout@v6") ?? [];
      expect(checkouts.length).toBeGreaterThan(0);
      for (const step of checkouts) expect(step.with?.ref).toBe("${{ github.sha }}");
    }

    expect(backfill.needs).toBe("publish");
    expect(backfill.permissions).toEqual({ contents: "write" });
    expect(namedStep(backfill, "Sync and verify version for repository backfill").run).toContain(
      "pnpm run verify:release-version",
    );
    const backfillRun = namedStep(backfill, "Commit synced version back to repository").run ?? "";
    expect(backfillRun).toContain('git push origin HEAD:"$BRANCH"');
    // A beta targets the v5 branch; never write its version onto a branch without the release commit.
    const ancestryCheck = backfillRun.indexOf(
      'git merge-base --is-ancestor "$GITHUB_SHA" "origin/$BRANCH"',
    );
    expect(ancestryCheck).toBeGreaterThanOrEqual(0);
    expect(ancestryCheck).toBeLessThan(backfillRun.indexOf("git commit"));
  });

  it.each([
    ["v5.0.0-beta.1", "true", "next"],
    ["v5.0.0-beta.1", "false", "next"],
    ["v5.0.0", "true", "next"],
    ["v5.0.0", "false", "latest"],
  ])("publishes %s (prerelease %s) to the npm %s tag", (tag, prerelease, distTag) => {
    const chooseTag = namedStep(publishWorkflow.jobs.publish, "Choose npm dist-tag");
    expect(chooseTag.id).toBe("dist-tag");
    expect(chooseTag.env).toEqual({
      RELEASE_TAG: "${{ github.event.release.tag_name }}",
      RELEASE_PRERELEASE: "${{ github.event.release.prerelease }}",
    });

    const dir = mkdtempSync(join(tmpdir(), "opencode-quota-dist-tag-"));
    try {
      const output = join(dir, "github-output");
      const env = { RELEASE_TAG: tag, RELEASE_PRERELEASE: prerelease, GITHUB_OUTPUT: output };
      execFileSync("bash", ["-e", "-c", chooseTag.run ?? "exit 1"], {
        env: { ...process.env, ...env },
        stdio: "ignore",
      });
      expect(readFileSync(output, "utf8")).toBe(`dist-tag=${distTag}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("points next at each stable release unless next is already newer", () => {
    const job = publishWorkflow.jobs["point-next-at-stable"];
    expect(job.needs).toBe("publish");
    expect(job.if).toBe(
      "${{ !github.event.release.prerelease && !contains(github.event.release.tag_name, '-') }}",
    );
    expect(job.permissions).toEqual({ contents: "read", "id-token": "write" });
    const step = namedStep(job, "Point next at the new stable version");

    // Stand-in npm and npx log their arguments; npx answers the semver check from NEXT_IS_NEWER.
    const commandsFor = (currentNext: string, nextIsNewer: boolean): string[] => {
      const dir = mkdtempSync(join(tmpdir(), "opencode-quota-next-tag-"));
      try {
        const log = join(dir, "commands");
        writeFileSync(log, "");
        writeFileSync(
          join(dir, "npm"),
          `#!/bin/sh\necho "npm $*" >> "${log}"\necho "${currentNext}"\n`,
        );
        writeFileSync(
          join(dir, "npx"),
          `#!/bin/sh\necho "npx $*" >> "${log}"\ncase "$*" in *"semver@7 0.0.0") ;; *semver@*) [ "$NEXT_IS_NEWER" = 1 ];; esac\n`,
        );
        chmodSync(join(dir, "npm"), 0o755);
        chmodSync(join(dir, "npx"), 0o755);
        execFileSync("bash", ["-e", "-c", step.run ?? "exit 1"], {
          env: {
            ...process.env,
            ...step.env,
            RELEASE_TAG: "v5.0.2",
            NEXT_IS_NEWER: nextIsNewer ? "1" : "0",
            PATH: `${dir}:${process.env.PATH}`,
          },
          stdio: "ignore",
        });
        return readFileSync(log, "utf8").trim().split("\n");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    expect(commandsFor("5.0.1", false)).toEqual([
      "npm view @slkiser/opencode-quota dist-tags.next",
      "npx --yes semver@7 0.0.0",
      "npx --yes semver@7 --include-prerelease --range >5.0.2 5.0.1",
      "npx --yes npm@^11.21.0 dist-tag add @slkiser/opencode-quota@5.0.2 next",
    ]);
    expect(commandsFor("5.1.0-beta.1", true)).toEqual([
      "npm view @slkiser/opencode-quota dist-tags.next",
      "npx --yes semver@7 0.0.0",
      "npx --yes semver@7 --include-prerelease --range >5.0.2 5.1.0-beta.1",
    ]);
  });
});
