import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { replacePath, safeRm } from "./upstream-plugin-fs.mjs";
import { repoRoot, upstreamPluginLockPath } from "./upstream-plugin-paths.mjs";

const execFileAsync = promisify(execFile);

function isLockEntry(value) {
  return (
    value &&
    typeof value === "object" &&
    typeof value.packageName === "string" &&
    typeof value.publishedAt === "string" &&
    typeof value.referenceDir === "string" &&
    typeof value.repo === "string" &&
    typeof value.version === "string" &&
    typeof value.npmUrl === "string"
  );
}

function assertLockShape(lock) {
  if (!lock || typeof lock !== "object" || !lock.plugins || typeof lock.plugins !== "object") {
    throw new Error(`Invalid upstream plugin lock file at ${upstreamPluginLockPath}`);
  }

  for (const [pluginId, entry] of Object.entries(lock.plugins)) {
    if (!isLockEntry(entry)) {
      throw new Error(`Invalid lock entry for ${pluginId} in ${upstreamPluginLockPath}`);
    }
  }
}

async function writeFileAtomic(filePath, content) {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(tempPath, content, "utf8");

  try {
    await replacePath(tempPath, filePath);
  } catch (error) {
    await safeRm(tempPath);
    throw error;
  }
}

export function parseUpstreamPluginLock(raw) {
  const lock = JSON.parse(raw);
  assertLockShape(lock);
  return lock;
}

export function serializeUpstreamPluginLock(lock) {
  assertLockShape(lock);

  const sortedPlugins = {};
  for (const pluginId of Object.keys(lock.plugins).sort((left, right) =>
    left.localeCompare(right),
  )) {
    sortedPlugins[pluginId] = lock.plugins[pluginId];
  }

  return `${JSON.stringify({ plugins: sortedPlugins }, null, 2)}\n`;
}

export async function readUpstreamPluginLock() {
  let raw;
  try {
    raw = await readFile(upstreamPluginLockPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error(
        `Missing ${upstreamPluginLockPath}. Run pnpm run upstream:sync to create the tracked upstream plugin lock first.`,
      );
    }
    throw error;
  }

  return parseUpstreamPluginLock(raw);
}

export async function readCommittedUpstreamPluginLock({
  repositoryRoot = repoRoot,
  lockPath = upstreamPluginLockPath,
} = {}) {
  const relativeLockPath = path.relative(repositoryRoot, lockPath).replaceAll(path.sep, "/");

  try {
    const { stdout } = await execFileAsync("git", ["show", `HEAD:${relativeLockPath}`], {
      cwd: repositoryRoot,
      maxBuffer: 10 * 1024 * 1024,
    });
    return parseUpstreamPluginLock(stdout);
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string"
        ? error.stderr
        : "";
    if (
      stderr.includes(`path '${relativeLockPath}' does not exist in 'HEAD'`) ||
      stderr.includes(`path '${relativeLockPath}' exists on disk, but not in 'HEAD'`)
    ) {
      return { plugins: {} };
    }
    throw error;
  }
}

export async function writeUpstreamPluginLock(lock) {
  await writeFileAtomic(upstreamPluginLockPath, serializeUpstreamPluginLock(lock));
}
