import { existsSync } from "fs";
import { dirname, join } from "path";

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
