import { existsSync } from "fs";
import { dirname, isAbsolute, join, resolve } from "path";

export type ConfigFileKind = "opencode" | "tui";
export type ConfigFileFormat = "json" | "jsonc";

export interface EditableConfigPath {
  path: string;
  sourcePath: string;
  format: ConfigFileFormat;
  existed: boolean;
  removeSourcePath?: string;
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
  return [join(dir, `${kind}.jsonc`), join(dir, `${kind}.json`)];
}

export function resolveExistingConfigPath(dir: string, kind: ConfigFileKind): string | null {
  return getConfigFileCandidatePaths(dir, kind).find((path) => existsSync(path)) ?? null;
}

export function resolveEditableConfigPath(params: {
  dir: string;
  kind: ConfigFileKind;
  preferredFormat?: ConfigFileFormat;
  convertJsonToJsonc?: boolean;
}): EditableConfigPath {
  const jsoncPath = join(params.dir, `${params.kind}.jsonc`);
  if (existsSync(jsoncPath)) {
    return {
      path: jsoncPath,
      sourcePath: jsoncPath,
      format: "jsonc",
      existed: true,
    };
  }

  const jsonPath = join(params.dir, `${params.kind}.json`);
  if (existsSync(jsonPath)) {
    if (params.preferredFormat === "jsonc" && params.convertJsonToJsonc) {
      return {
        path: jsoncPath,
        sourcePath: jsonPath,
        format: "jsonc",
        existed: true,
        removeSourcePath: jsonPath,
      };
    }

    return {
      path: jsonPath,
      sourcePath: jsonPath,
      format: "json",
      existed: true,
    };
  }

  const format = params.preferredFormat ?? "jsonc";
  const path = join(params.dir, `${params.kind}.${format}`);
  return {
    path,
    sourcePath: path,
    format,
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
