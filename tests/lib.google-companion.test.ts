import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const moduleMocks = vi.hoisted(() => ({
  resolveImpl: vi.fn<(specifier: string, options?: { paths?: string[] }) => string>(),
  runtimeDirs: { value: { cacheDir: "" } },
}));

vi.mock("node:module", () => ({
  createRequire: () => ({ resolve: moduleMocks.resolveImpl }),
}));
vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirs: () => moduleMocks.runtimeDirs.value,
}));

type Resolver = typeof import("../src/lib/google-companion-credentials.js").agyCompanion;
type ResolveImpl = (specifier: string, options?: { paths?: string[] }) => string;

const companions = [
  {
    id: "agyCompanion",
    packageName: "@anthonyhaussman/opencode-agy-auth",
    clientIdExport: "AGY_CLIENT_ID",
    clientSecretExport: "AGY_CLIENT_SECRET",
    missingError:
      "Install @anthonyhaussman/opencode-agy-auth separately to enable Google AGY quota",
    invalidError: "Installed @anthonyhaussman/opencode-agy-auth package is incompatible",
  },
  {
    id: "geminiCliCompanion",
    packageName: "opencode-gemini-auth",
    clientIdExport: "GEMINI_CLIENT_ID",
    clientSecretExport: "GEMINI_CLIENT_SECRET",
    missingError: "Install opencode-gemini-auth separately to enable Gemini CLI quota",
    invalidError: "Installed opencode-gemini-auth package is incompatible",
  },
] as const;

function codedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
function moduleNotFound(): Error {
  return codedError("MODULE_NOT_FOUND", "Cannot find module");
}
function packagePathNotExported(): Error {
  return codedError("ERR_PACKAGE_PATH_NOT_EXPORTED", "Package subpath is not exported");
}
const notFound: ResolveImpl = () => {
  throw moduleNotFound();
};

describe.each(companions)("$packageName companion credentials", (companion) => {
  const sourceSpecifier = `${companion.packageName}/src/constants.ts`;
  const dynamicSpecifier = `${companion.packageName}/dist/src/constants.js`;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "opencode-quota-google-companion-"));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeCredentials(
    path: string,
    declaration: "export const" | "const" | "var" = "var",
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

  /** A fresh resolver whose `require.resolve` is `resolveImpl` and whose cache is `cacheDir`. */
  async function load(
    resolveImpl: ResolveImpl,
    cacheDir = join(tempDir, "empty-cache"),
  ): Promise<Resolver> {
    vi.resetModules();
    moduleMocks.resolveImpl.mockReset();
    moduleMocks.resolveImpl.mockImplementation(resolveImpl);
    moduleMocks.runtimeDirs.value = { cacheDir };
    return (await import("../src/lib/google-companion-credentials.js"))[companion.id];
  }

  async function expectConfigured(resolver: Resolver, resolvedPath: string, suffix = "") {
    await expect(resolver.resolveCredentials()).resolves.toEqual({
      state: "configured",
      clientId: `client-id${suffix}`,
      clientSecret: `client-secret${suffix}`,
      resolvedPath,
    });
  }

  function opencode2Bundle(cacheDir: string, spec: string, generation: string): string {
    const { packageName } = companion;
    return join(cacheDir, "npm", `${packageName}@${spec}`, generation, "node_modules", packageName);
  }

  it("preserves exact missing results", async () => {
    const resolver = await load(notFound);
    await expect(resolver.inspect()).resolves.toEqual({
      state: "missing",
      importSpecifier: sourceSpecifier,
      error: companion.missingError,
    });
    await expect(resolver.resolveCredentials()).resolves.toEqual({
      state: "missing",
      error: companion.missingError,
    });
  });

  it("loads dynamic exports, shares the cached promise, and resets it", async () => {
    const modulePath = join(tempDir, "dynamic.mjs");
    writeCredentials(modulePath, "export const");
    const resolver = await load((specifier) => {
      if (specifier === dynamicSpecifier) return modulePath;
      throw moduleNotFound();
    });

    const [presence, credentials] = await Promise.all([
      resolver.inspect(),
      resolver.resolveCredentials(),
    ]);
    expect(presence).toEqual({
      state: "present",
      importSpecifier: dynamicSpecifier,
      resolvedPath: modulePath,
    });
    expect(credentials).toMatchObject({ state: "configured", resolvedPath: modulePath });
    expect(moduleMocks.resolveImpl).toHaveBeenCalledTimes(1);
    resolver.clearCacheForTests();
    await expectConfigured(resolver, modulePath);
    expect(moduleMocks.resolveImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects dynamic modules without both non-empty named exports", async () => {
    const modulePath = join(tempDir, "invalid.mjs");
    writeFileSync(modulePath, `export const ${companion.clientIdExport} = '';\n`, "utf8");
    const resolver = await load(() => modulePath);
    await expect(resolver.inspect()).resolves.toEqual({
      state: "invalid",
      importSpecifier: dynamicSpecifier,
      resolvedPath: modulePath,
      error: companion.invalidError,
    });
  });

  it.each(["export const", "const", "var"] as const)(
    "parses a %s declaration in the source constants file",
    async (declaration) => {
      const constantsPath = join(tempDir, "constants.ts");
      writeCredentials(constantsPath, declaration);
      const resolver = await load((specifier) => {
        if (specifier === sourceSpecifier) return constantsPath;
        throw moduleNotFound();
      });
      await expectConfigured(resolver, constantsPath);
    },
  );

  it("classifies package export blocks as installed but invalid", async () => {
    const resolver = await load((specifier) => {
      if (specifier.startsWith(`${companion.packageName}/`)) throw packagePathNotExported();
      throw moduleNotFound();
    });
    await expect(resolver.inspect()).resolves.toEqual({
      state: "invalid",
      importSpecifier: companion.packageName,
      error: companion.invalidError,
    });
  });

  it("falls through export blocks to the package entry, resolved from the runtime cache", async () => {
    const entryPath = join(tempDir, "resolved-root", "dist", "index.js");
    const cacheDir = join(tempDir, "resolved-cache");
    writeCredentials(entryPath);
    const resolver = await load((specifier, options) => {
      if (specifier === companion.packageName && options?.paths?.includes(cacheDir)) {
        return entryPath;
      }
      if (specifier.startsWith(`${companion.packageName}/`)) throw packagePathNotExported();
      throw moduleNotFound();
    }, cacheDir);
    await expectConfigured(resolver, entryPath);
    expect(moduleMocks.resolveImpl).toHaveBeenCalledWith(companion.packageName, {
      paths: [cacheDir],
    });
  });

  it("turns non-fallthrough resolution failures into exact invalid results", async () => {
    const resolver = await load(() => {
      throw new Error("resolver failed");
    });
    await expect(resolver.inspect()).resolves.toEqual({
      state: "invalid",
      importSpecifier: dynamicSpecifier,
      error: companion.invalidError,
    });
  });

  it("prefers the resolved source file over runtime cache installs", async () => {
    const cacheDir = join(tempDir, "order-cache");
    const sourcePath = join(tempDir, "resolved-source.ts");
    writeCredentials(join(cacheDir, "node_modules", companion.packageName, "src", "constants.ts"));
    writeCredentials(sourcePath, "const", "-source");
    const resolver = await load((specifier) => {
      if (specifier === sourceSpecifier) return sourcePath;
      throw moduleNotFound();
    }, cacheDir);
    await expectConfigured(resolver, sourcePath, "-source");
  });

  it("skips an unreadable runtime candidate and reads the next one", async () => {
    const cacheDir = join(tempDir, "read-error-cache");
    const packageRoot = join(cacheDir, "node_modules", companion.packageName);
    mkdirSync(join(packageRoot, "src", "constants.ts"), { recursive: true });
    writeCredentials(join(packageRoot, "src", "constants.js"));
    const resolver = await load(notFound, cacheDir);
    await expectConfigured(resolver, join(packageRoot, "src", "constants.js"));
  });

  it.each([
    ["src", "constants.ts"],
    ["dist", "index.js"],
  ])("reads the %s/%s candidate next to the resolved package.json", async (...parts) => {
    const packageJsonPath = join(tempDir, "package-root", "package.json");
    const candidatePath = join(tempDir, "package-root", ...parts);
    writeCredentials(candidatePath);
    writeFileSync(packageJsonPath, "{}", "utf8");
    const resolver = await load((specifier) => {
      if (specifier === `${companion.packageName}/package.json`) return packageJsonPath;
      throw moduleNotFound();
    });
    await expectConfigured(resolver, candidatePath);
  });

  it("scans direct and nested OpenCode 1 package roots", async () => {
    // `packages/@scope/name-1.0.0` for scoped packages, `packages/name-1.0.0` otherwise.
    const packagesDir = join(tempDir, "packages-cache", "packages");
    const installDir = join(packagesDir, `${companion.packageName}-1.0.0`);
    for (const nested of [false, true]) {
      rmSync(packagesDir, { recursive: true, force: true });
      const root = nested ? join(installDir, "node_modules", companion.packageName) : installDir;
      writeCredentials(join(root, "dist", "index.js"));
      const resolver = await load(notFound, dirname(packagesDir));
      await expectConfigured(resolver, join(root, "dist", "index.js"));
    }
  });

  it("picks the OpenCode 2 install that OpenCode 2 loads", async () => {
    const cacheDir = join(tempDir, "opencode2-pick");
    const bundle = (spec: string, generation: string) =>
      join(opencode2Bundle(cacheDir, spec, generation), "dist", "index.js");
    writeCredentials(bundle("latest", "999"), "var", "-older-generation");
    writeCredentials(bundle("latest", "1000"), "var", "-newest");
    writeCredentials(bundle("alpha", "998"), "var", "-older-spec");
    mkdirSync(join(cacheDir, "npm", `${companion.packageName}@latest`, ".staging-2000-x"), {
      recursive: true,
    });
    writeCredentials(
      join(cacheDir, "node_modules", companion.packageName, "dist", "index.js"),
      "var",
      "-opencode1",
    );

    const resolver = await load(notFound, cacheDir);
    await expect(resolver.inspect()).resolves.toEqual({
      state: "present",
      importSpecifier: sourceSpecifier,
      resolvedPath: bundle("latest", "1000"),
    });
    await expectConfigured(resolver, bundle("latest", "1000"), "-newest");
  });

  it("reports a missing companion when OpenCode 2 has not installed it", async () => {
    const cacheDir = join(tempDir, "opencode2-missing");
    mkdirSync(join(cacheDir, "npm", `${companion.packageName}@latest`), { recursive: true });
    writeCredentials(
      join(cacheDir, "npm", "other-plugin@latest", "1", "node_modules", "other-plugin", "index.js"),
    );
    const resolver = await load(notFound, cacheDir);
    await expect(resolver.inspect()).resolves.toEqual({
      state: "missing",
      importSpecifier: sourceSpecifier,
      error: companion.missingError,
    });
  });
});
