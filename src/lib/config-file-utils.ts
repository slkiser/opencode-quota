import { existsSync } from "fs";
import { dirname, join } from "path";

export type ConfigFileKind = "opencode" | "tui";
export type ConfigFileFormat = "json" | "jsonc";

export interface EditableConfigPath {
  path: string;
  format: ConfigFileFormat;
  existed: boolean;
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

export function isQuotaPluginSpec(spec: string): boolean {
  const normalized = spec.replace(/\\/g, "/").toLowerCase();
  return (
    normalized.includes("@slkiser/opencode-quota") ||
    normalized.includes("/opencode-quota") ||
    normalized.includes("opencode-quota/dist/tui.tsx") ||
    normalized.includes("opencode-quota/dist/index.js")
  );
}
