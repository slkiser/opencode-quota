import { describe, expect, it } from "vitest";

import {
  getOpencodeRuntimeDirCandidates,
  getOpencodeRuntimeDirs,
} from "../src/lib/opencode-runtime-paths.js";
import { getOpenCodeDbPathCandidates } from "../src/lib/opencode-storage.js";

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

  it("uses OPENCODE_CONFIG_DIR as the primary global config directory", () => {
    const absolute = getOpencodeRuntimeDirs({
      env: {
        XDG_CONFIG_HOME: "/x/config",
        OPENCODE_CONFIG_DIR: "/custom/opencode",
      },
      homeDir: "/home/test",
    });
    expect(absolute.configDir).toBe("/custom/opencode");

    const relative = getOpencodeRuntimeDirs({
      env: {
        XDG_CONFIG_HOME: "/x/config",
        OPENCODE_CONFIG_DIR: "work-profile",
      },
      homeDir: "/home/test",
    });
    expect(relative.configDir).toBe("/x/config/opencode/work-profile");

    const candidates = getOpencodeRuntimeDirCandidates({
      platform: "linux",
      env: {
        XDG_CONFIG_HOME: "/x/config",
        OPENCODE_CONFIG_DIR: "/custom/opencode",
      },
      homeDir: "/home/test",
    });
    expect(candidates.configDirs[0]).toBe("/custom/opencode");
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
    const c = getOpencodeRuntimeDirCandidates({
      platform: "win32",
      env,
      homeDir: "C:/Users/u",
      primary,
    });

    expect(c.dataDirs[0]).toBe(primary.dataDir);
    expect(c.configDirs[0]).toBe(primary.configDir);
    expect(c.cacheDirs[0]).toBe(primary.cacheDir);
    expect(c.stateDirs[0]).toBe(primary.stateDir);

    expect(c.dataDirs).toContain("C:/Users/u/AppData/Roaming/opencode");
    expect(c.dataDirs).toContain("C:/Users/u/AppData/Local/opencode");

    expect(c.configDirs).toContain("C:/Users/u/AppData/Roaming/opencode");
    expect(c.configDirs).toContain("C:/Users/u/AppData/Local/opencode");
  });

  it("derives opencode.db candidates from runtime data dirs", () => {
    const prev = {
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
      XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    };

    process.env.XDG_DATA_HOME = "/x/data";
    process.env.XDG_CONFIG_HOME = "/x/config";
    process.env.XDG_CACHE_HOME = "/x/cache";
    process.env.XDG_STATE_HOME = "/x/state";

    try {
      const env: NodeJS.ProcessEnv = {
        XDG_DATA_HOME: "/x/data",
        XDG_CONFIG_HOME: "/x/config",
        XDG_CACHE_HOME: "/x/cache",
        XDG_STATE_HOME: "/x/state",
      };

      const dirs = getOpencodeRuntimeDirCandidates({
        platform: "linux",
        env,
        homeDir: "/home/test",
      });
      const candidates = getOpenCodeDbPathCandidates();

      // Ensure the primary candidate matches runtime primary (order matters).
      expect(candidates[0]).toBe(dirs.dataDirs[0] + "/opencode.db");
    } finally {
      process.env.XDG_DATA_HOME = prev.XDG_DATA_HOME;
      process.env.XDG_CONFIG_HOME = prev.XDG_CONFIG_HOME;
      process.env.XDG_CACHE_HOME = prev.XDG_CACHE_HOME;
      process.env.XDG_STATE_HOME = prev.XDG_STATE_HOME;
    }
  });
});
