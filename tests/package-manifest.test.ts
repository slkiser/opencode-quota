import { access, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  needs?: string | string[];
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
  strategy?: {
    matrix?: Record<string, unknown[]>;
  };
}

interface Workflow {
  on?: Record<string, unknown>;
  jobs: Record<string, WorkflowJob>;
}

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
  main?: string;
  bin?: Record<string, string>;
  exports?: Record<string, { default?: string; types?: string }>;
  "oc-plugin"?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  engines?: Record<string, string>;
  files?: string[];
  packageManager?: string;
  scripts?: Record<string, string>;
  pnpm?: {
    peerDependencyRules?: unknown;
    strictPeerDependencies?: boolean;
  };
};

const pnpmWorkspace = await readFile(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8");
const pnpmWorkspaceConfig = parse(pnpmWorkspace) as {
  allowBuilds?: Record<string, boolean>;
};
const tsconfig = JSON.parse(
  await readFile(new URL("../tsconfig.json", import.meta.url), "utf8"),
) as {
  compilerOptions?: { types?: string[] };
};
const typescriptValidator = await readFile(
  new URL("../scripts/verify-typescript-version.mjs", import.meta.url),
  "utf8",
);
const biomeConfig = JSON.parse(
  await readFile(new URL("../biome.json", import.meta.url), "utf8"),
) as {
  $schema?: string;
  linter?: {
    domains?: Record<string, string>;
    rules?: { recommended?: boolean };
  };
  overrides?: Array<{
    includes?: string[];
    linter?: { domains?: Record<string, string> };
  }>;
};
const lefthookConfig = parse(
  await readFile(new URL("../lefthook.yml", import.meta.url), "utf8"),
) as Record<
  "pre-commit" | "pre-push",
  {
    commands?: Record<string, { glob?: string; run?: string; stage_fixed?: boolean }>;
  }
>;
const packageScriptSources = await Promise.all(
  [
    "../scripts/pack-release-package.mjs",
    "../scripts/verify-package-contents.mjs",
    "../scripts/verify-release-package.mjs",
  ].map((path) => readFile(new URL(path, import.meta.url), "utf8")),
);
const ciWorkflow = parse(
  await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
) as Workflow;
const publishWorkflow = parse(
  await readFile(new URL("../.github/workflows/publish-npm.yml", import.meta.url), "utf8"),
) as Workflow;
const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
const packedSmoke = await readFile(
  new URL("../scripts/smoke-packed-package.mjs", import.meta.url),
  "utf8",
);
const packedRealOtelFixture = await readFile(
  new URL("../scripts/fixtures/smoke-packed-real-otel.mjs", import.meta.url),
  "utf8",
);

const VERIFY_COMMAND =
  "pnpm run check && pnpm run verify:typescript-version && pnpm run verify:v4-history && pnpm run typecheck && pnpm run build && pnpm test && pnpm run test:four-surfaces && pnpm run verify:package-contents";
const VERIFY_COMPONENT_COMMANDS = [
  "pnpm run check",
  "pnpm run verify:typescript-version",
  "pnpm run verify:v4-history",
  "pnpm run typecheck",
  "pnpm run build",
  "pnpm test",
  "pnpm run test:four-surfaces",
  "pnpm run verify:package-contents",
];

function namedStep(job: WorkflowJob, name: string): WorkflowStep {
  const step = job.steps?.find((candidate) => candidate.name === name);
  expect(step, `Missing workflow step: ${name}`).toBeDefined();
  return step as WorkflowStep;
}

function stepIndex(job: WorkflowJob, name: string): number {
  return job.steps?.findIndex((candidate) => candidate.name === name) ?? -1;
}

function expectCanonicalVerificationOnly(job: WorkflowJob): void {
  const runLines =
    job.steps?.flatMap((step) =>
      step.run
        ? step.run
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
        : [],
    ) ?? [];
  expect(runLines.filter((line) => line === "pnpm verify")).toEqual(["pnpm verify"]);
  for (const component of VERIFY_COMPONENT_COMMANDS) {
    expect(runLines).not.toContain(component);
  }
}

describe("package manifest compatibility", () => {
  it("requires pnpm 11+ development tooling while requiring Node 22+ at runtime", () => {
    const packageManagerMatch = pkg.packageManager?.match(/^pnpm@(\d+)\.\d+\.\d+(?:[+-].*)?$/);

    expect(packageManagerMatch).not.toBeNull();
    expect(Number(packageManagerMatch?.[1])).toBeGreaterThanOrEqual(11);
    expect(pkg.engines?.node).toBe(">=22.0.0");
    expect(pkg.devDependencies?.typescript).toBe("7.0.2");
    expect(pkg.devDependencies?.yaml).toBe("^2.8.3");
  });

  it("keeps the public plugin peer broad and reference-compatible development targets exact", () => {
    expect(pkg.peerDependencies?.["@opencode-ai/plugin"]).toBe("^1.4.3");
    expect(pkg.devDependencies?.["@opencode-ai/plugin"]).toBe("1.18.1");
    expect(pkg.dependencies?.["@opentui/core"]).toBe("^0.5.3");
    expect(pkg.dependencies?.["@opentui/solid"]).toBe("^0.5.3");
    expect(readme).toContain("Node.js `>= 22` is required.");
    expect(readme).not.toContain("OpenCode `>= 1.4.3`");
    expect(pkg.engines).not.toHaveProperty("opencode");
  });

  it("keeps the TypeScript 7 toolchain explicit without suppressing the known peer mismatch", () => {
    expect(tsconfig.compilerOptions?.types).toEqual(["node"]);
    expect(typescriptValidator).toContain('const EXPECTED_TYPESCRIPT_VERSION = "7.0.2";');
    expect(typescriptValidator).toContain('const EXPECTED_PLUGIN_VERSION = "1.18.1";');
    expect(typescriptValidator).toContain('const EXPECTED_OPENTUI_SPECIFIER = "^0.5.3";');
    expect(typescriptValidator).toContain('const EXPECTED_OPENTUI_VERSION = "0.5.4";');
    expect(typescriptValidator).toContain('const BUN_FFI_STRUCTS_VERSION = "0.3.1";');
    expect(typescriptValidator).toContain('const BUN_FFI_TYPESCRIPT_PEER = "^5";');
    expect(typescriptValidator).toContain("Known unmet peer:");
    expect(typescriptValidator).not.toMatch(/TypeScript v4 freeze|\^5\.9/);
    expect(pkg.pnpm?.peerDependencyRules).toBeUndefined();
    expect(pkg.pnpm?.strictPeerDependencies).not.toBe(false);
    expect(pnpmWorkspace).not.toMatch(
      /peerDependencyRules|allowedVersions|ignoreMissing|strictPeerDependencies:\s*false/,
    );
  });

  it("uses pinned Biome as the sole formatter and linter", async () => {
    expect(pkg.devDependencies?.["@biomejs/biome"]).toBe("2.3.11");
    expect(pkg.devDependencies).not.toHaveProperty("prettier");
    expect(pkg.devDependencies).not.toHaveProperty("eslint");

    expect(pkg.scripts?.format).toBe("biome format --write .");
    expect(pkg.scripts?.["format:check"]).toBe("biome format .");
    expect(pkg.scripts?.lint).toBe("biome lint .");
    expect(pkg.scripts?.check).toBe("biome check .");
    expect(pkg.scripts).not.toHaveProperty("verify:v4-formatting");

    expect(biomeConfig.$schema).toBe("https://biomejs.dev/schemas/2.3.11/schema.json");
    expect(biomeConfig.linter?.rules?.recommended).toBe(true);
    expect(biomeConfig.linter?.domains?.solid).toBe("recommended");
    expect(
      biomeConfig.overrides?.some(
        (override) =>
          override.includes?.includes("tests/**/*.test.ts") &&
          override.linter?.domains?.test === "recommended",
      ),
    ).toBe(true);

    for (const path of [
      "../.prettierignore",
      "../.prettierrc.json",
      "../scripts/verify-v4-formatting.mjs",
    ]) {
      await expect(access(new URL(path, import.meta.url))).rejects.toThrow();
    }
  });

  it("uses Lefthook for staged Biome fixes and canonical pre-push verification", async () => {
    expect(pkg.devDependencies?.lefthook).toBe("2.0.15");
    expect(pkg.devDependencies).not.toHaveProperty("husky");
    expect(pkg.devDependencies).not.toHaveProperty("lint-staged");
    expect(pkg.scripts?.prepare).toBe("lefthook install");

    expect(lefthookConfig["pre-commit"]?.commands).toEqual({
      biome: {
        glob: "**/*.{js,cjs,mjs,jsx,ts,tsx,json,jsonc,css}",
        run: "pnpm exec biome check --write --no-errors-on-unmatched {staged_files}",
        stage_fixed: true,
      },
    });
    expect(lefthookConfig["pre-push"]?.commands).toEqual({
      verify: {
        run: "pnpm verify",
      },
    });

    const packageScripts = packageScriptSources.join("\n");
    expect(packageScripts).not.toContain("HUSKY");
    expect(packageScripts).not.toContain("LEFTHOOK");

    for (const path of ["../.husky", "../.lintstagedrc"]) {
      await expect(access(new URL(path, import.meta.url))).rejects.toThrow();
    }
  });

  it("ships the OpenTelemetry API while keeping the metrics SDK host-owned", () => {
    expect(pkg.dependencies?.["@opentelemetry/api"]).toBe("^1.9.1");
    for (const dependencyType of [
      pkg.devDependencies,
      pkg.optionalDependencies,
      pkg.peerDependencies,
    ]) {
      expect(dependencyType).not.toHaveProperty("@opentelemetry/api");
    }
    expect(pkg.peerDependenciesMeta?.["@opentelemetry/api"]).toBeUndefined();

    expect(pkg.devDependencies?.["@opentelemetry/sdk-metrics"]).toBe("2.10.0");
    for (const dependencyType of [
      pkg.dependencies,
      pkg.optionalDependencies,
      pkg.peerDependencies,
    ]) {
      expect(dependencyType).not.toHaveProperty("@opentelemetry/sdk-metrics");
    }
  });

  it("hardens pnpm dependency resolution against fresh-package supply-chain attacks", () => {
    expect(pnpmWorkspace).toContain("minimumReleaseAge: 1440");
    expect(pnpmWorkspace).toContain("minimumReleaseAgeStrict: true");
    expect(pnpmWorkspace).toContain("minimumReleaseAgeIgnoreMissingTime: false");
    expect(pnpmWorkspace).toContain("blockExoticSubdeps: true");
    expect(pnpmWorkspaceConfig.allowBuilds).toEqual({
      "better-sqlite3": true,
      esbuild: true,
      lefthook: true,
      "msgpackr-extract": true,
    });
  });

  it("defines one ordered canonical repository gate and a release-only compatibility alias", () => {
    expect(pkg.scripts?.build).toContain("node scripts/clean-dist.mjs && tsc");
    expect(pkg.scripts?.verify).toBe(VERIFY_COMMAND);
    expect(pkg.scripts?.verify).not.toContain("verify:release-version");
    expect(pkg.scripts?.verify).not.toContain("verify:release-package");
    expect(pkg.scripts?.["release:check"]).toBe("pnpm verify && pnpm run verify:release-version");
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

  it("structures CI as one Node 24 pack followed by exact-artifact Node 22/24 smoke", () => {
    expect(Object.keys(ciWorkflow.jobs).sort()).toEqual(["pnpm-quality", "runtime-smoke"]);

    const quality = ciWorkflow.jobs["pnpm-quality"];
    const checkout = quality.steps?.find((step) => step.uses === "actions/checkout@v6");
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
    expect(
      quality.steps?.find((step) => step.uses === "actions/setup-node@v6")?.with?.["node-version"],
    ).toBe("24.x");

    for (const [name, run] of [
      ["Install dependencies", "pnpm install --frozen-lockfile"],
      ["Run canonical verification", "pnpm verify"],
      ["Pack and audit exact npm artifact once", "pnpm run pack:release-package package-artifacts"],
    ]) {
      expect(namedStep(quality, name).run).toBe(run);
    }

    expectCanonicalVerificationOnly(quality);
    expect(stepIndex(quality, "Run canonical verification")).toBeGreaterThan(
      stepIndex(quality, "Install dependencies"),
    );
    expect(stepIndex(quality, "Pack and audit exact npm artifact once")).toBeGreaterThan(
      stepIndex(quality, "Run canonical verification"),
    );
    expect(
      quality.steps?.filter((step) => step.run?.includes("pnpm run pack:release-package")),
    ).toHaveLength(1);

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

  it("keeps npm publication on a strict root allowlist", () => {
    expect(pkg.files).toEqual(["dist", "README.md", "LICENSE"]);
    expect(pkg.scripts?.["verify:package-contents"]).toBe(
      "node scripts/verify-package-contents.mjs",
    );
    expect(pkg.scripts?.["pack:release-package"]).toBe("node scripts/pack-release-package.mjs");
    expect(pkg.scripts?.["verify:release-package"]).toBe("node scripts/verify-release-package.mjs");
  });

  it("smoke-tests public imports, CLI commands, and the compiled TUI export", () => {
    expect(packedSmoke).toContain('await import("@slkiser/opencode-quota");');
    expect(packedSmoke).toContain('await import("@slkiser/opencode-quota/server");');
    expect(packedSmoke).toContain('"opencode-quota init"');
    expect(packedSmoke).toContain('"opencode-quota show"');
    expect(packedSmoke).toContain('"opencode-quota update"');
    expect(packedSmoke).toContain("@slkiser/opencode-quota/tui");
    expect(packedSmoke).toContain('import.meta.resolve("@slkiser/opencode-quota/tui")');
    expect(packedSmoke).toContain('readFile(tuiExportPath, "utf8")');
    expect(packedSmoke).toContain("dist\\\\/tui\\\\.js");
    expect(packedSmoke).not.toContain('await import("@slkiser/opencode-quota/tui")');
    expect(packedSmoke).toContain('const { metrics } = await import("@opentelemetry/api");');
    expect(packedSmoke).toContain('assert.equal(typeof metrics.getMeter, "function");');
    expect(packedSmoke).toContain(
      'assert.equal(pkg.dependencies?.["@opentelemetry/api"], "^1.9.1");',
    );
    expect(packedSmoke).toContain(
      '["devDependencies", "optionalDependencies", "peerDependencies"]',
    );
    expect(packedSmoke).toContain(
      'assert.equal(pkg.peerDependenciesMeta?.["@opentelemetry/api"], undefined);',
    );
    expect(packedSmoke).toContain('rootPackage.devDependencies?.["@opentelemetry/sdk-metrics"]');
    expect(packedSmoke).toContain(
      '["install", "--omit=dev", `@opentelemetry/sdk-metrics@${sdkMetricsVersion}`]',
    );
    expect(packedSmoke).toContain("smoke-packed-real-otel.mjs");
    expect(packedSmoke).toContain('"happy"');
    expect(packedSmoke).toContain('"disabled"');
    expect(packedSmoke).toContain('"no-global-provider"');
    expect(packedSmoke).toContain('"failing-infrastructure"');
    expect(packedSmoke).toContain('identity: "packed-runtime-dependency"');

    const tarballInstallIndex = packedSmoke.indexOf(
      'run("npm", ["install", "--omit=dev", tarball], workdir);',
    );
    const moduleSmokeRunIndex = packedSmoke.indexOf(
      'run(process.execPath, ["--input-type=module", "--eval", moduleSmoke], workdir);',
    );
    const sdkInstallIndex = packedSmoke.indexOf(
      "`@opentelemetry/sdk-metrics@${sdkMetricsVersion}`",
    );
    expect(tarballInstallIndex).toBeGreaterThanOrEqual(0);
    expect(moduleSmokeRunIndex).toBeGreaterThan(tarballInstallIndex);
    expect(sdkInstallIndex).toBeGreaterThan(moduleSmokeRunIndex);

    expect(packedSmoke).not.toContain("@opentelemetry/api@");
    expect(packedSmoke).not.toContain('assert.rejects(import("@opentelemetry/api"))');
    expect(packedSmoke).not.toContain('identity: "packed-absent"');
    expect(packedSmoke).not.toContain("absentOptionalDependencySmoke");
    expect(packedSmoke).not.toContain('"node_modules", "@opentelemetry", "api"');

    expect(packedRealOtelFixture).toContain("new MeterProvider({ readers: [reader] })");
    expect(packedRealOtelFixture).toContain("new PeriodicExportingMetricReader");
    expect(packedRealOtelFixture).toContain("new InMemoryMetricExporter");
    expect(packedRealOtelFixture).toContain("metrics.setGlobalMeterProvider(provider)");
    expect(packedRealOtelFixture).toContain("await provider.forceFlush()");
    expect(packedRealOtelFixture).toContain("await sdk.provider.shutdown()");
    expect(packedRealOtelFixture).toContain("buildQuotaExport");
    expect(packedRealOtelFixture).toContain("disposeQuotaTelemetryOwner");
  });

  it("publishes only a release-tag artifact after both exact-artifact smoke jobs", () => {
    expect(publishWorkflow.on).toEqual({
      release: {
        types: ["published"],
      },
    });
    expect(Object.keys(publishWorkflow.jobs).sort()).toEqual([
      "backfill-version",
      "publish",
      "release-package",
      "runtime-smoke",
    ]);

    const releasePackage = publishWorkflow.jobs["release-package"];
    const releaseCheckout = namedStep(releasePackage, "Checkout release tag");
    expect(releaseCheckout.uses).toBe("actions/checkout@v6");
    expect(releaseCheckout.with).toEqual({
      ref: "${{ github.sha }}",
      "fetch-depth": 0,
      "fetch-tags": true,
    });
    expect(
      releasePackage.steps?.find((step) => step.uses === "actions/setup-node@v6")?.with?.[
        "node-version"
      ],
    ).toBe(24);

    const orderedSteps = [
      "Assert release ref, tag, and commit match",
      "Sync package version from release tag",
      "Verify package version matches release tag",
      "Install dependencies",
      "Run canonical verification",
      "Pack and audit the release artifact once",
      "Upload exact release artifact",
    ];
    for (const name of orderedSteps) {
      expect(
        stepIndex(releasePackage, name),
        `Missing ordered release step: ${name}`,
      ).toBeGreaterThanOrEqual(0);
    }
    for (let index = 1; index < orderedSteps.length; index += 1) {
      expect(stepIndex(releasePackage, orderedSteps[index])).toBeGreaterThan(
        stepIndex(releasePackage, orderedSteps[index - 1]),
      );
    }

    expect(namedStep(releasePackage, "Sync package version from release tag").run).toContain(
      'pnpm version "$VERSION" --no-git-tag-version --allow-same-version',
    );
    expect(namedStep(releasePackage, "Verify package version matches release tag").run).toBe(
      "pnpm run verify:release-version",
    );
    expect(namedStep(releasePackage, "Run canonical verification").run).toBe("pnpm verify");
    expectCanonicalVerificationOnly(releasePackage);
    expect(namedStep(releasePackage, "Pack and audit the release artifact once").run).toBe(
      "pnpm run pack:release-package package-artifacts",
    );
    expect(
      releasePackage.steps?.filter((step) => step.run?.includes("pnpm run pack:release-package")),
    ).toHaveLength(1);
    expect(namedStep(releasePackage, "Upload exact release artifact").with).toEqual({
      name: "release-package",
      path: "package-artifacts/*",
      "if-no-files-found": "error",
    });

    const smoke = publishWorkflow.jobs["runtime-smoke"];
    expect(smoke.needs).toBe("release-package");
    expect(smoke.strategy?.matrix?.["node-version"]).toEqual(["22.x", "24.x"]);
    expect(namedStep(smoke, "Download exact release artifact").with).toEqual({
      name: "release-package",
      path: "package-artifacts",
    });
    expect(
      namedStep(smoke, "Smoke exact release artifact on Node ${{ matrix.node-version }}").run,
    ).toBe("node scripts/smoke-packed-package.mjs package-artifacts");

    const publish = publishWorkflow.jobs.publish;
    expect(publish.needs).toEqual(["release-package", "runtime-smoke"]);
    expect(publish.permissions).toEqual({
      contents: "read",
      "id-token": "write",
    });
    expect(namedStep(publish, "Download exact release artifact").with).toEqual({
      name: "release-package",
      path: "package-artifacts",
    });
    const publishRun = namedStep(publish, "Verify and publish exact release artifact").run ?? "";
    expect(publishRun).toContain("node scripts/verify-release-artifact.mjs package-artifacts");
    expect(publishRun).toContain(
      'npm publish "./${TARBALLS[0]}" --access public --provenance --ignore-scripts',
    );
    expect(publishRun).not.toContain(
      'npm publish "${TARBALLS[0]}" --access public --provenance --ignore-scripts',
    );
    expect(publishRun).not.toContain("pnpm pack");
    expect(publishRun).not.toContain("pnpm run build");

    const backfill = publishWorkflow.jobs["backfill-version"];
    for (const job of [releasePackage, smoke, publish, backfill]) {
      const checkouts = job.steps?.filter((step) => step.uses === "actions/checkout@v6") ?? [];
      expect(checkouts.length).toBeGreaterThan(0);
      for (const checkout of checkouts) {
        expect(checkout.with?.ref).toBe("${{ github.sha }}");
      }
    }

    const releaseIdentityRun =
      namedStep(releasePackage, "Assert release ref, tag, and commit match").run ?? "";
    expect(releaseIdentityRun).toContain('CHECKED_OUT_SHA="$(git rev-parse HEAD)"');
    expect(releaseIdentityRun).toContain('TAG_SHA="$(git rev-parse "$RELEASE_TAG^{commit}")"');

    expect(backfill.needs).toBe("publish");
    expect(backfill.permissions).toEqual({ contents: "write" });
    expect(namedStep(backfill, "Sync and verify version for repository backfill").run).toContain(
      "pnpm run verify:release-version",
    );
    expect(namedStep(backfill, "Commit synced version back to repository").run).toContain(
      'git push origin HEAD:"$BRANCH"',
    );
  });
});
