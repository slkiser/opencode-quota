import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

const COMPANION_PACKAGE_NAME = "opencode-antigravity-auth";
const COMPANION_IMPORT_SPECIFIER = `${COMPANION_PACKAGE_NAME}/dist/src/constants.js`;
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

async function resolveCompanionState(): Promise<ResolvedCompanionState> {
  let resolvedPath: string;

  try {
    resolvedPath = require.resolve(COMPANION_IMPORT_SPECIFIER);
  } catch (error) {
    if (isModuleNotFoundError(error)) {
      return {
        presence: {
          state: "missing",
          importSpecifier: COMPANION_IMPORT_SPECIFIER,
          error: COMPANION_MISSING_ERROR,
        },
        credentials: {
          state: "missing",
          error: COMPANION_MISSING_ERROR,
        },
      };
    }

    return {
      presence: {
        state: "invalid",
        importSpecifier: COMPANION_IMPORT_SPECIFIER,
        error: COMPANION_INVALID_ERROR,
      },
      credentials: {
        state: "invalid",
        error: COMPANION_INVALID_ERROR,
      },
    };
  }

  let companionModule: CompanionModule;
  try {
    companionModule = (await import(pathToFileURL(resolvedPath).href)) as CompanionModule;
  } catch {
    return {
      presence: {
        state: "invalid",
        importSpecifier: COMPANION_IMPORT_SPECIFIER,
        resolvedPath,
        error: COMPANION_INVALID_ERROR,
      },
      credentials: {
        state: "invalid",
        resolvedPath,
        error: COMPANION_INVALID_ERROR,
      },
    };
  }

  const clientId =
    typeof companionModule.ANTIGRAVITY_CLIENT_ID === "string"
      ? companionModule.ANTIGRAVITY_CLIENT_ID.trim()
      : "";
  const clientSecret =
    typeof companionModule.ANTIGRAVITY_CLIENT_SECRET === "string"
      ? companionModule.ANTIGRAVITY_CLIENT_SECRET.trim()
      : "";

  if (!clientId || !clientSecret) {
    return {
      presence: {
        state: "invalid",
        importSpecifier: COMPANION_IMPORT_SPECIFIER,
        resolvedPath,
        error: COMPANION_INVALID_ERROR,
      },
      credentials: {
        state: "invalid",
        resolvedPath,
        error: COMPANION_INVALID_ERROR,
      },
    };
  }

  return {
    presence: {
      state: "present",
      importSpecifier: COMPANION_IMPORT_SPECIFIER,
      resolvedPath,
    },
    credentials: {
      state: "configured",
      clientId,
      clientSecret,
      resolvedPath,
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
