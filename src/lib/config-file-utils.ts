import { existsSync } from "fs";
import { dirname, isAbsolute, join, resolve } from "path";

export type ConfigFileKind = "opencode" | "tui";
export type ConfigFileFormat = "json" | "jsonc";

export interface EditableConfigPath {
  path: string;
  format: ConfigFileFormat;
  existed: boolean;
}

export interface RuntimeContextRootHints {
  workspaceRoot?: string | null;
  worktreeRoot?: string | null;
  activeDirectory?: string | null;
  configRoot?: string | null;
  fallbackDirectory: string;
}

export interface RuntimeContextRoots {
  workspaceRoot: string;
  configRoot: string;
}

export function dedupeNonEmptyStrings(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function pickFirstNonEmptyString(items: Array<string | null | undefined>): string | null {
  for (const item of items) {
    if (typeof item !== "string") {
      continue;
    }

    const trimmed = item.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return null;
}

/**
 * Returns the effective config root directory.
 *
 * Priority:
 * 1. `OPENCODE_CONFIG_DIR` environment variable (if set and non-empty)
 * 2. The provided fallback directory
 *
 * This matches OpenCode's own behavior: when `OPENCODE_CONFIG_DIR` is set,
 * config files are resolved relative to it rather than the current working directory.
 */
export function getEffectiveConfigRoot(fallback: string): string {
  const envDir = process.env.OPENCODE_CONFIG_DIR?.trim();
  if (!envDir) {
    return fallback;
  }

  if (isAbsolute(envDir)) {
    return envDir;
  }

  return resolve(fallback, envDir);
}

export function resolveRuntimeContextRoots(params: RuntimeContextRootHints): RuntimeContextRoots {
  const workspaceRoot =
    pickFirstNonEmptyString([
      params.workspaceRoot,
      params.worktreeRoot,
      params.activeDirectory,
      params.fallbackDirectory,
    ]) ?? params.fallbackDirectory;
  const explicitConfigRoot = pickFirstNonEmptyString([params.configRoot]);
  const computedConfigRoot =
    pickFirstNonEmptyString([workspaceRoot, params.activeDirectory]) ?? workspaceRoot;
  const configRoot = explicitConfigRoot ?? getEffectiveConfigRoot(computedConfigRoot);

  return { workspaceRoot, configRoot };
}

export function findGitWorktreeRoot(startDir: string): string | null {
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

export function getConfigFileCandidatePaths(dir: string, kind: ConfigFileKind): string[] {
  return [join(dir, `${kind}.json`), join(dir, `${kind}.jsonc`)];
}

export function resolveEditableConfigPath(params: {
  dir: string;
  kind: ConfigFileKind;
}): EditableConfigPath {
  const jsoncPath = join(params.dir, `${params.kind}.jsonc`);
  if (existsSync(jsoncPath)) {
    return {
      path: jsoncPath,
      format: "jsonc",
      existed: true,
    };
  }

  const jsonPath = join(params.dir, `${params.kind}.json`);
  if (existsSync(jsonPath)) {
    return {
      path: jsonPath,
      format: "json",
      existed: true,
    };
  }

  return {
    path: jsonPath,
    format: "json",
    existed: false,
  };
}

export function getPluginSpecFromEntry(entry: unknown): string | null {
  const spec =
    typeof entry === "string"
      ? entry
      : Array.isArray(entry) && typeof entry[0] === "string"
        ? entry[0]
        : null;

  if (typeof spec !== "string") {
    return null;
  }

  const trimmed = spec.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function extractPluginSpecsFromParsedConfig(parsed: unknown): string[] {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [];
  }

  const root = parsed as Record<string, unknown>;
  const pluginEntries: unknown[] = [];

  if (Array.isArray(root.plugin)) {
    pluginEntries.push(...root.plugin);
  }

  if (root.tui && typeof root.tui === "object" && !Array.isArray(root.tui)) {
    const tuiRoot = root.tui as Record<string, unknown>;
    if (Array.isArray(tuiRoot.plugin)) {
      pluginEntries.push(...tuiRoot.plugin);
    }
  }

  return dedupeNonEmptyStrings(
    pluginEntries
      .map((entry) => getPluginSpecFromEntry(entry))
      .filter((entry): entry is string => typeof entry === "string"),
  );
}

export function extractProviderIdsFromParsedConfig(parsed: unknown): string[] {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [];
  }

  const root = parsed as Record<string, unknown>;
  if (!root.provider || typeof root.provider !== "object" || Array.isArray(root.provider)) {
    return [];
  }

  return dedupeNonEmptyStrings(Object.keys(root.provider));
}

type ExactSemVer = {
  core: [string, string, string];
  prerelease: string[] | null;
};

export type QuotaNpmSpecDecision =
  | { kind: "replace"; reason: "bare" | "latest" | "older" }
  | { kind: "preserve" }
  | { kind: "not-target" };

const QUOTA_PLUGIN_PACKAGE = "@slkiser/opencode-quota";
const EXACT_SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function parseExactSemVer(version: string): ExactSemVer | null {
  const match = EXACT_SEMVER_PATTERN.exec(version);
  if (!match || match[0] !== version) {
    return null;
  }

  const prerelease = match[4]?.split(".") ?? null;
  if (prerelease?.some((identifier) => /^\d+$/.test(identifier) && /^0\d+$/.test(identifier))) {
    return null;
  }

  return {
    core: [match[1]!, match[2]!, match[3]!],
    prerelease,
  };
}

function compareNumericIdentifiers(left: string, right: string): number {
  if (left.length !== right.length) {
    return left.length < right.length ? -1 : 1;
  }
  return left === right ? 0 : left < right ? -1 : 1;
}

function compareExactSemVer(left: ExactSemVer, right: ExactSemVer): number {
  for (let index = 0; index < left.core.length; index += 1) {
    const comparison = compareNumericIdentifiers(left.core[index]!, right.core[index]!);
    if (comparison !== 0) {
      return comparison;
    }
  }

  if (left.prerelease === null || right.prerelease === null) {
    if (left.prerelease === right.prerelease) {
      return 0;
    }
    return left.prerelease === null ? 1 : -1;
  }

  const identifierCount = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < identifierCount; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return leftIdentifier === rightIdentifier ? 0 : leftIdentifier === undefined ? -1 : 1;
    }
    if (leftIdentifier === rightIdentifier) {
      continue;
    }

    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      return compareNumericIdentifiers(leftIdentifier, rightIdentifier);
    }
    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    }
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }

  return 0;
}

export function isCanonicalExactSemVer(version: string): boolean {
  return parseExactSemVer(version) !== null;
}

export function classifyQuotaNpmSpec(spec: string, runningVersion: string): QuotaNpmSpecDecision {
  if (spec === QUOTA_PLUGIN_PACKAGE) {
    return { kind: "replace", reason: "bare" };
  }
  if (spec === `${QUOTA_PLUGIN_PACKAGE}@latest`) {
    return { kind: "replace", reason: "latest" };
  }
  if (!spec.startsWith(`${QUOTA_PLUGIN_PACKAGE}@`)) {
    return { kind: "not-target" };
  }

  const existingVersion = parseExactSemVer(spec.slice(QUOTA_PLUGIN_PACKAGE.length + 1));
  const desiredVersion = parseExactSemVer(runningVersion);
  if (!existingVersion || !desiredVersion) {
    return { kind: "preserve" };
  }

  return compareExactSemVer(existingVersion, desiredVersion) < 0
    ? { kind: "replace", reason: "older" }
    : { kind: "preserve" };
}

export function isQuotaPluginSpec(spec: string, kind: ConfigFileKind): boolean {
  const normalized = spec.replace(/\\/g, "/").toLowerCase();

  if (normalized.includes("@slkiser/opencode-quota")) {
    return true;
  }

  if (normalized.includes("/opencode-quota") && !normalized.includes("/opencode-quota/dist/")) {
    return true;
  }

  return kind === "tui"
    ? normalized.includes("opencode-quota/dist/tui.tsx")
    : normalized.includes("opencode-quota/dist/index.js");
}
