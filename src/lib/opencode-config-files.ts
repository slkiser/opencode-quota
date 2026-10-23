/**
 * OpenCode's own config files, `opencode.json` and `opencode.jsonc`, found the way OpenCode 2
 * finds them (oc2 packages/core/src/config/discovery.ts, and `load` and `update` in config.ts).
 * The files that count for a folder, lowest priority first (a later file wins):
 * 1. the global folder (`getOpencodeRuntimeDirs().configDir`): opencode.json, then opencode.jsonc;
 * 2. the file `OPENCODE_CONFIG` names;
 * 3. every folder from the root down to the folder: opencode.json, then opencode.jsonc;
 * 4. every `.opencode` folder of those, from the root down: opencode.json, then opencode.jsonc.
 * 3 and 4 are left out when `OPENCODE_CONFIG_PROJECT_DISABLE` (else
 * `OPENCODE_DISABLE_PROJECT_CONFIG`) is 1 or true, or when the folder is the global folder.
 * Both kinds may hold comments and trailing commas. OpenCode's `{env:…}` and `{file:…}` text
 * substitution is not applied here.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { type ParseError, parse } from "jsonc-parser";

import { isRecord } from "./json-guards.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";

export type ConfigFileFormat = "json" | "jsonc";

export interface EditableConfigPath {
  path: string;
  format: ConfigFileFormat;
  existed: boolean;
}

/** One config file that exists and parses to an object. */
export interface OpenCodeConfigDocument {
  path: string;
  config: Record<string, unknown>;
}

/** OpenCode reads both names in this order, so in one folder opencode.jsonc wins. */
const CONFIG_FILE_NAMES = ["opencode.json", "opencode.jsonc"] as const;

/** OpenCode's `truthy` for its environment switches. */
function isSwitchOn(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

/** The real path, or the plain absolute path when it cannot be resolved (OpenCode's `resolve`). */
function realPathOrSelf(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** `directory` and each folder above it, closest first. */
function foldersUpward(directory: string): string[] {
  const folders: string[] = [];
  for (let folder = directory; ; folder = dirname(folder)) {
    folders.push(folder);
    if (dirname(folder) === folder) return folders;
  }
}

/** Project files (3) and `.opencode` folders (4) for `directory`, each from the root down. */
function projectSources(
  directory: string,
  globalDir: string,
): { files: string[]; dotFolders: string[] } {
  const home = homedir();
  // OpenCode keeps its global folders out of the project walk: a project path that resolves to
  // one of them, or to a global config file, does not count.
  const globalPaths = [
    globalDir,
    join(home, ".claude"),
    join(home, ".agents"),
    ...CONFIG_FILE_NAMES.map((name) => join(globalDir, name)),
  ].map(realPathOrSelf);

  const files: string[] = [];
  const dotFolders: string[] = [];
  for (const folder of foldersUpward(directory).reverse()) {
    const realFolder = realPathOrSelf(folder);
    const counts = (name: string) => !globalPaths.includes(realPathOrSelf(join(realFolder, name)));
    for (const name of CONFIG_FILE_NAMES) {
      if (counts(name)) files.push(join(folder, name));
    }
    const dotFolder = join(folder, ".opencode");
    if (counts(".opencode") && isDirectory(dotFolder)) dotFolders.push(dotFolder);
  }
  return { files, dotFolders };
}

/**
 * The OpenCode config files that count for a session in `directory`, lowest priority first.
 * They may not exist.
 */
export function openCodeConfigFiles(directory: string): string[] {
  const globalDir = getOpencodeRuntimeDirs().configDir;
  const globalFiles = CONFIG_FILE_NAMES.map((name) => join(globalDir, name));
  const explicitFile = process.env.OPENCODE_CONFIG ? [resolve(process.env.OPENCODE_CONFIG)] : [];

  const folder = resolve(directory);
  const projectDisabled = isSwitchOn(
    process.env.OPENCODE_CONFIG_PROJECT_DISABLE ?? process.env.OPENCODE_DISABLE_PROJECT_CONFIG,
  );
  if (projectDisabled || realPathOrSelf(folder) === realPathOrSelf(globalDir)) {
    return [...globalFiles, ...explicitFile];
  }

  const project = projectSources(folder, globalDir);
  return [
    ...globalFiles,
    ...explicitFile,
    ...project.files,
    ...project.dotFolders.flatMap((dotFolder) =>
      CONFIG_FILE_NAMES.map((name) => join(dotFolder, name)),
    ),
  ];
}

/** The config files that count for `directory` and exist, lowest priority first. */
export function existingOpenCodeConfigFiles(directory: string): string[] {
  return openCodeConfigFiles(directory).filter((path) => existsSync(path));
}

/**
 * OpenCode config text as OpenCode parses it: comments and trailing commas are allowed in both
 * kinds. Null when it does not parse or is not an object; OpenCode then ignores the file.
 */
export function parseOpenCodeConfig(text: string): Record<string, unknown> | null {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  return errors.length === 0 && isRecord(value) ? value : null;
}

/**
 * The config files that count for `directory`, read and parsed, lowest priority first. A file
 * that is missing, unreadable or does not parse is left out.
 */
export async function readOpenCodeConfigs(directory: string): Promise<OpenCodeConfigDocument[]> {
  const documents: OpenCodeConfigDocument[] = [];
  for (const path of openCodeConfigFiles(directory)) {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      continue;
    }
    const config = parseOpenCodeConfig(text);
    if (config) documents.push({ path, config });
  }
  return documents;
}

/**
 * The global file OpenCode writes its own settings to: opencode.jsonc when it is a file, else
 * opencode.json when it is one, else a new opencode.jsonc.
 */
export function globalConfigWriteTarget(): EditableConfigPath {
  const globalDir = getOpencodeRuntimeDirs().configDir;
  const jsoncPath = join(globalDir, "opencode.jsonc");
  if (isFile(jsoncPath)) return { path: jsoncPath, format: "jsonc", existed: true };
  const jsonPath = join(globalDir, "opencode.json");
  if (isFile(jsonPath)) return { path: jsonPath, format: "json", existed: true };
  return { path: jsoncPath, format: "jsonc", existed: false };
}
