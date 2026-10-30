import { type Dirent, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { nonEmptyString } from "./json-guards.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";

const require = createRequire(import.meta.url);

/**
 * Google AGY and Gemini CLI quota requests reuse the OAuth client of the
 * companion OpenCode plugin that created the login. This module finds that
 * plugin and reads its client id and secret.
 */

export type GoogleCompanionPresence =
  | { state: "present"; importSpecifier: string; resolvedPath: string }
  | { state: "missing"; importSpecifier: string; error: string }
  | {
      state: "invalid";
      importSpecifier: string;
      error: string;
      resolvedPath?: string;
    };

export type GoogleCompanionConfiguredCredentials = {
  state: "configured";
  clientId: string;
  clientSecret: string;
  resolvedPath: string;
};

type GoogleCompanionClientCredentials =
  | GoogleCompanionConfiguredCredentials
  | {
      state: "missing" | "invalid";
      error: string;
      resolvedPath?: string;
    };

export type GoogleCompanionResolver = {
  inspect: () => Promise<GoogleCompanionPresence>;
  resolveCredentials: () => Promise<GoogleCompanionClientCredentials>;
  clearCacheForTests: () => void;
};

type GoogleCompanion = {
  packageName: string;
  clientIdExport: string;
  clientSecretExport: string;
  /** Quota name in the "install the plugin" message. */
  quotaName: string;
};

type CompanionState = {
  presence: GoogleCompanionPresence;
  credentials: GoogleCompanionClientCredentials;
};

/** Set when a resolver error shows the package is installed but blocks the subpath. */
type Lookup = { packageFound: boolean };

const RUNTIME_CANDIDATES = [
  ["src", "constants.ts"],
  ["src", "constants.js"],
  ["dist", "src", "constants.js"],
  ["dist", "index.js"],
] as const;
const PACKAGE_JSON_CANDIDATES = [
  ["src", "constants.ts"],
  ["dist", "index.js"],
] as const;

function hasErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

/** "Not installed" or "subpath not exported": the next lookup may still find it. */
function isNotFoundError(error: unknown): boolean {
  return (
    hasErrorCode(error, "MODULE_NOT_FOUND") ||
    hasErrorCode(error, "ERR_PACKAGE_PATH_NOT_EXPORTED") ||
    (error instanceof Error && error.message.includes("Cannot find module"))
  );
}

/**
 * Where Node resolves `specifier`, then (with `searchCache`) where it resolves
 * it from OpenCode's cache directory. `failed` marks any other resolver error.
 */
function resolveModulePath(
  specifier: string,
  lookup: Lookup,
  searchCache: boolean,
): { path: string | null; failed: boolean } {
  const attempt = (resolve: () => string): { path: string | null; failed: boolean } => {
    try {
      return { path: resolve(), failed: false };
    } catch (error) {
      if (hasErrorCode(error, "ERR_PACKAGE_PATH_NOT_EXPORTED")) lookup.packageFound = true;
      return { path: null, failed: !isNotFoundError(error) };
    }
  };

  const fromProcess = attempt(() => require.resolve(specifier));
  if (fromProcess.path || fromProcess.failed || !searchCache) return fromProcess;
  return attempt(() => require.resolve(specifier, { paths: [getOpencodeRuntimeDirs().cacheDir] }));
}

/**
 * Package roots in OpenCode 2's plugin install layout:
 * `<cache>/npm/<package>@<spec>/<generation>/node_modules/<package>`.
 * OpenCode 2 loads only the highest-numbered generation of a spec directory.
 * Generation numbers are install timestamps, so across specs (for example
 * `@latest` and `@alpha`) the most recent install comes first.
 */
function getOpencode2NpmPackageRoots(
  specsDir: string,
  name: string,
  packageName: string,
): string[] {
  let specEntries: Dirent[];
  try {
    specEntries = readdirSync(specsDir, { withFileTypes: true });
  } catch {
    // A missing OpenCode 2 npm directory is not an installed companion.
    return [];
  }

  const installs: { generation: number; packageRoot: string }[] = [];
  for (const entry of specEntries) {
    if (!entry.isDirectory() || !entry.name.startsWith(`${name}@`)) continue;
    const specDir = join(specsDir, entry.name);
    let generation: string | undefined;
    try {
      generation = readdirSync(specDir)
        .filter((candidate) => /^\d+$/.test(candidate))
        .sort((left, right) => Number(left) - Number(right))
        .at(-1);
    } catch {
      continue;
    }
    if (!generation) continue;
    installs.push({
      generation: Number(generation),
      packageRoot: join(specDir, generation, "node_modules", packageName),
    });
  }

  return installs
    .sort((left, right) => right.generation - left.generation)
    .map((install) => install.packageRoot);
}

function getRuntimePackageRoots(packageName: string): string[] {
  const { cacheDir } = getOpencodeRuntimeDirs();
  // Installs of "@scope/name" live in a scope folder, unscoped ones in the parent folder.
  const [scope, name] = packageName.startsWith("@")
    ? (packageName.split("/") as [string, string])
    : ["", packageName];
  const packageRoots = [
    ...getOpencode2NpmPackageRoots(join(cacheDir, "npm", scope), name, packageName),
    // OpenCode 1 layouts. OpenCode 2 shares this cache directory and never
    // removes them, so companions installed before the upgrade still provide
    // the OAuth client for logins that OpenCode 2 imported from auth.json.
    join(cacheDir, "node_modules", packageName),
  ];

  const packagesDir = join(cacheDir, "packages", scope);
  try {
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(name)) continue;
      const packagePath = join(packagesDir, entry.name);
      packageRoots.push(packagePath, join(packagePath, "node_modules", packageName));
    }
  } catch {
    // A missing runtime packages directory is not an installed companion.
  }

  return packageRoots;
}

function configuredState(
  importSpecifier: string,
  resolvedPath: string,
  client: { clientId: string; clientSecret: string },
): CompanionState {
  return {
    presence: { state: "present", importSpecifier, resolvedPath },
    credentials: { state: "configured", ...client, resolvedPath },
  };
}

function invalidState(
  companion: GoogleCompanion,
  importSpecifier: string,
  resolvedPath?: string,
): CompanionState {
  const error = `Installed ${companion.packageName} package is incompatible`;
  const path = resolvedPath ? { resolvedPath } : {};
  return {
    presence: { state: "invalid", importSpecifier, ...path, error },
    credentials: { state: "invalid", ...path, error },
  };
}

function readStringConstant(content: string, name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    content
      .match(
        new RegExp(`(?:export\\s+const|const|var)\\s+${escapedName}\\s*=\\s*["']([^"']+)["']`),
      )?.[1]
      ?.trim() ?? ""
  );
}

/** The client in a source or bundle file; null when the file cannot be read. */
async function readConstantsFile(
  companion: GoogleCompanion,
  importSpecifier: string,
  path: string,
): Promise<CompanionState | null> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return null;
  }
  const clientId = readStringConstant(content, companion.clientIdExport);
  const clientSecret = readStringConstant(content, companion.clientSecretExport);
  return clientId && clientSecret
    ? configuredState(importSpecifier, path, { clientId, clientSecret })
    : invalidState(companion, importSpecifier, path);
}

/** Imports the compiled constants module and reads its named exports. */
async function fromCompiledModule(
  companion: GoogleCompanion,
  lookup: Lookup,
): Promise<CompanionState | null> {
  const { packageName } = companion;
  for (const specifier of [
    `${packageName}/dist/src/constants.js`,
    `${packageName}/dist/index.js`,
    `${packageName}/src/constants.js`,
  ]) {
    const { path, failed } = resolveModulePath(specifier, lookup, true);
    if (failed) return invalidState(companion, specifier);
    if (!path) continue;

    let exports: Record<string, unknown>;
    try {
      exports = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
    } catch {
      return invalidState(companion, specifier, path);
    }
    const clientId = nonEmptyString(exports[companion.clientIdExport]);
    const clientSecret = nonEmptyString(exports[companion.clientSecretExport]);
    return clientId && clientSecret
      ? configuredState(specifier, path, { clientId, clientSecret })
      : invalidState(companion, specifier, path);
  }
  return null;
}

/** Reads the file a specifier resolves to; an unreadable file is an incompatible package. */
async function fromResolvedFile(
  companion: GoogleCompanion,
  specifier: string,
  lookup: Lookup,
  searchCache: boolean,
): Promise<CompanionState | null> {
  const { path, failed } = resolveModulePath(specifier, lookup, searchCache);
  if (failed) return invalidState(companion, specifier);
  if (!path) return null;
  return (
    (await readConstantsFile(companion, specifier, path)) ??
    invalidState(companion, specifier, path)
  );
}

async function fromRuntimeCache(
  companion: GoogleCompanion,
  sourceSpecifier: string,
): Promise<CompanionState | null> {
  for (const packageRoot of getRuntimePackageRoots(companion.packageName)) {
    for (const parts of RUNTIME_CANDIDATES) {
      const state = await readConstantsFile(
        companion,
        sourceSpecifier,
        join(packageRoot, ...parts),
      );
      if (state) return state;
    }
  }
  return null;
}

async function fromPackageJson(
  companion: GoogleCompanion,
  sourceSpecifier: string,
  lookup: Lookup,
): Promise<CompanionState | null> {
  const { path, failed } = resolveModulePath(`${companion.packageName}/package.json`, lookup, true);
  if (failed) return invalidState(companion, sourceSpecifier);
  if (!path) return null;

  const packageRoot = dirname(path);
  for (const parts of PACKAGE_JSON_CANDIDATES) {
    const state = await readConstantsFile(companion, sourceSpecifier, join(packageRoot, ...parts));
    if (state) return state;
  }
  return invalidState(companion, sourceSpecifier, join(packageRoot, ...PACKAGE_JSON_CANDIDATES[0]));
}

async function resolveCompanionState(companion: GoogleCompanion): Promise<CompanionState> {
  const { packageName } = companion;
  const sourceSpecifier = `${packageName}/src/constants.ts`;
  const lookup: Lookup = { packageFound: false };

  const found =
    (await fromCompiledModule(companion, lookup)) ??
    (await fromResolvedFile(companion, sourceSpecifier, lookup, false)) ??
    (await fromRuntimeCache(companion, sourceSpecifier)) ??
    (await fromPackageJson(companion, sourceSpecifier, lookup)) ??
    (await fromResolvedFile(companion, packageName, lookup, true));
  if (found) return found;
  if (lookup.packageFound) return invalidState(companion, packageName);

  const error = `Install ${packageName} separately to enable ${companion.quotaName} quota`;
  return {
    presence: { state: "missing", importSpecifier: sourceSpecifier, error },
    credentials: { state: "missing", error },
  };
}

function createCompanionResolver(companion: GoogleCompanion): GoogleCompanionResolver {
  let statePromise: Promise<CompanionState> | null = null;
  const getState = (): Promise<CompanionState> => {
    statePromise ??= resolveCompanionState(companion);
    return statePromise;
  };
  return {
    inspect: async () => (await getState()).presence,
    resolveCredentials: async () => (await getState()).credentials,
    clearCacheForTests: () => {
      statePromise = null;
    },
  };
}

export const agyCompanion = createCompanionResolver({
  packageName: "@anthonyhaussman/opencode-agy-auth",
  clientIdExport: "AGY_CLIENT_ID",
  clientSecretExport: "AGY_CLIENT_SECRET",
  quotaName: "Google AGY",
});

export const geminiCliCompanion = createCompanionResolver({
  packageName: "opencode-gemini-auth",
  clientIdExport: "GEMINI_CLIENT_ID",
  clientSecretExport: "GEMINI_CLIENT_SECRET",
  quotaName: "Gemini CLI",
});
