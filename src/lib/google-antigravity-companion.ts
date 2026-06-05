import { readFile } from "fs/promises";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { getOpencodeRuntimeDirCandidates } from "./opencode-runtime-paths.js";

const require = createRequire(import.meta.url);

const COMPANION_PACKAGE_NAME = "opencode-antigravity-auth";
const COMPANION_JS_IMPORT_SPECIFIERS = [
  `${COMPANION_PACKAGE_NAME}/dist/src/constants.js`,
  `${COMPANION_PACKAGE_NAME}/src/constants.js`,
] as const;
const COMPANION_SOURCE_IMPORT_SPECIFIER = `${COMPANION_PACKAGE_NAME}/src/constants.ts`;
const COMPANION_PACKAGE_JSON_SPECIFIER = `${COMPANION_PACKAGE_NAME}/package.json`;
const COMPANION_DIRECT_CANDIDATE_PATHS = [
  ["dist", "src", "constants.js"],
  ["src", "constants.ts"],
  ["src", "constants.js"],
  ["dist", "index.js"],
] as const;
const COMPANION_MISSING_ERROR = `Install ${COMPANION_PACKAGE_NAME} separately to enable Google Antigravity quota`;
const COMPANION_INVALID_ERROR = `Installed ${COMPANION_PACKAGE_NAME} package is incompatible`;

export type GoogleAntigravityCompanionPresence =
  | {
      state: "present";
      importSpecifier: string;
      resolvedPath: string;
    }
  | {
      state: "missing";
      importSpecifier: string;
      error: string;
    }
  | {
      state: "invalid";
      importSpecifier: string;
      error: string;
      resolvedPath?: string;
    };

export type GoogleAntigravityConfiguredCredentials = {
  state: "configured";
  clientId: string;
  clientSecret: string;
  resolvedPath: string;
};

export type GoogleAntigravityClientCredentials =
  | GoogleAntigravityConfiguredCredentials
  | {
      state: "missing" | "invalid";
      error: string;
      resolvedPath?: string;
    };

type ResolvedCompanionState = {
  presence: GoogleAntigravityCompanionPresence;
  credentials: GoogleAntigravityClientCredentials;
};

type CompanionModule = {
  ANTIGRAVITY_CLIENT_ID?: unknown;
  ANTIGRAVITY_CLIENT_SECRET?: unknown;
};

type CompanionResolutionContext = {
  packageFound: boolean;
};

let resolvedCompanionStatePromise: Promise<ResolvedCompanionState> | null = null;

function isModuleNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const code = "code" in error ? error.code : undefined;
  if (code === "MODULE_NOT_FOUND") {
    return true;
  }

  const message = error instanceof Error ? error.message : "";
  return message.includes("Cannot find module");
}

function isPackagePathNotExportedError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  return "code" in error && error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED";
}

function isFallthroughResolutionError(error: unknown): boolean {
  return isModuleNotFoundError(error) || isPackagePathNotExportedError(error);
}

function normalizeCredential(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function getCompanionResolvePaths(): string[] {
  const paths = [
    ...getOpencodeRuntimeDirCandidates().cacheDirs,
    "C:\\Users\\gsc\\AppData\\Local\\nvm\\v22.22.1\\node_modules",
    "C:\\Users\\gsc\\AppData\\Roaming\\npm\\node_modules",
    "C:\\nvm4w\\nodejs\\node_modules"
  ];
  return paths;
}

function getRuntimePackageRoots(): string[] {
  const cacheDirs = getOpencodeRuntimeDirCandidates().cacheDirs;
  const packageRoots = cacheDirs.map((cacheDir) =>
    join(cacheDir, "node_modules", COMPANION_PACKAGE_NAME),
  );

  for (const cacheDir of cacheDirs) {
    try {
      const packagesDir = join(cacheDir, "packages");
      const entries = readdirSync(packagesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith(COMPANION_PACKAGE_NAME)) {
          packageRoots.push(join(packagesDir, entry.name));
          packageRoots.push(join(packagesDir, entry.name, "node_modules", COMPANION_PACKAGE_NAME));
        }
      }
    } catch {
      // Ignore if packages dir doesn't exist
    }
  }

  return packageRoots;
}

function markPackageFoundForExportBlock(error: unknown, context: CompanionResolutionContext): void {
  if (isPackagePathNotExportedError(error)) {
    context.packageFound = true;
  }
}

function resolveCompanionSpecifier(specifier: string, context: CompanionResolutionContext): string {
  try {
    return require.resolve(specifier);
  } catch (error) {
    markPackageFoundForExportBlock(error, context);
    if (!isFallthroughResolutionError(error)) {
      throw error;
    }

    try {
      return require.resolve(specifier, { paths: getCompanionResolvePaths() });
    } catch (resolvePathsError) {
      markPackageFoundForExportBlock(resolvePathsError, context);
      throw resolvePathsError;
    }
  }
}

function buildConfiguredState(params: {
  importSpecifier: string;
  resolvedPath: string;
  clientId: string;
  clientSecret: string;
}): ResolvedCompanionState {
  return {
    presence: {
      state: "present",
      importSpecifier: params.importSpecifier,
      resolvedPath: params.resolvedPath,
    },
    credentials: {
      state: "configured",
      clientId: params.clientId,
      clientSecret: params.clientSecret,
      resolvedPath: params.resolvedPath,
    },
  };
}

function buildInvalidState(importSpecifier: string, resolvedPath?: string): ResolvedCompanionState {
  return {
    presence: {
      state: "invalid",
      importSpecifier,
      ...(resolvedPath ? { resolvedPath } : {}),
      error: COMPANION_INVALID_ERROR,
    },
    credentials: {
      state: "invalid",
      ...(resolvedPath ? { resolvedPath } : {}),
      error: COMPANION_INVALID_ERROR,
    },
  };
}

function parseSourceCredentials(
  content: string,
): { clientId: string; clientSecret: string } | null {
  const clientId =
    content
      .match(/(?:export\s+const|const|var)\s+ANTIGRAVITY_CLIENT_ID\s*=\s*["']([^"']+)["']/)?.[1]
      ?.trim() ?? "";
  const clientSecret =
    content
      .match(/(?:export\s+const|const|var)\s+ANTIGRAVITY_CLIENT_SECRET\s*=\s*["']([^"']+)["']/)?.[1]
      ?.trim() ?? "";

  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

function getPackageCredentialPaths(packageRoot: string): string[] {
  return COMPANION_DIRECT_CANDIDATE_PATHS.map((parts) => join(packageRoot, ...parts));
}

function getRuntimeCredentialPaths(): string[] {
  return getRuntimePackageRoots().flatMap((packageRoot) => getPackageCredentialPaths(packageRoot));
}

function isMissingFileError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const code = "code" in error ? error.code : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function tryReadCredentialsPath(
  importSpecifier: string,
  resolvedPath: string,
): Promise<ResolvedCompanionState | null> {
  let content: string;
  try {
    content = await readFile(resolvedPath, "utf8");
  } catch (error) {
    return isMissingFileError(error) ? null : buildInvalidState(importSpecifier, resolvedPath);
  }

  const credentials = parseSourceCredentials(content);
  if (!credentials) {
    return buildInvalidState(importSpecifier, resolvedPath);
  }

  return buildConfiguredState({
    importSpecifier,
    resolvedPath,
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
  });
}

async function tryResolveJsConstants(
  importSpecifier: string,
  context: CompanionResolutionContext,
): Promise<ResolvedCompanionState | null> {
  let resolvedPath: string;
  try {
    resolvedPath = resolveCompanionSpecifier(importSpecifier, context);
  } catch (error) {
    if (isFallthroughResolutionError(error)) {
      return null;
    }
    return buildInvalidState(importSpecifier);
  }

  let companionModule: CompanionModule;
  try {
    companionModule = (await import(pathToFileURL(resolvedPath).href)) as CompanionModule;
  } catch {
    return buildInvalidState(importSpecifier, resolvedPath);
  }

  const clientId = normalizeCredential(companionModule.ANTIGRAVITY_CLIENT_ID);
  const clientSecret = normalizeCredential(companionModule.ANTIGRAVITY_CLIENT_SECRET);
  if (!clientId || !clientSecret) {
    return buildInvalidState(importSpecifier, resolvedPath);
  }

  return buildConfiguredState({ importSpecifier, resolvedPath, clientId, clientSecret });
}

async function tryRuntimeCredentialPaths(): Promise<ResolvedCompanionState | null> {
  for (const candidatePath of getRuntimeCredentialPaths()) {
    const resolved = await tryReadCredentialsPath(COMPANION_SOURCE_IMPORT_SPECIFIER, candidatePath);
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

async function tryResolveSourceConstants(
  context: CompanionResolutionContext,
): Promise<ResolvedCompanionState | null> {
  let resolvedPath: string;
  try {
    resolvedPath = resolveCompanionSpecifier(COMPANION_SOURCE_IMPORT_SPECIFIER, context);
  } catch (error) {
    return isFallthroughResolutionError(error)
      ? null
      : buildInvalidState(COMPANION_SOURCE_IMPORT_SPECIFIER);
  }

  return (
    (await tryReadCredentialsPath(COMPANION_SOURCE_IMPORT_SPECIFIER, resolvedPath)) ??
    buildInvalidState(COMPANION_SOURCE_IMPORT_SPECIFIER, resolvedPath)
  );
}

async function tryResolvePackageJson(
  context: CompanionResolutionContext,
): Promise<ResolvedCompanionState | null> {
  let packageJsonPath: string;
  try {
    packageJsonPath = resolveCompanionSpecifier(COMPANION_PACKAGE_JSON_SPECIFIER, context);
  } catch (error) {
    return isFallthroughResolutionError(error)
      ? null
      : buildInvalidState(COMPANION_PACKAGE_JSON_SPECIFIER);
  }

  const packageRoot = dirname(packageJsonPath);
  for (const candidatePath of getPackageCredentialPaths(packageRoot)) {
    const resolved = await tryReadCredentialsPath(COMPANION_PACKAGE_JSON_SPECIFIER, candidatePath);
    if (resolved) {
      return resolved;
    }
  }

  return buildInvalidState(COMPANION_PACKAGE_JSON_SPECIFIER, packageJsonPath);
}

async function tryResolvePackageEntry(
  context: CompanionResolutionContext,
): Promise<ResolvedCompanionState | null> {
  let packageEntryPath: string;
  try {
    packageEntryPath = resolveCompanionSpecifier(COMPANION_PACKAGE_NAME, context);
  } catch (error) {
    return isFallthroughResolutionError(error) ? null : buildInvalidState(COMPANION_PACKAGE_NAME);
  }

  return (
    (await tryReadCredentialsPath(COMPANION_PACKAGE_NAME, packageEntryPath)) ??
    buildInvalidState(COMPANION_PACKAGE_NAME, packageEntryPath)
  );
}

async function resolveCompanionState(): Promise<ResolvedCompanionState> {
  const context: CompanionResolutionContext = { packageFound: false };

  for (const importSpecifier of COMPANION_JS_IMPORT_SPECIFIERS) {
    const resolved = await tryResolveJsConstants(importSpecifier, context);
    if (resolved) {
      return resolved;
    }
  }

  const runtimeResolved = await tryRuntimeCredentialPaths();
  if (runtimeResolved) {
    return runtimeResolved;
  }

  const sourceResolved = await tryResolveSourceConstants(context);
  if (sourceResolved) {
    return sourceResolved;
  }

  const packageJsonResolved = await tryResolvePackageJson(context);
  if (packageJsonResolved) {
    return packageJsonResolved;
  }

  const packageEntryResolved = await tryResolvePackageEntry(context);
  if (packageEntryResolved) {
    return packageEntryResolved;
  }

  if (context.packageFound) {
    return buildInvalidState(COMPANION_PACKAGE_NAME);
  }

  return {
    presence: {
      state: "missing",
      importSpecifier: COMPANION_SOURCE_IMPORT_SPECIFIER,
      error: COMPANION_MISSING_ERROR,
    },
    credentials: {
      state: "missing",
      error: COMPANION_MISSING_ERROR,
    },
  };
}

async function getResolvedCompanionState(): Promise<ResolvedCompanionState> {
  if (!resolvedCompanionStatePromise) {
    resolvedCompanionStatePromise = resolveCompanionState();
  }
  return resolvedCompanionStatePromise;
}

export async function inspectAntigravityCompanionPresence(): Promise<GoogleAntigravityCompanionPresence> {
  const resolved = await getResolvedCompanionState();
  return resolved.presence;
}

export async function resolveAntigravityClientCredentials(): Promise<GoogleAntigravityClientCredentials> {
  const resolved = await getResolvedCompanionState();
  return resolved.credentials;
}

export function clearAntigravityCompanionCacheForTests(): void {
  resolvedCompanionStatePromise = null;
}
