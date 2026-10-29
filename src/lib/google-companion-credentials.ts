import { readFile } from "fs/promises";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { getOpencodeRuntimeDirCandidates } from "./opencode-runtime-paths.js";

const require = createRequire(import.meta.url);

type RelativePath = readonly string[];
type ReadErrorPolicy = "fallthrough-all" | "fallthrough-missing";

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

export type GoogleCompanionClientCredentials =
  | GoogleCompanionConfiguredCredentials
  | {
      state: "missing" | "invalid";
      error: string;
      resolvedPath?: string;
    };

type ResolvedCompanionState = {
  presence: GoogleCompanionPresence;
  credentials: GoogleCompanionClientCredentials;
};

type ResolutionContext = { packageFound: boolean };

export type GoogleCompanionResolutionStage =
  | { kind: "dynamic-import"; specifiers: readonly string[] }
  | {
      kind: "runtime-files";
      importSpecifier: string;
      candidatePaths: readonly RelativePath[];
      readErrors: ReadErrorPolicy;
    }
  | {
      kind: "source-specifier";
      importSpecifier: string;
      searchRuntimePaths: boolean;
      readErrors: ReadErrorPolicy;
    }
  | {
      kind: "package-json";
      importSpecifier: string;
      candidateImportSpecifier: string;
      candidatePaths: readonly RelativePath[];
      readErrors: ReadErrorPolicy;
      resolutionErrorImportSpecifier: string;
      exhaustedInvalidPath: "package-json" | "first-candidate";
    }
  | {
      kind: "package-entry";
      importSpecifier: string;
      readErrors: ReadErrorPolicy;
    };

export type GoogleCompanionDescriptor = {
  packageName: string;
  packageScan: "scoped" | "unscoped";
  clientIdExport: string;
  clientSecretExport: string;
  missingImportSpecifier: string;
  missingError: string;
  invalidError: string;
  stages: readonly GoogleCompanionResolutionStage[];
};

function isModuleNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("code" in error && error.code === "MODULE_NOT_FOUND") return true;
  return error instanceof Error && error.message.includes("Cannot find module");
}

function isPackagePathNotExportedError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED",
  );
}

function isFallthroughResolutionError(error: unknown): boolean {
  return isModuleNotFoundError(error) || isPackagePathNotExportedError(error);
}

function isMissingFileError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}

function markPackageFound(error: unknown, context: ResolutionContext): void {
  if (isPackagePathNotExportedError(error)) context.packageFound = true;
}

function resolveSpecifier(
  specifier: string,
  searchRuntimePaths: boolean,
  context: ResolutionContext,
): string {
  try {
    return require.resolve(specifier);
  } catch (error) {
    markPackageFound(error, context);
    if (!searchRuntimePaths || !isFallthroughResolutionError(error)) throw error;

    try {
      return require.resolve(specifier, {
        paths: getOpencodeRuntimeDirCandidates().cacheDirs,
      });
    } catch (runtimeError) {
      markPackageFound(runtimeError, context);
      throw runtimeError;
    }
  }
}

function getRuntimePackageRoots(descriptor: GoogleCompanionDescriptor): string[] {
  const cacheDirs = getOpencodeRuntimeDirCandidates().cacheDirs;
  const packageRoots = cacheDirs.map((cacheDir) =>
    join(cacheDir, "node_modules", descriptor.packageName),
  );

  for (const cacheDir of cacheDirs) {
    try {
      const packagesDir = join(cacheDir, "packages");
      if (descriptor.packageScan === "scoped") {
        const [scope, name] = descriptor.packageName.split("/");
        const scopeDir = join(packagesDir, scope!);
        for (const entry of readdirSync(scopeDir, { withFileTypes: true })) {
          if (entry.isDirectory() && entry.name.startsWith(name!)) {
            const packagePath = join(scopeDir, entry.name);
            packageRoots.push(packagePath);
            packageRoots.push(join(packagePath, "node_modules", descriptor.packageName));
          }
        }
      } else {
        for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
          if (entry.isDirectory() && entry.name.startsWith(descriptor.packageName)) {
            const packagePath = join(packagesDir, entry.name);
            packageRoots.push(packagePath);
            packageRoots.push(join(packagePath, "node_modules", descriptor.packageName));
          }
        }
      }
    } catch {
      // A missing runtime packages directory is not an installed companion.
    }
  }

  return packageRoots;
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

function buildInvalidState(
  descriptor: GoogleCompanionDescriptor,
  importSpecifier: string,
  resolvedPath?: string,
): ResolvedCompanionState {
  return {
    presence: {
      state: "invalid",
      importSpecifier,
      ...(resolvedPath ? { resolvedPath } : {}),
      error: descriptor.invalidError,
    },
    credentials: {
      state: "invalid",
      ...(resolvedPath ? { resolvedPath } : {}),
      error: descriptor.invalidError,
    },
  };
}

function parseSourceCredentials(
  descriptor: GoogleCompanionDescriptor,
  content: string,
): { clientId: string; clientSecret: string } | null {
  const readConstant = (name: string): string => {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return (
      content
        .match(
          new RegExp(`(?:export\\s+const|const|var)\\s+${escapedName}\\s*=\\s*["']([^"']+)["']`),
        )?.[1]
        ?.trim() ?? ""
    );
  };

  const clientId = readConstant(descriptor.clientIdExport);
  const clientSecret = readConstant(descriptor.clientSecretExport);
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

async function readCredentialsPath(
  descriptor: GoogleCompanionDescriptor,
  importSpecifier: string,
  resolvedPath: string,
  readErrors: ReadErrorPolicy,
): Promise<ResolvedCompanionState | null> {
  let content: string;
  try {
    content = await readFile(resolvedPath, "utf8");
  } catch (error) {
    if (readErrors === "fallthrough-all" || isMissingFileError(error)) return null;
    return buildInvalidState(descriptor, importSpecifier, resolvedPath);
  }

  const credentials = parseSourceCredentials(descriptor, content);
  return credentials
    ? buildConfiguredState({ importSpecifier, resolvedPath, ...credentials })
    : buildInvalidState(descriptor, importSpecifier, resolvedPath);
}

async function resolveStage(
  descriptor: GoogleCompanionDescriptor,
  stage: GoogleCompanionResolutionStage,
  context: ResolutionContext,
): Promise<ResolvedCompanionState | null> {
  if (stage.kind === "dynamic-import") {
    for (const importSpecifier of stage.specifiers) {
      let resolvedPath: string;
      try {
        resolvedPath = resolveSpecifier(importSpecifier, true, context);
      } catch (error) {
        if (isFallthroughResolutionError(error)) continue;
        return buildInvalidState(descriptor, importSpecifier);
      }

      let companionModule: Record<string, unknown>;
      try {
        companionModule = (await import(pathToFileURL(resolvedPath).href)) as Record<
          string,
          unknown
        >;
      } catch {
        return buildInvalidState(descriptor, importSpecifier, resolvedPath);
      }

      const clientId = companionModule[descriptor.clientIdExport];
      const clientSecret = companionModule[descriptor.clientSecretExport];
      if (
        typeof clientId !== "string" ||
        !clientId.trim() ||
        typeof clientSecret !== "string" ||
        !clientSecret.trim()
      ) {
        return buildInvalidState(descriptor, importSpecifier, resolvedPath);
      }
      return buildConfiguredState({
        importSpecifier,
        resolvedPath,
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
      });
    }
    return null;
  }

  if (stage.kind === "runtime-files") {
    for (const packageRoot of getRuntimePackageRoots(descriptor)) {
      for (const parts of stage.candidatePaths) {
        const resolved = await readCredentialsPath(
          descriptor,
          stage.importSpecifier,
          join(packageRoot, ...parts),
          stage.readErrors,
        );
        if (resolved) return resolved;
      }
    }
    return null;
  }

  if (stage.kind === "source-specifier") {
    let resolvedPath: string;
    try {
      resolvedPath = resolveSpecifier(stage.importSpecifier, stage.searchRuntimePaths, context);
    } catch (error) {
      return isFallthroughResolutionError(error)
        ? null
        : buildInvalidState(descriptor, stage.importSpecifier);
    }
    return (
      (await readCredentialsPath(
        descriptor,
        stage.importSpecifier,
        resolvedPath,
        stage.readErrors,
      )) ?? buildInvalidState(descriptor, stage.importSpecifier, resolvedPath)
    );
  }

  if (stage.kind === "package-json") {
    let packageJsonPath: string;
    try {
      packageJsonPath = resolveSpecifier(stage.importSpecifier, true, context);
    } catch (error) {
      return isFallthroughResolutionError(error)
        ? null
        : buildInvalidState(descriptor, stage.resolutionErrorImportSpecifier);
    }

    const packageRoot = dirname(packageJsonPath);
    for (const parts of stage.candidatePaths) {
      const resolved = await readCredentialsPath(
        descriptor,
        stage.candidateImportSpecifier,
        join(packageRoot, ...parts),
        stage.readErrors,
      );
      if (resolved) return resolved;
    }

    const invalidPath =
      stage.exhaustedInvalidPath === "package-json"
        ? packageJsonPath
        : join(packageRoot, ...stage.candidatePaths[0]!);
    return buildInvalidState(descriptor, stage.candidateImportSpecifier, invalidPath);
  }

  let packageEntryPath: string;
  try {
    packageEntryPath = resolveSpecifier(stage.importSpecifier, true, context);
  } catch (error) {
    return isFallthroughResolutionError(error)
      ? null
      : buildInvalidState(descriptor, stage.importSpecifier);
  }
  return (
    (await readCredentialsPath(
      descriptor,
      stage.importSpecifier,
      packageEntryPath,
      stage.readErrors,
    )) ?? buildInvalidState(descriptor, stage.importSpecifier, packageEntryPath)
  );
}

export function createGoogleCompanionCredentialResolver(descriptor: GoogleCompanionDescriptor): {
  inspect: () => Promise<GoogleCompanionPresence>;
  resolveCredentials: () => Promise<GoogleCompanionClientCredentials>;
  clearCacheForTests: () => void;
} {
  let resolvedStatePromise: Promise<ResolvedCompanionState> | null = null;

  async function getResolvedState(): Promise<ResolvedCompanionState> {
    if (!resolvedStatePromise) {
      resolvedStatePromise = (async () => {
        const context: ResolutionContext = { packageFound: false };
        for (const stage of descriptor.stages) {
          const resolved = await resolveStage(descriptor, stage, context);
          if (resolved) return resolved;
        }

        if (context.packageFound) {
          return buildInvalidState(descriptor, descriptor.packageName);
        }
        return {
          presence: {
            state: "missing",
            importSpecifier: descriptor.missingImportSpecifier,
            error: descriptor.missingError,
          },
          credentials: { state: "missing", error: descriptor.missingError },
        };
      })();
    }
    return resolvedStatePromise;
  }

  return {
    inspect: async () => (await getResolvedState()).presence,
    resolveCredentials: async () => (await getResolvedState()).credentials,
    clearCacheForTests: () => {
      resolvedStatePromise = null;
    },
  };
}
