import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const inputPath = path.resolve(process.argv[2] ?? "package-artifacts");
const nodeMajor = Number(process.versions.node.split(".")[0]);

if (nodeMajor !== 22 && nodeMajor !== 24) {
  console.error(
    `Packed runtime smoke requires Node 22 or 24; received Node ${process.versions.node}.`,
  );
  process.exit(1);
}

async function resolveTarball(input) {
  const inputStat = await stat(input);
  if (inputStat.isFile()) return input;

  const tarballs = (await readdir(input))
    .filter((file) => file.endsWith(".tgz"))
    .map((file) => path.join(input, file))
    .sort();

  if (tarballs.length !== 1) {
    throw new Error(`Expected exactly one .tgz in ${input}; found ${tarballs.length}.`);
  }
  return tarballs[0];
}

function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_cache: path.join(cwd, ".npm-cache"),
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
    },
    ...options,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }

  return result.stdout;
}

const tarball = await resolveTarball(inputPath);
const workdir = await mkdtemp(path.join(tmpdir(), "opencode-quota-package-smoke-"));

try {
  run("npm", ["init", "-y"], workdir);
  run("npm", ["install", "--omit=dev", tarball], workdir);

  const moduleSmoke = `
    import assert from "node:assert/strict";
    import { readFile } from "node:fs/promises";
    import { fileURLToPath } from "node:url";

    await import("@slkiser/opencode-quota");
    await import("@slkiser/opencode-quota/server");

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
  `;

  run(process.execPath, ["--input-type=module", "--eval", moduleSmoke], workdir);

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

  console.log(`Packed package smoke passed on Node ${process.versions.node}.`);
} finally {
  await rm(workdir, { recursive: true, force: true });
}
