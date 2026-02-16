import { homedir } from "os";
import { join } from "path";
import {
  xdgCache,
  xdgConfig,
  xdgData,
  xdgState,
} from "xdg-basedir";

export interface OpencodeRuntimeDirs {
  dataDir: string;
  configDir: string;
  cacheDir: string;
  stateDir: string;
}

export interface OpencodeRuntimeDirCandidates {
  dataDirs: string[];
  configDirs: string[];
  cacheDirs: string[];
  stateDirs: string[];
}

function dedupe(list: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

export function getOpencodeRuntimeDirs(params?: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): OpencodeRuntimeDirs {
  const env = params?.env ?? process.env;
  const home = params?.homeDir ?? homedir();

  // Match OpenCode behavior: Global.Path.<dir> = join(xdg<Dir>, "opencode")
  // xdg-basedir may return undefined if env is missing; provide deterministic fallbacks.
  const dataBase = env.XDG_DATA_HOME?.trim() || xdgData || join(home, ".local", "share");
  const configBase = env.XDG_CONFIG_HOME?.trim() || xdgConfig || join(home, ".config");
  const cacheBase = env.XDG_CACHE_HOME?.trim() || xdgCache || join(home, ".cache");
  const stateBase = env.XDG_STATE_HOME?.trim() || xdgState || join(home, ".local", "state");

  return {
    dataDir: join(dataBase, "opencode"),
    configDir: join(configBase, "opencode"),
    cacheDir: join(cacheBase, "opencode"),
    stateDir: join(stateBase, "opencode"),
  };
}

export function getOpencodeRuntimeDirCandidates(params?: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  primary?: OpencodeRuntimeDirs;
}): OpencodeRuntimeDirCandidates {
  const platform = params?.platform ?? process.platform;
  const env = params?.env ?? process.env;
  const home = params?.homeDir ?? homedir();

  const primary = params?.primary ?? getOpencodeRuntimeDirs({ env, homeDir: home });

  const winAppData = env.APPDATA?.trim();
  const winLocalAppData = env.LOCALAPPDATA?.trim();

  const windowsRoamingFallback = join(home, "AppData", "Roaming");
  const windowsLocalFallback = join(home, "AppData", "Local");

  const dataDirs: string[] = [primary.dataDir];
  const configDirs: string[] = [primary.configDir];
  const cacheDirs: string[] = [primary.cacheDir];
  const stateDirs: string[] = [primary.stateDir];

  if (platform === "win32") {
    // OpenCode uses xdg-basedir; on some Windows setups that can resolve to
    // non-AppData locations (e.g. C:\\Users\\name.local\\share). However, many
    // users and older installs place OpenCode data/config under APPDATA/LOCALAPPDATA.
    const appDataBase = winAppData || windowsRoamingFallback;
    const localAppDataBase = winLocalAppData || windowsLocalFallback;

    // Data and config: include both roaming and local as alternates.
    dataDirs.push(join(appDataBase, "opencode"));
    dataDirs.push(join(localAppDataBase, "opencode"));

    configDirs.push(join(appDataBase, "opencode"));
    configDirs.push(join(localAppDataBase, "opencode"));

    // Cache/state: local is more likely.
    cacheDirs.push(join(localAppDataBase, "opencode"));
    stateDirs.push(join(localAppDataBase, "opencode"));
  } else if (platform === "darwin") {
    // Preserve compatibility with legacy Linux-style installs on macOS.
    dataDirs.push(join(home, ".local", "share", "opencode"));
    configDirs.push(join(home, ".config", "opencode"));
    cacheDirs.push(join(home, ".cache", "opencode"));
    stateDirs.push(join(home, ".local", "state", "opencode"));

    // macOS canonical dirs (OpenCode xdg-basedir should already map here,
    // but keep explicit candidates to aid diagnostics and migrations).
    dataDirs.push(join(home, "Library", "Application Support", "opencode"));
    configDirs.push(join(home, "Library", "Application Support", "opencode"));
    cacheDirs.push(join(home, "Library", "Caches", "opencode"));
  } else {
    // Linux / other: add common legacy fallbacks.
    dataDirs.push(join(home, ".local", "share", "opencode"));
    configDirs.push(join(home, ".config", "opencode"));
    cacheDirs.push(join(home, ".cache", "opencode"));
    stateDirs.push(join(home, ".local", "state", "opencode"));
  }

  return {
    dataDirs: dedupe(dataDirs),
    configDirs: dedupe(configDirs),
    cacheDirs: dedupe(cacheDirs),
    stateDirs: dedupe(stateDirs),
  };
}
