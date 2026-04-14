import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { replacePath, safeRm } from "./upstream-plugin-fs.mjs";
import { serializeUpstreamPluginLock } from "./upstream-plugin-lock.mjs";
import { upstreamPluginReferenceRoot } from "./upstream-plugin-paths.mjs";
import { downloadTarball, fetchLatestPublishedPluginVersion } from "./upstream-plugin-registry.mjs";
import { sanitizeUpstreamPluginSnapshot } from "./upstream-plugin-sanitization.mjs";
import { UPSTREAM_PLUGIN_SPECS } from "./upstream-plugin-specs.mjs";

const execFileAsync = promisify(execFile);

async function extractTarball(tarballPath, destinationPath) {
  await mkdir(destinationPath, { recursive: true });

  try {
    await execFileAsync("tar", ["-xzf", tarballPath, "--strip-components=1", "-C", destinationPath]);
  } catch (error) {
    const detail =
      error && typeof error === "object" && "message" in error ? String(error.message) : "tar extraction failed";
    throw new Error(`Failed to extract ${tarballPath}: ${detail}`);
  }
}

function buildTemporaryPath(rootPath, label) {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return path.join(path.dirname(rootPath), `.${label}-${suffix}`);
}

async function copyPreservedRootEntries(stageRoot) {
  let entries = [];
  try {
    entries = await readdir(upstreamPluginReferenceRoot, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    if (entry.name === "lock.json") continue;
    if (entry.isDirectory()) continue;

    await cp(path.join(upstreamPluginReferenceRoot, entry.name), path.join(stageRoot, entry.name), {
      force: true,
      recursive: true,
    });
  }
}

async function stageOnePlugin(latest, stageRoot) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), `opencode-quota-${latest.pluginId}-`));
  const tarballPath = path.join(tempRoot, `${latest.pluginId}-${latest.version}.tgz`);
  const destinationPath = path.join(stageRoot, latest.pluginId);

  try {
    await downloadTarball(latest.tarballUrl, tarballPath);
    await safeRm(destinationPath);
    await extractTarball(tarballPath, destinationPath);
    await sanitizeUpstreamPluginSnapshot(latest.pluginId, destinationPath);
  } finally {
    await safeRm(tempRoot);
  }

  return {
    pluginId: latest.pluginId,
    referenceDir: latest.referenceDir,
    version: latest.version,
  };
}

function buildLock(latestVersions) {
  const plugins = {};

  for (const latest of [...latestVersions].sort((left, right) => left.pluginId.localeCompare(right.pluginId))) {
    plugins[latest.pluginId] = {
      npmUrl: latest.npmUrl,
      packageName: latest.packageName,
      publishedAt: latest.publishedAt,
      referenceDir: latest.referenceDir,
      repo: latest.repo,
      version: latest.version,
    };
  }

  return { plugins };
}

async function writeLockIntoStageRoot(lock, stageRoot) {
  await writeFile(path.join(stageRoot, "lock.json"), serializeUpstreamPluginLock(lock), "utf8");
}

async function swapStagedReferenceRoot(stageRoot) {
  const backupRoot = buildTemporaryPath(upstreamPluginReferenceRoot, "upstream-plugins.backup");
  let backupCreated = false;

  try {
    await rename(upstreamPluginReferenceRoot, backupRoot);
    backupCreated = true;
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }

  try {
    await replacePath(stageRoot, upstreamPluginReferenceRoot);
  } catch (error) {
    if (backupCreated) {
      try {
        await replacePath(backupRoot, upstreamPluginReferenceRoot);
      } catch {
        // best-effort rollback
      }
    }
    throw error;
  }

  if (backupCreated) {
    await safeRm(backupRoot);
  }
}

export async function syncUpstreamPluginReferences() {
  const latestVersions = [];

  for (const spec of UPSTREAM_PLUGIN_SPECS) {
    latestVersions.push(await fetchLatestPublishedPluginVersion(spec));
  }

  const stageRoot = buildTemporaryPath(upstreamPluginReferenceRoot, "upstream-plugins.stage");
  await mkdir(stageRoot, { recursive: true });

  try {
    await copyPreservedRootEntries(stageRoot);

    const syncedPlugins = [];
    for (const latest of latestVersions) {
      syncedPlugins.push(await stageOnePlugin(latest, stageRoot));
    }

    const lock = buildLock(latestVersions);
    await writeLockIntoStageRoot(lock, stageRoot);
    await swapStagedReferenceRoot(stageRoot);

    return { latestVersions, lock, syncedPlugins };
  } finally {
    await safeRm(stageRoot);
  }
}
