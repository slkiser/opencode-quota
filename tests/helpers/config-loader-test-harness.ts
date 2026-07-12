import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

type RuntimeDirCandidates = {
  dataDirs: string[];
  configDirs: string[];
  cacheDirs: string[];
  stateDirs: string[];
};

type ConfigLoaderWorkspaceOptions = {
  nestedPath?: string[];
};

export type ConfigLoaderWorkspace = {
  tempDir: string;
  workspaceDir: string;
  nestedDir: string;
  xdgConfigHome: string;
  xdgDataHome: string;
  xdgCacheHome: string;
  xdgStateHome: string;
  appDataRoaming: string;
  appDataLocal: string;
  opencodeConfigDir: string;
  runtimeDirs: RuntimeDirCandidates;
  cleanup: () => void;
};

export function createEmptyRuntimeDirCandidates(): RuntimeDirCandidates {
  return {
    dataDirs: [],
    configDirs: [],
    cacheDirs: [],
    stateDirs: [],
  };
}

export function createConfigLoaderWorkspace(
  prefix: string,
  options: ConfigLoaderWorkspaceOptions = {},
): ConfigLoaderWorkspace {
  const tempDir = mkdtempSync(join(tmpdir(), prefix));
  const workspaceDir = join(tempDir, "workspace");
  const nestedDir = options.nestedPath?.length
    ? join(workspaceDir, ...options.nestedPath)
    : workspaceDir;
  const xdgConfigHome = join(tempDir, "xdg-config");
  const xdgDataHome = join(tempDir, "xdg-data");
  const xdgCacheHome = join(tempDir, "xdg-cache");
  const xdgStateHome = join(tempDir, "xdg-state");
  const appDataRoaming = join(tempDir, "appdata", "roaming");
  const appDataLocal = join(tempDir, "appdata", "local");
  const opencodeConfigDir = join(xdgConfigHome, "opencode");

  mkdirSync(nestedDir, { recursive: true });
  mkdirSync(opencodeConfigDir, { recursive: true });

  return {
    tempDir,
    workspaceDir,
    nestedDir,
    xdgConfigHome,
    xdgDataHome,
    xdgCacheHome,
    xdgStateHome,
    appDataRoaming,
    appDataLocal,
    opencodeConfigDir,
    runtimeDirs: {
      dataDirs: [join(xdgDataHome, "opencode")],
      configDirs: [opencodeConfigDir],
      cacheDirs: [join(xdgCacheHome, "opencode")],
      stateDirs: [join(xdgStateHome, "opencode")],
    },
    cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
  };
}

export function createConfigLoaderEnv(
  workspace: ConfigLoaderWorkspace,
  options: { home?: string; includePlatformAppData?: boolean } = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    XDG_CONFIG_HOME: workspace.xdgConfigHome,
    XDG_DATA_HOME: workspace.xdgDataHome,
    XDG_CACHE_HOME: workspace.xdgCacheHome,
    XDG_STATE_HOME: workspace.xdgStateHome,
  };

  if (options.home !== undefined) {
    env.HOME = options.home;
  }

  if (options.includePlatformAppData) {
    env.APPDATA = workspace.appDataRoaming;
    env.LOCALAPPDATA = workspace.appDataLocal;
  }

  return env;
}

export function quotaConfigSource(dir: string): string {
  return join(dir, "opencode.json") + " (experimental.quotaToast)";
}

export function quotaSidecarConfigSource(dir: string): string {
  return join(dir, "opencode-quota", "quota-toast.json") + " (opencode-quota/quota-toast.json)";
}

export function writeQuotaSidecarConfig(
  dir: string,
  quotaToast: Record<string, unknown>,
): string {
  const configDir = join(dir, "opencode-quota");
  const path = join(configDir, "quota-toast.json");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path, JSON.stringify(quotaToast), "utf8");
  return path;
}

export function writeQuotaToastConfig(
  dir: string,
  quotaToast: Record<string, unknown>,
): string {
  const path = join(dir, "opencode.json");
  writeFileSync(
    path,
    JSON.stringify({
      experimental: {
        quotaToast,
      },
    }),
    "utf8",
  );
  return path;
}
