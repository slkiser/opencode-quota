import { join, resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { getOpencodeRuntimeDirs } from "../src/lib/opencode-runtime-paths.js";

describe("opencode-runtime-paths", () => {
  it("builds deterministic dirs from XDG env", () => {
    const env: NodeJS.ProcessEnv = {
      XDG_DATA_HOME: "/x/data",
      XDG_CONFIG_HOME: "/x/config",
      XDG_CACHE_HOME: "/x/cache",
      XDG_STATE_HOME: "/x/state",
    };

    const dirs = getOpencodeRuntimeDirs({ env, homeDir: "/home/test" });
    expect(dirs).toEqual({
      dataDir: join(env.XDG_DATA_HOME!, "opencode"),
      configDir: join(env.XDG_CONFIG_HOME!, "opencode"),
      cacheDir: join(env.XDG_CACHE_HOME!, "opencode"),
      stateDir: join(env.XDG_STATE_HOME!, "opencode"),
    });
  });

  it("falls back to the XDG defaults under the home dir, like OpenCode 2 on every platform", () => {
    const dirs = getOpencodeRuntimeDirs({ env: {}, homeDir: "/home/test" });
    expect(dirs).toEqual({
      dataDir: join("/home/test", ".local", "share", "opencode"),
      configDir: join("/home/test", ".config", "opencode"),
      cacheDir: join("/home/test", ".cache", "opencode"),
      stateDir: join("/home/test", ".local", "state", "opencode"),
    });
  });

  it("ignores Windows APPDATA/LOCALAPPDATA", () => {
    const dirs = getOpencodeRuntimeDirs({
      env: { APPDATA: "C:/Users/u/AppData/Roaming", LOCALAPPDATA: "C:/Users/u/AppData/Local" },
      homeDir: "/home/test",
    });
    expect(dirs.configDir).toBe(join("/home/test", ".config", "opencode"));
    expect(dirs.cacheDir).toBe(join("/home/test", ".cache", "opencode"));
    expect(dirs.stateDir).toBe(join("/home/test", ".local", "state", "opencode"));
  });

  it("uses OPENCODE_CONFIG_DIR as the only global config directory", () => {
    const absoluteConfigDir = resolve("custom", "opencode");
    const absolute = getOpencodeRuntimeDirs({
      env: {
        XDG_CONFIG_HOME: "/x/config",
        OPENCODE_CONFIG_DIR: absoluteConfigDir,
      },
      homeDir: "/home/test",
    });
    expect(absolute.configDir).toBe(absoluteConfigDir);

    const relative = getOpencodeRuntimeDirs({
      env: {
        XDG_CONFIG_HOME: "/x/config",
        OPENCODE_CONFIG_DIR: "work-profile",
      },
      homeDir: "/home/test",
    });
    expect(relative.configDir).toBe(resolve(process.cwd(), "work-profile"));

    const blank = getOpencodeRuntimeDirs({
      env: { XDG_CONFIG_HOME: "/x/config", OPENCODE_CONFIG_DIR: "   " },
      homeDir: "/home/test",
    });
    expect(blank.configDir).toBe(join("/x/config", "opencode"));
  });
});
