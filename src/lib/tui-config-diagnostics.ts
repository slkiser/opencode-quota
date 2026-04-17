import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";

import { parseJsonOrJsonc } from "./jsonc.js";
import { getOpencodeRuntimeDirCandidates } from "./opencode-runtime-paths.js";
import {
  dedupeNonEmptyStrings,
  extractPluginSpecsFromParsedConfig,
  findGitWorktreeRoot,
  getConfigFileCandidatePaths,
  isQuotaPluginSpec,
} from "./config-file-utils.js";

export interface TuiConfigDiagnostics {
  configured: boolean;
  inferredSelectedPath: string | null;
  presentPaths: string[];
  candidatePaths: string[];
  quotaPluginConfigured: boolean;
  quotaPluginConfigPaths: string[];
}

function getTuiConfigCandidatePaths(params?: { cwd?: string }): string[] {
  const cwd = params?.cwd ?? process.cwd();
  const worktreeRoot = findGitWorktreeRoot(cwd);
  const { configDirs } = getOpencodeRuntimeDirCandidates();
  const locations = dedupeNonEmptyStrings([
    ...configDirs,
    worktreeRoot ?? "",
    worktreeRoot ? join(worktreeRoot, ".opencode") : "",
    cwd,
    join(cwd, ".opencode"),
  ]);

  return locations.flatMap((dir) => getConfigFileCandidatePaths(dir, "tui"));
}

async function readJson(path: string): Promise<unknown | null> {
  try {
    const content = await readFile(path, "utf-8");
    return parseJsonOrJsonc(content, path.endsWith(".jsonc"));
  } catch {
    return null;
  }
}

export async function inspectTuiConfig(params?: { cwd?: string }): Promise<TuiConfigDiagnostics> {
  const candidatePaths = getTuiConfigCandidatePaths(params);
  const presentPaths = candidatePaths.filter((path) => existsSync(path));
  const quotaPluginConfigPaths: string[] = [];

  for (const path of presentPaths) {
    const parsed = await readJson(path);
    const specs = extractPluginSpecsFromParsedConfig(parsed);
    if (specs.some(isQuotaPluginSpec)) {
      quotaPluginConfigPaths.push(path);
    }
  }

  return {
    configured: presentPaths.length > 0,
    inferredSelectedPath: presentPaths[presentPaths.length - 1] ?? null,
    presentPaths,
    candidatePaths,
    quotaPluginConfigured: quotaPluginConfigPaths.length > 0,
    quotaPluginConfigPaths,
  };
}
