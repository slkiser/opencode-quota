import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor !== 24) {
  console.error(
    `Release packages must be built and packed on Node 24; received Node ${process.versions.node}.`,
  );
  process.exit(1);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const artifactDir = await mkdtemp(path.join(tmpdir(), "opencode-quota-release-package-"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, HUSKY: "0" },
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

try {
  const packJson = run("pnpm", ["pack", "--json", "--pack-destination", artifactDir]);
  const manifestPath = path.join(artifactDir, "pack-manifest.json");
  await writeFile(manifestPath, packJson, "utf8");

  run(process.execPath, ["scripts/verify-package-contents.mjs", manifestPath], {
    stdio: "inherit",
  });

  const tarballs = (await readdir(artifactDir)).filter((file) => file.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    throw new Error(`Expected exactly one release tarball; found ${tarballs.length}.`);
  }

  run(process.execPath, ["scripts/smoke-packed-package.mjs", path.join(artifactDir, tarballs[0])], {
    stdio: "inherit",
  });
} finally {
  await rm(artifactDir, { recursive: true, force: true });
}
