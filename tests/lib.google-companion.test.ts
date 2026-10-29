import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const moduleMocks = vi.hoisted(() => ({
  resolveImpl: vi.fn<(specifier: string, options?: { paths?: string[] }) => string>(),
  runtimeDirs: { value: { cacheDirs: [] as string[] } },
}));

vi.mock("node:module", () => ({
  createRequire: () => ({ resolve: moduleMocks.resolveImpl }),
}));
vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirCandidates: () => moduleMocks.runtimeDirs.value,
}));

type Presence = {
  state: "present" | "missing" | "invalid";
  importSpecifier: string;
  resolvedPath?: string;
  error?: string;
};
type Credentials = {
  state: "configured" | "missing" | "invalid";
  clientId?: string;
  clientSecret?: string;
  resolvedPath?: string;
  error?: string;
};
type LoadedCompanion = {
  inspect: () => Promise<Presence>;
  resolve: () => Promise<Credentials>;
  clear: () => void;
};
type CompanionCase = {
  id: "agy" | "gemini";
  packageName: string;
  sourceSpecifier: string;
  dynamicSpecifier: string;
  clientIdExport: string;
  clientSecretExport: string;
  runtimeCandidates: readonly (readonly string[])[];
  packageJsonCandidates: readonly (readonly string[])[];
  missingError: string;
  invalidError: string;
  load: () => Promise<LoadedCompanion>;
};

const companions: readonly CompanionCase[] = [
  {
    id: "agy",
    packageName: "@anthonyhaussman/opencode-agy-auth",
    sourceSpecifier: "@anthonyhaussman/opencode-agy-auth/src/constants.ts",
    dynamicSpecifier: "@anthonyhaussman/opencode-agy-auth/dist/src/constants.js",
    clientIdExport: "AGY_CLIENT_ID",
    clientSecretExport: "AGY_CLIENT_SECRET",
    runtimeCandidates: [
      ["src", "constants.ts"],
      ["src", "constants.js"],
      ["dist", "src", "constants.js"],
      ["dist", "index.js"],
    ],
    packageJsonCandidates: [
      ["src", "constants.ts"],
      ["dist", "index.js"],
    ],
    missingError:
      "Install @anthonyhaussman/opencode-agy-auth separately to enable Google AGY quota",
    invalidError: "Installed @anthonyhaussman/opencode-agy-auth package is incompatible",
    load: async () => {
      const mod = await import("../src/lib/google-agy-companion.js");
      return {
        inspect: mod.inspectAgyCompanionPresence,
        resolve: mod.resolveAgyClientCredentials,
        clear: mod.clearAgyCompanionCacheForTests,
      };
    },
  },
  {
    id: "gemini",
    packageName: "opencode-gemini-auth",
    sourceSpecifier: "opencode-gemini-auth/src/constants.ts",
    dynamicSpecifier: "opencode-gemini-auth/dist/src/constants.js",
    clientIdExport: "GEMINI_CLIENT_ID",
    clientSecretExport: "GEMINI_CLIENT_SECRET",
    runtimeCandidates: [
      ["src", "constants.ts"],
      ["src", "constants.js"],
      ["dist", "src", "constants.js"],
      ["dist", "index.js"],
    ],
    packageJsonCandidates: [
      ["src", "constants.ts"],
      ["dist", "index.js"],
    ],
    missingError: "Install opencode-gemini-auth separately to enable Gemini CLI quota",
    invalidError: "Installed opencode-gemini-auth package is incompatible",
    load: async () => {
      const mod = await import("../src/lib/google-gemini-cli-companion.js");
      return {
        inspect: mod.inspectGeminiCliCompanionPresence,
        resolve: mod.resolveGeminiCliClientCredentials,
        clear: mod.clearGeminiCliCompanionCacheForTests,
      };
    },
  },
];

function codedError(code: string, message: string): Error & { code?: string } {
  return Object.assign(new Error(message), { code });
}
function moduleNotFound(): Error & { code?: string } {
  return codedError("MODULE_NOT_FOUND", "Cannot find module");
}
function packagePathNotExported(): Error & { code?: string } {
  return codedError("ERR_PACKAGE_PATH_NOT_EXPORTED", "Package subpath is not exported");
}
function writeCredentials(
  path: string,
  companion: CompanionCase,
  declaration: "export const" | "const" | "var" = "export const",
  suffix = "",
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    [
      `${declaration} ${companion.clientIdExport} = 'client-id${suffix}';`,
      `${declaration} ${companion.clientSecretExport} = 'client-secret${suffix}';`,
    ].join("\n"),
    "utf8",
  );
}
async function loadWith(
  companion: CompanionCase,
  resolveImpl: (specifier: string, options?: { paths?: string[] }) => string,
  cacheDirs: string[] = [],
): Promise<LoadedCompanion> {
  vi.resetModules();
  moduleMocks.resolveImpl.mockReset();
  moduleMocks.runtimeDirs.value = { cacheDirs };
  moduleMocks.resolveImpl.mockImplementation(resolveImpl);
  return companion.load();
}
async function expectConfigured(
  loaded: LoadedCompanion,
  resolvedPath: string,
  suffix = "",
): Promise<void> {
  await expect(loaded.resolve()).resolves.toEqual({
    state: "configured",
    clientId: `client-id${suffix}`,
    clientSecret: `client-secret${suffix}`,
    resolvedPath,
  });
}

describe("google companion credential resolution", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "opencode-quota-google-companion-"));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("preserves exact missing results for every companion", async () => {
    for (const companion of companions) {
      const loaded = await loadWith(companion, () => {
        throw moduleNotFound();
      });
      await expect(loaded.inspect()).resolves.toEqual({
        state: "missing",
        importSpecifier: companion.sourceSpecifier,
        error: companion.missingError,
      });
      await expect(loaded.resolve()).resolves.toEqual({
        state: "missing",
        error: companion.missingError,
      });
    }
  });

  it("loads dynamic exports, shares the cached promise, and resets it", async () => {
    for (const companion of companions) {
      const modulePath = join(tempDir, `${companion.id}-dynamic.mjs`);
      writeCredentials(modulePath, companion);
      const loaded = await loadWith(companion, (specifier) => {
        if (specifier === companion.dynamicSpecifier) return modulePath;
        throw moduleNotFound();
      });
      const [presence, credentials] = await Promise.all([loaded.inspect(), loaded.resolve()]);
      expect(presence).toEqual({
        state: "present",
        importSpecifier: companion.dynamicSpecifier,
        resolvedPath: modulePath,
      });
      expect(credentials).toMatchObject({ state: "configured", resolvedPath: modulePath });
      expect(moduleMocks.resolveImpl).toHaveBeenCalledTimes(1);
      loaded.clear();
      await expectConfigured(loaded, modulePath);
      expect(moduleMocks.resolveImpl).toHaveBeenCalledTimes(2);
    }
  });

  it("rejects dynamic modules without both non-empty named exports", async () => {
    for (const companion of companions) {
      const modulePath = join(tempDir, `${companion.id}-invalid.mjs`);
      writeFileSync(modulePath, `export const ${companion.clientIdExport} = '';\n`, "utf8");
      const loaded = await loadWith(companion, () => modulePath);
      await expect(loaded.inspect()).resolves.toEqual({
        state: "invalid",
        importSpecifier: companion.dynamicSpecifier,
        resolvedPath: modulePath,
        error: companion.invalidError,
      });
    }
  });

  it("parses only the supported export const, const, and var declarations", async () => {
    for (const companion of companions) {
      for (const declaration of ["export const", "const", "var"] as const) {
        const constantsPath = join(tempDir, `${companion.id}-${declaration.replace(" ", "-")}.ts`);
        writeCredentials(constantsPath, companion, declaration);
        const loaded = await loadWith(companion, (specifier) => {
          if (specifier === companion.sourceSpecifier) return constantsPath;
          throw moduleNotFound();
        });
        await expectConfigured(loaded, constantsPath);
      }
    }
  });

  it("classifies package export blocks as installed but invalid", async () => {
    for (const companion of companions) {
      const loaded = await loadWith(companion, (specifier) => {
        if (specifier.startsWith(`${companion.packageName}/`)) throw packagePathNotExported();
        throw moduleNotFound();
      });
      await expect(loaded.inspect()).resolves.toEqual({
        state: "invalid",
        importSpecifier: companion.packageName,
        error: companion.invalidError,
      });
    }
  });

  it("falls through export blocks to static credentials in the package entry", async () => {
    for (const companion of companions) {
      const entryPath = join(tempDir, companion.id, "dist", "index.js");
      writeCredentials(entryPath, companion, "var");
      const loaded = await loadWith(companion, (specifier) => {
        if (specifier === companion.packageName) return entryPath;
        if (specifier.startsWith(`${companion.packageName}/`)) throw packagePathNotExported();
        throw moduleNotFound();
      });
      await expectConfigured(loaded, entryPath);
    }
  });

  it("turns non-fallthrough resolution failures into exact invalid results", async () => {
    for (const companion of companions) {
      const loaded = await loadWith(companion, () => {
        throw new Error("resolver failed");
      });
      await expect(loaded.inspect()).resolves.toEqual({
        state: "invalid",
        importSpecifier: companion.dynamicSpecifier,
        error: companion.invalidError,
      });
    }
  });

  it("preserves each provider's source-versus-runtime stage order", async () => {
    for (const companion of companions) {
      const cacheDir = join(tempDir, `${companion.id}-order-cache`);
      const runtimePath = join(
        cacheDir,
        "node_modules",
        companion.packageName,
        ...companion.runtimeCandidates[0]!,
      );
      const sourcePath = join(tempDir, `${companion.id}-resolved-source.ts`);
      writeCredentials(runtimePath, companion, "var", "-runtime");
      writeCredentials(sourcePath, companion, "const", "-source");
      const loaded = await loadWith(
        companion,
        (specifier) => {
          if (specifier === companion.sourceSpecifier) return sourcePath;
          throw moduleNotFound();
        },
        [cacheDir],
      );
      await expectConfigured(loaded, sourcePath, "-source");
    }
  });

  it("preserves provider-specific runtime read-error handling", async () => {
    for (const companion of companions) {
      const cacheDir = join(tempDir, `${companion.id}-read-error-cache`);
      const packageRoot = join(cacheDir, "node_modules", companion.packageName);
      const unreadablePath = join(packageRoot, ...companion.runtimeCandidates[0]!);
      const fallbackPath = join(packageRoot, ...companion.runtimeCandidates[1]!);
      mkdirSync(unreadablePath, { recursive: true });
      writeCredentials(fallbackPath, companion, "var");
      const loaded = await loadWith(companion, () => {
        throw moduleNotFound();
      }, [cacheDir]);
      await expectConfigured(loaded, fallbackPath);
    }
  });

  it("reads every provider-specific package.json candidate in order", async () => {
    for (const companion of companions) {
      for (const [index, parts] of companion.packageJsonCandidates.entries()) {
        const packageRoot = join(tempDir, `${companion.id}-package-json-${index}`);
        const packageJsonPath = join(packageRoot, "package.json");
        const candidatePath = join(packageRoot, ...parts);
        mkdirSync(packageRoot, { recursive: true });
        writeFileSync(packageJsonPath, "{}", "utf8");
        writeCredentials(candidatePath, companion, "var");
        const loaded = await loadWith(companion, (specifier) => {
          if (specifier === `${companion.packageName}/package.json`) return packageJsonPath;
          throw moduleNotFound();
        });
        await expectConfigured(loaded, candidatePath);
      }
    }
  });

  it("scans both direct and nested AGY scoped runtime package roots", async () => {
    const companion = companions[0]!;
    for (const nested of [false, true]) {
      const cacheDir = join(tempDir, `agy-scoped-${nested}`);
      const packageRoot = join(cacheDir, "packages", "@anthonyhaussman", "opencode-agy-auth-1.0.0");
      const credentialRoot = nested
        ? join(packageRoot, "node_modules", companion.packageName)
        : packageRoot;
      const candidatePath = join(credentialRoot, "dist", "index.js");
      writeCredentials(candidatePath, companion, "var");
      const loaded = await loadWith(companion, () => {
        throw moduleNotFound();
      }, [cacheDir]);
      await expectConfigured(loaded, candidatePath);
    }
  });

  it("supports Gemini root-only bundles and runtime-path package resolution", async () => {
    const companion = companions[1]!;
    const cacheDir = join(tempDir, "gemini-runtime-cache");
    const rootBundle = join(cacheDir, "node_modules", companion.packageName, "dist", "index.js");
    writeCredentials(rootBundle, companion, "var", "-root");
    let loaded = await loadWith(companion, () => {
      throw moduleNotFound();
    }, [cacheDir]);
    await expectConfigured(loaded, rootBundle, "-root");

    const resolvedRoot = join(tempDir, "gemini-resolved-root", "dist", "index.js");
    const resolvedCacheDir = join(tempDir, "gemini-resolved-cache");
    writeCredentials(resolvedRoot, companion, "var", "-resolved");
    loaded = await loadWith(
      companion,
      (specifier, options) => {
        if (specifier === companion.packageName && options?.paths?.includes(resolvedCacheDir)) {
          return resolvedRoot;
        }
        if (specifier.startsWith(`${companion.packageName}/`)) throw packagePathNotExported();
        throw moduleNotFound();
      },
      [resolvedCacheDir],
    );
    await expectConfigured(loaded, resolvedRoot, "-resolved");
    expect(moduleMocks.resolveImpl).toHaveBeenCalledWith(companion.packageName, {
      paths: [resolvedCacheDir],
    });
  });
});
