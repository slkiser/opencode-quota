import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { dirname, join } from "path";

import { parseJsonOrJsonc } from "./jsonc.js";
import { getOpencodeRuntimeDirCandidates } from "./opencode-runtime-paths.js";

export interface TuiConfigDiagnostics {
  configured: boolean;
  inferredSelectedPath: string | null;
  presentPaths: string[];
  candidatePaths: string[];
  quotaPluginConfigured: boolean;
  quotaPluginConfigPaths: string[];
}

function dedupe(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}

function findGitWorktreeRoot(startDir: string): string | null {
  let current = startDir;

  while (true) {
    if (existsSync(join(current, ".git"))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function getTuiConfigCandidatePaths(params?: { cwd?: string }): string[] {
  const cwd = params?.cwd ?? process.cwd();
  const worktreeRoot = findGitWorktreeRoot(cwd);
  const { configDirs } = getOpencodeRuntimeDirCandidates();
  const locations = dedupe([
    ...configDirs,
    worktreeRoot ?? "",
    worktreeRoot ? join(worktreeRoot, ".opencode") : "",
    cwd,
    join(cwd, ".opencode"),
  ]);

  return locations.flatMap((dir) => [join(dir, "tui.json"), join(dir, "tui.jsonc")]);
}

async function readJson(path: string): Promise<unknown | null> {
  try {
    const content = await readFile(path, "utf-8");
    return parseJsonOrJsonc(content, path.endsWith(".jsonc"));
  } catch {
    return null;
  }
}

function extractPluginSpecsFromParsedConfig(parsed: unknown): string[] {
  if (!parsed || typeof parsed !== "object") {
    return [];
  }

  const root = parsed as Record<string, unknown>;
  const normalized =
    root.tui && typeof root.tui === "object"
      ? ({ ...(root.tui as Record<string, unknown>), ...root } as Record<string, unknown>)
      : root;

  if (!Array.isArray(normalized.plugin)) {
    return [];
  }

  return normalized.plugin
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (Array.isArray(entry) && typeof entry[0] === "string") return entry[0];
      return null;
    })
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function isQuotaPluginSpec(spec: string): boolean {
  const normalized = spec.replace(/\\/g, "/").toLowerCase();
  return (
    normalized.includes("@slkiser/opencode-quota") ||
    normalized.includes("/opencode-quota") ||
    normalized.includes("opencode-quota/dist/tui.tsx")
  );
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
