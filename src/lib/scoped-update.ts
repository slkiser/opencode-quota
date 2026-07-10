import { lstat, readFile, realpath, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";

import { writeTextAtomic } from "./atomic-json.js";
import { findGitWorktreeRoot } from "./config-file-utils.js";
import {
  getOpencodeRuntimeDirCandidates,
  getOpencodeRuntimeDirs,
} from "./opencode-runtime-paths.js";

export const QUOTA_PACKAGE_NAME = "@slkiser/opencode-quota";
export const QUOTA_LATEST_SPEC = `${QUOTA_PACKAGE_NAME}@latest`;

const EXACT_SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export interface ScopedUpdateConfigEdit {
  path: string;
  original: string;
  originalBytes: Buffer;
  updated: string;
  replacements: number;
}

export interface ScopedUpdateConfigSnapshot {
  path: string;
  originalBytes: Buffer;
  expectedBytes: Buffer;
  updated: string;
  changed: boolean;
}

export interface ScopedUpdatePlan {
  configEdits: ScopedUpdateConfigEdit[];
  configSnapshots: ScopedUpdateConfigSnapshot[];
  configPaths: string[];
  foundSpecs: string[];
  cacheCandidates: string[];
  authoritativeLatest: boolean;
}

export interface ScopedUpdateResult {
  writtenPaths: string[];
  removedCachePaths: string[];
  skippedCachePaths: string[];
}

export class ScopedUpdateError extends Error {
  constructor(
    message: string,
    readonly details?: { writtenPaths?: string[]; path?: string },
  ) {
    super(message);
    this.name = "ScopedUpdateError";
  }
}

export function isCanonicalQuotaUpdateSpec(spec: string): boolean {
  if (spec === QUOTA_PACKAGE_NAME || spec === QUOTA_LATEST_SPEC) return true;
  const prefix = `${QUOTA_PACKAGE_NAME}@`;
  return spec.startsWith(prefix) && EXACT_SEMVER.test(spec.slice(prefix.length));
}

export function sanitizeOpenCodePackageSpec(
  spec: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32") return spec;
  return Array.from(spec, (char) =>
    new Set(["<", ">", ":", '"', "|", "?", "*"]).has(char) || char.charCodeAt(0) < 32 ? "_" : char,
  ).join("");
}

function effectiveGlobalConfigDir(params: { env: NodeJS.ProcessEnv; homeDir?: string }): string {
  const fallback = getOpencodeRuntimeDirs({
    env: params.env,
    homeDir: params.homeDir,
  }).configDir;
  const configured = params.env.OPENCODE_CONFIG_DIR?.trim();
  if (!configured) return fallback;
  return isAbsolute(configured) ? configured : resolve(fallback, configured);
}

function selectedConfigPaths(root: string): string[] {
  const result: string[] = [];
  for (const kind of ["opencode", "tui"] as const) {
    const jsonc = join(root, `${kind}.jsonc`);
    const json = join(root, `${kind}.json`);
    if (existsSync(jsonc)) result.push(jsonc);
    else if (existsSync(json)) result.push(json);
  }
  return result;
}

async function dedupeByRealPath(paths: string[]): Promise<string[]> {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const resolved = await realpath(path);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    output.push(path);
  }
  return output;
}

function pluginArrays(config: unknown): Array<{ path: (string | number)[]; entries: unknown[] }> {
  if (!config || typeof config !== "object" || Array.isArray(config)) return [];
  const root = config as Record<string, unknown>;
  const arrays: Array<{ path: (string | number)[]; entries: unknown[] }> = [];
  if (Array.isArray(root.plugin)) arrays.push({ path: ["plugin"], entries: root.plugin });
  if (root.tui && typeof root.tui === "object" && !Array.isArray(root.tui)) {
    const tui = root.tui as Record<string, unknown>;
    if (Array.isArray(tui.plugin)) arrays.push({ path: ["tui", "plugin"], entries: tui.plugin });
  }
  return arrays;
}

function updateConfig(
  raw: string,
  path: string,
): {
  updated: string;
  replacements: number;
  specs: string[];
} {
  const errors: ParseError[] = [];
  const parsed = parse(raw, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    throw new ScopedUpdateError(`Cannot update unparseable config: ${path}`, { path });
  }

  let updated = raw;
  let replacements = 0;
  const specs: string[] = [];
  for (const array of pluginArrays(parsed)) {
    for (let index = array.entries.length - 1; index >= 0; index--) {
      const entry = array.entries[index];
      const spec =
        typeof entry === "string"
          ? entry
          : Array.isArray(entry) && typeof entry[0] === "string"
            ? entry[0]
            : null;
      if (spec === null || !isCanonicalQuotaUpdateSpec(spec)) continue;
      specs.push(spec);
      if (spec === QUOTA_LATEST_SPEC) continue;
      const targetPath =
        typeof entry === "string" ? [...array.path, index] : [...array.path, index, 0];
      updated = applyEdits(updated, modify(updated, targetPath, QUOTA_LATEST_SPEC, {}));
      replacements++;
    }
  }
  return { updated, replacements, specs };
}

export async function planScopedUpdate(
  params: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    platform?: NodeJS.Platform;
  } = {},
): Promise<ScopedUpdatePlan> {
  const cwd = params.cwd ?? process.cwd();
  const env = params.env ?? process.env;
  const projectRoot = findGitWorktreeRoot(cwd) ?? cwd;
  const globalRoot = effectiveGlobalConfigDir({ env, homeDir: params.homeDir });
  const configPaths = await dedupeByRealPath([
    ...selectedConfigPaths(projectRoot),
    ...selectedConfigPaths(globalRoot),
  ]);

  const configEdits: ScopedUpdateConfigEdit[] = [];
  const configSnapshots: ScopedUpdateConfigSnapshot[] = [];
  const foundSpecs: string[] = [];
  for (const path of configPaths) {
    const originalBytes = await readFile(path);
    const original = originalBytes.toString("utf8");
    const planned = updateConfig(original, path);
    foundSpecs.push(...planned.specs);
    const changed = planned.updated !== original;
    configSnapshots.push({
      path,
      originalBytes,
      expectedBytes: changed ? Buffer.from(planned.updated, "utf8") : originalBytes,
      updated: planned.updated,
      changed,
    });
    if (changed) {
      configEdits.push({
        path,
        original,
        originalBytes,
        updated: planned.updated,
        replacements: planned.replacements,
      });
    }
  }

  const uniqueSpecs = [...new Set(foundSpecs)];
  const cacheSpecs = [...new Set([...uniqueSpecs, QUOTA_LATEST_SPEC])];
  const runtime = getOpencodeRuntimeDirCandidates({
    platform: params.platform,
    env,
    homeDir: params.homeDir,
  });
  const cacheCandidates = runtime.cacheDirs.flatMap((cacheDir) =>
    cacheSpecs.map((spec) =>
      join(cacheDir, "packages", sanitizeOpenCodePackageSpec(spec, params.platform)),
    ),
  );

  return {
    configEdits,
    configSnapshots,
    configPaths,
    foundSpecs: uniqueSpecs,
    cacheCandidates: [...new Set(cacheCandidates)],
    authoritativeLatest: uniqueSpecs.length > 0,
  };
}

function containedBy(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function removeVerifiedCacheCandidate(path: string): Promise<"removed" | "skipped"> {
  const packagesPath = dirname(dirname(path));
  try {
    const packagesStat = await lstat(packagesPath);
    const ownerStat = await lstat(dirname(path));
    if (packagesStat.isSymbolicLink() || ownerStat.isSymbolicLink()) return "skipped";
    const packagesReal = await realpath(packagesPath);
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return "skipped";
    const candidateReal = await realpath(path);
    if (!containedBy(packagesReal, candidateReal) || candidateReal === packagesReal)
      return "skipped";

    const manifestPath = join(
      candidateReal,
      "node_modules",
      "@slkiser",
      "opencode-quota",
      "package.json",
    );
    const manifestStat = await lstat(manifestPath);
    if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) return "skipped";
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { name?: unknown };
    if (manifest.name !== QUOTA_PACKAGE_NAME) return "skipped";

    await rm(candidateReal, { recursive: true, force: false });
    return "removed";
  } catch {
    return "skipped";
  }
}

export async function applyScopedUpdatePlan(
  plan: ScopedUpdatePlan,
  options: {
    dryRun?: boolean;
    readBytes?: (path: string) => Promise<Buffer>;
    writeText?: (path: string, content: string) => Promise<void>;
    beforeCacheDeletion?: () => Promise<void>;
  } = {},
): Promise<ScopedUpdateResult> {
  if (options.dryRun) {
    return { writtenPaths: [], removedCachePaths: [], skippedCachePaths: [] };
  }

  const readBytes = options.readBytes ?? ((path: string) => readFile(path));
  const writeText = options.writeText ?? writeTextAtomic;
  const writtenPaths: string[] = [];
  const failure = (action: string, path: string): ScopedUpdateError => {
    const changed =
      writtenPaths.length > 0 ? ` Changed before failure: ${writtenPaths.join(", ")}.` : "";
    return new ScopedUpdateError(`${action} ${path}; no cache was deleted.${changed}`, {
      path,
      writtenPaths: [...writtenPaths],
    });
  };

  for (const snapshot of plan.configSnapshots) {
    let current: Buffer;
    try {
      current = await readBytes(snapshot.path);
    } catch {
      throw failure("Failed reading", snapshot.path);
    }
    if (!current.equals(snapshot.originalBytes)) {
      throw failure("Config changed since preview:", snapshot.path);
    }
    if (!snapshot.changed) continue;
    try {
      await writeText(snapshot.path, snapshot.updated);
      writtenPaths.push(snapshot.path);
    } catch {
      throw failure("Failed writing", snapshot.path);
    }
  }

  await options.beforeCacheDeletion?.();

  let authoritativeLatest = false;
  for (const snapshot of plan.configSnapshots) {
    let current: Buffer;
    try {
      current = await readBytes(snapshot.path);
    } catch {
      throw failure("Failed re-reading", snapshot.path);
    }
    if (!current.equals(snapshot.expectedBytes)) {
      throw failure("Config changed before cache deletion:", snapshot.path);
    }
    const currentPlan = updateConfig(current.toString("utf8"), snapshot.path);
    if (currentPlan.specs.includes(QUOTA_LATEST_SPEC)) authoritativeLatest = true;
  }

  const removedCachePaths: string[] = [];
  const skippedCachePaths: string[] = [];
  if (authoritativeLatest) {
    for (const candidate of plan.cacheCandidates) {
      const result = await removeVerifiedCacheCandidate(candidate);
      (result === "removed" ? removedCachePaths : skippedCachePaths).push(candidate);
    }
  }
  return { writtenPaths, removedCachePaths, skippedCachePaths };
}

export async function runScopedUpdateCommand(
  params: {
    argv?: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    platform?: NodeJS.Platform;
    confirm?: (message: string) => Promise<boolean>;
    log?: (message: string) => void;
  } = {},
): Promise<number> {
  const argv = params.argv ?? [];
  const unknown = argv.filter((arg) => arg !== "--dry-run" && arg !== "--yes");
  if (unknown.length > 0) return 1;

  const dryRun = argv.includes("--dry-run");
  const yes = argv.includes("--yes");
  const log = params.log ?? console.log;
  try {
    const plan = await planScopedUpdate(params);
    log("Scoped OpenCode Quota update preview:");
    for (const edit of plan.configEdits) {
      log(`  edit ${edit.path} (${edit.replacements} replacement(s))`);
    }
    for (const candidate of plan.cacheCandidates) log(`  cache candidate ${candidate}`);
    if (plan.configPaths.length === 0 || !plan.authoritativeLatest) {
      log("No authoritative OpenCode config references an updatable OpenCode Quota spec.");
      return 0;
    }
    if (dryRun) return 0;
    if (!yes) {
      const confirm =
        params.confirm ??
        (async (message: string) => {
          const prompts = await import("@clack/prompts");
          const answer = await prompts.confirm({ message });
          return !prompts.isCancel(answer) && answer === true;
        });
      if (
        !(await confirm("Apply these config edits and delete only verified cache directories?"))
      ) {
        log("Update cancelled.");
        return 0;
      }
    }
    const result = await applyScopedUpdatePlan(plan);
    for (const path of result.writtenPaths) log(`Updated ${path}`);
    for (const path of result.removedCachePaths) log(`Removed ${path}`);
    for (const path of result.skippedCachePaths) log(`Skipped unverified cache candidate ${path}`);
    return 0;
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
