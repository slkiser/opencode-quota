import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { verifyReleaseArtifact } from "./lib/release-artifact.mjs";

const inputPath = path.resolve(process.argv[2] ?? "package-artifacts");
const nodeMajor = Number(process.versions.node.split(".")[0]);

if (nodeMajor !== 22 && nodeMajor !== 24) {
  console.error(
    `Packed runtime smoke requires Node 22 or 24; received Node ${process.versions.node}.`,
  );
  process.exit(1);
}

function run(command, args, cwd, options = {}) {
  const { env: optionEnv, ...spawnOptions } = options;
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_cache: path.join(cwd, ".npm-cache"),
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
      ...optionEnv,
    },
    ...spawnOptions,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }

  return result.stdout;
}

const artifact = await verifyReleaseArtifact(inputPath);
const tarball = artifact.tarballPath;
const rootPackage = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const sdkMetricsVersion = rootPackage.devDependencies?.["@opentelemetry/sdk-metrics"];
if (!/^\d+\.\d+\.\d+$/.test(sdkMetricsVersion ?? "")) {
  throw new Error("Expected an exact development-only @opentelemetry/sdk-metrics version.");
}
const workdir = await mkdtemp(path.join(tmpdir(), "opencode-quota-package-smoke-"));

try {
  run("npm", ["init", "-y"], workdir);
  run("npm", ["install", "--omit=dev", tarball], workdir);

  const moduleSmoke = `
    import assert from "node:assert/strict";
    import { readFile } from "node:fs/promises";
    import path from "node:path";
    import { fileURLToPath, pathToFileURL } from "node:url";

    const rootExportUrl = import.meta.resolve("@slkiser/opencode-quota");
    await import("@slkiser/opencode-quota");
    await import("@slkiser/opencode-quota/server");
    const { metrics } = await import("@opentelemetry/api");
    assert.equal(typeof metrics.getMeter, "function");

    const tuiExportUrl = import.meta.resolve("@slkiser/opencode-quota/tui");
    const tuiExportPath = fileURLToPath(tuiExportUrl);
    assert.match(tuiExportPath, /node_modules\\/\\@slkiser\\/opencode-quota\\/dist\\/tui\\.js$/);
    const tuiSource = await readFile(tuiExportPath, "utf8");
    assert.ok(tuiSource.includes("@slkiser/opencode-quota"));
    assert.ok(tuiSource.includes("const pluginModule"));
    assert.ok(tuiSource.includes("tui"));
    assert.ok(!tuiSource.includes("jsx-dev-runtime"));

    const pkg = JSON.parse(
      await readFile("node_modules/@slkiser/opencode-quota/package.json", "utf8"),
    );
    assert.equal(pkg.engines?.node, ">=22.0.0");
    assert.equal(pkg.dependencies?.["@opentelemetry/api"], "^1.9.1");
    for (const dependencyType of ["devDependencies", "optionalDependencies", "peerDependencies"]) {
      assert.equal(pkg[dependencyType]?.["@opentelemetry/api"], undefined);
    }
    assert.equal(pkg.peerDependenciesMeta?.["@opentelemetry/api"], undefined);
    for (const dependencyType of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      assert.equal(pkg[dependencyType]?.["@opentelemetry/sdk-metrics"], undefined);
    }

    const packageRoot = path.resolve(path.dirname(fileURLToPath(rootExportUrl)), "..");
    const telemetry = await import(
      pathToFileURL(path.join(packageRoot, "dist", "lib", "quota-telemetry.js"))
    );
    assert.ok(
      telemetry.configureQuotaTelemetry({
        owner: {},
        enabled: true,
        identity: "packed-runtime-dependency",
      }),
    );
    await telemetry.__flushQuotaTelemetryInitializationForTests();
  `;

  run(process.execPath, ["--input-type=module", "--eval", moduleSmoke], workdir);

  run("npm", ["install", "--omit=dev", `@opentelemetry/sdk-metrics@${sdkMetricsVersion}`], workdir);

  const realOtelFixture = path.join(workdir, "smoke-packed-real-otel.mjs");
  await copyFile(
    new URL("./fixtures/smoke-packed-real-otel.mjs", import.meta.url),
    realOtelFixture,
  );
  const isolatedRuntimeEnv = {
    XDG_CACHE_HOME: path.join(workdir, "runtime", "cache"),
    XDG_CONFIG_HOME: path.join(workdir, "runtime", "config"),
    XDG_DATA_HOME: path.join(workdir, "runtime", "data"),
    XDG_STATE_HOME: path.join(workdir, "runtime", "state"),
  };
  for (const scenario of ["happy", "disabled", "no-global-provider", "failing-infrastructure"]) {
    run(process.execPath, [realOtelFixture, scenario], workdir, { env: isolatedRuntimeEnv });
  }

  const openRouterSecret = "packed-openrouter-secret-canary";
  const openRouterEnv = { ...isolatedRuntimeEnv, OPENROUTER_API_KEY: openRouterSecret };
  run(process.execPath, [realOtelFixture, "seed-production-openrouter"], workdir, {
    env: openRouterEnv,
  });

  const cliPath = path.join(
    workdir,
    "node_modules",
    "@slkiser",
    "opencode-quota",
    "dist",
    "bin",
    "opencode-quota.js",
  );
  const cliOutput = run(process.execPath, [cliPath, "--help"], workdir);
  for (const expected of [
    "Usage:",
    "opencode-quota init",
    "opencode-quota show",
    "opencode-quota update",
  ]) {
    if (!cliOutput.includes(expected)) {
      throw new Error(`Packed CLI help is missing: ${expected}`);
    }
  }

  const cachedOpenRouterOutput = run(
    process.execPath,
    [cliPath, "show", "--json", "--provider", "openrouter"],
    workdir,
    { env: openRouterEnv },
  );
  const cachedOpenRouter = JSON.parse(cachedOpenRouterOutput);
  assert.equal(cachedOpenRouter.fromCache, true);
  assert.equal(cachedOpenRouter.providers.openrouter.status, "ok");
  assert.equal(
    cachedOpenRouter.providers.openrouter.entries[0].name,
    "Packed production OpenRouter",
  );
  assert.equal(cachedOpenRouter.providers.openrouter.entries[0].percentRemaining, 67);

  const readTree = async (directory) => {
    const chunks = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) chunks.push(...(await readTree(target)));
      else if (entry.isFile()) chunks.push(await readFile(target, "utf8"));
    }
    return chunks;
  };
  const privateArtifacts = [
    cachedOpenRouterOutput,
    ...(await readTree(path.join(workdir, "runtime"))),
  ].join("\n");
  assert.ok(!privateArtifacts.includes(openRouterSecret));
  assert.ok(!privateArtifacts.includes("resolvedAuthIdentity"));
  assert.ok(!privateArtifacts.includes("rai1_"));

  console.log(
    `Packed package smoke passed for ${artifact.filename} on Node ${process.versions.node} with packaged @opentelemetry/api and host-owned @opentelemetry/sdk-metrics ${sdkMetricsVersion} (sha256 ${artifact.sha256}).`,
  );
} finally {
  await rm(workdir, { recursive: true, force: true });
}
