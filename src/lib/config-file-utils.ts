import { existsSync } from "fs";
import { dirname, join } from "path";

type ConfigFileKind = "opencode";
export type ConfigFileFormat = "json" | "jsonc";

export interface EditableConfigPath {
  path: string;
  format: ConfigFileFormat;
  existed: boolean;
}

interface RuntimeContextRoots {
  workspaceRoot: string;
  configRoot: string;
}

export function dedupeNonEmptyStrings(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
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

/**
 * Roots for an OpenCode location, shared by the server plugin and the TUI so both
 * read the same project config: the enclosing Git worktree, else the location directory.
 */
export function resolveOpenCodeLocationRoots(
  directory: string,
): RuntimeContextRoots & { fallbackDirectory: string } {
  const workspaceRoot = findGitWorktreeRoot(directory) ?? directory;
  return { workspaceRoot, configRoot: workspaceRoot, fallbackDirectory: directory };
}

function getConfigFileCandidatePaths(dir: string, kind: ConfigFileKind): string[] {
  return [join(dir, `${kind}.jsonc`), join(dir, `${kind}.json`)];
}

export function resolveExistingConfigPath(dir: string, kind: ConfigFileKind): string | null {
  return getConfigFileCandidatePaths(dir, kind).find((path) => existsSync(path)) ?? null;
}

export function resolveEditableConfigPath(params: {
  dir: string;
  kind: ConfigFileKind;
  preferredFormat?: ConfigFileFormat;
}): EditableConfigPath {
  const jsoncPath = join(params.dir, `${params.kind}.jsonc`);
  if (existsSync(jsoncPath)) {
    return { path: jsoncPath, format: "jsonc", existed: true };
  }

  const jsonPath = join(params.dir, `${params.kind}.json`);
  if (existsSync(jsonPath)) {
    return { path: jsonPath, format: "json", existed: true };
  }

  const format = params.preferredFormat ?? "jsonc";
  return { path: join(params.dir, `${params.kind}.${format}`), format, existed: false };
}

/** Reads the package spec from a legacy `plugin` entry or an OpenCode 2 native `plugins` entry. */
export function getPluginSpecFromEntry(entry: unknown): string | null {
  const spec =
    typeof entry === "string"
      ? entry
      : Array.isArray(entry) && typeof entry[0] === "string"
        ? entry[0]
        : entry &&
            typeof entry === "object" &&
            typeof (entry as { package?: unknown }).package === "string"
          ? (entry as { package: string }).package
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

  if (Array.isArray(root.plugins)) {
    pluginEntries.push(...root.plugins);
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

  // OpenCode 2 reads both the legacy `provider` map and the native `providers` map.
  const root = parsed as Record<string, unknown>;
  const providerIds: string[] = [];
  for (const providerMap of [root.provider, root.providers]) {
    if (providerMap && typeof providerMap === "object" && !Array.isArray(providerMap)) {
      providerIds.push(...Object.keys(providerMap));
    }
  }

  return dedupeNonEmptyStrings(providerIds);
}
