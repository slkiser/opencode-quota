import { describe, expect, it } from "vitest";

import { getOpencodeRuntimeDirCandidates, getOpencodeRuntimeDirs } from "../src/lib/opencode-runtime-paths.js";

describe("opencode-runtime-paths", () => {
  it("builds deterministic dirs from XDG env fallbacks", () => {
    const env: NodeJS.ProcessEnv = {
      XDG_DATA_HOME: "/x/data",
      XDG_CONFIG_HOME: "/x/config",
      XDG_CACHE_HOME: "/x/cache",
      XDG_STATE_HOME: "/x/state",
    };

    const dirs = getOpencodeRuntimeDirs({ env, homeDir: "/home/test" });
    expect(dirs).toEqual({
      dataDir: "/x/data/opencode",
      configDir: "/x/config/opencode",
      cacheDir: "/x/cache/opencode",
      stateDir: "/x/state/opencode",
    });
  });

  it("includes Windows APPDATA/LOCALAPPDATA fallbacks after primary", () => {
    const env: NodeJS.ProcessEnv = {
      XDG_DATA_HOME: "C:/Users/u.local/share",
      XDG_CONFIG_HOME: "C:/Users/u.local/config",
      XDG_CACHE_HOME: "C:/Users/u.local/cache",
      XDG_STATE_HOME: "C:/Users/u.local/state",
      APPDATA: "C:/Users/u/AppData/Roaming",
      LOCALAPPDATA: "C:/Users/u/AppData/Local",
    };

    const primary = getOpencodeRuntimeDirs({ env, homeDir: "C:/Users/u" });
    const c = getOpencodeRuntimeDirCandidates({ platform: "win32", env, homeDir: "C:/Users/u", primary });

    expect(c.dataDirs[0]).toBe(primary.dataDir);
    expect(c.configDirs[0]).toBe(primary.configDir);
    expect(c.cacheDirs[0]).toBe(primary.cacheDir);
    expect(c.stateDirs[0]).toBe(primary.stateDir);

    expect(c.dataDirs).toContain("C:/Users/u/AppData/Roaming/opencode");
    expect(c.dataDirs).toContain("C:/Users/u/AppData/Local/opencode");

    expect(c.configDirs).toContain("C:/Users/u/AppData/Roaming/opencode");
    expect(c.configDirs).toContain("C:/Users/u/AppData/Local/opencode");
  });
});
