import { homedir } from "os";
import { join } from "path";

type FsConfigMocks = {
  existsSync: any;
  readFile: any;
};

export function createRuntimePathsMockModule() {
  const dataDir = join(homedir(), ".local", "share", "opencode");
  const configDir = join(homedir(), ".config", "opencode");
  const cacheDir = join(homedir(), ".cache", "opencode");
  const stateDir = join(homedir(), ".local", "state", "opencode");

  return {
    getOpencodeRuntimeDirCandidates: () => ({
      dataDirs: [dataDir],
      configDirs: [configDir],
      cacheDirs: [cacheDir],
      stateDirs: [stateDir],
    }),
    getOpencodeRuntimeDirs: () => ({
      dataDir,
      configDir,
      cacheDir,
      stateDir,
    }),
  };
}

export function getTrustedOpencodeConfigPaths() {
  const configDir = join(homedir(), ".config", "opencode");
  return {
    jsonc: join(configDir, "opencode.jsonc"),
    json: join(configDir, "opencode.json"),
  };
}

export function resetProcessEnv(originalEnv: NodeJS.ProcessEnv, keysToDelete: string[]): void {
  process.env = { ...originalEnv };
  for (const key of keysToDelete) {
    delete process.env[key];
  }
}

export async function loadFsConfigMocks(): Promise<FsConfigMocks> {
  const { existsSync } = await import("fs");
  const { readFile } = await import("fs/promises");
  return {
    existsSync: existsSync as any,
    readFile: readFile as any,
  };
}

export function resetFsConfigMocks(mocks: FsConfigMocks): void {
  mocks.existsSync.mockReset().mockReturnValue(false);
  mocks.readFile.mockReset();
}

export function mockTrustedConfigFile(
  mocks: FsConfigMocks,
  path: string,
  contents: string,
): void {
  mocks.existsSync.mockImplementation((candidatePath: string) => candidatePath === path);
  mocks.readFile.mockImplementation(async (candidatePath: string) => {
    if (candidatePath !== path) {
      throw new Error(`Unexpected config read path: ${candidatePath}`);
    }
    return contents;
  });
}

export function getWorkspaceOpencodeConfigPaths() {
  return {
    json: join(process.cwd(), "opencode.json"),
    jsonc: join(process.cwd(), "opencode.jsonc"),
  };
}

export function getWorkspaceOpencodeConfigPath(): string {
  return getWorkspaceOpencodeConfigPaths().json;
}
