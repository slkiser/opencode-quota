import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { replacePath, safeRm } from "./upstream-plugin-fs.mjs";
import { upstreamPluginLockPath } from "./upstream-plugin-paths.mjs";

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

export function serializeUpstreamPluginLock(lock) {
  assertLockShape(lock);

  const sortedPlugins = {};
  for (const pluginId of Object.keys(lock.plugins).sort((left, right) => left.localeCompare(right))) {
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
        `Missing ${upstreamPluginLockPath}. Run npm run upstream:sync to create the tracked upstream plugin lock first.`,
      );
    }
    throw error;
  }

  const lock = JSON.parse(raw);
  assertLockShape(lock);
  return lock;
}

export async function writeUpstreamPluginLock(lock) {
  await writeFileAtomic(upstreamPluginLockPath, serializeUpstreamPluginLock(lock));
}
