import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { getOpencodeRuntimeDirs } from "../src/lib/opencode-runtime-paths.js";
import { oldSettingsFolders } from "../src/settings/convert.js";

// tests/setup.ts keeps tests away from this machine's real OpenCode folders and the network.
describe("test isolation", () => {
  it("uses a temp home folder and temp XDG folders", () => {
    const tempRoot = realpathSync(tmpdir());
    const home = realpathSync(homedir());

    expect(home.startsWith(tempRoot)).toBe(true);
    expect(process.env.HOME).toBe(homedir());
    for (const name of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) {
      expect(process.env[name]?.startsWith(homedir())).toBe(true);
    }
  });

  it("resolves the home folder from the test's environment, so no pool reaches the real one", () => {
    const home = join(tmpdir(), "opencode-quota-fake-home");
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    for (const name of [
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
      "XDG_CACHE_HOME",
      "APPDATA",
      "LOCALAPPDATA",
    ]) {
      vi.stubEnv(name, "");
    }
    vi.stubEnv("OPENCODE_CONFIG_DIR", "");

    const dirs = getOpencodeRuntimeDirs();

    expect(homedir()).toBe(home);
    for (const dir of Object.values(dirs)) expect(dir.startsWith(home)).toBe(true);
    for (const dir of oldSettingsFolders(dirs.configDir)) expect(dir.startsWith(home)).toBe(true);
  });

  it("falls back to the temp home, never the real one, when HOME is unset", () => {
    vi.stubEnv("HOME", undefined);
    vi.stubEnv("USERPROFILE", undefined);

    expect(realpathSync(homedir()).startsWith(realpathSync(tmpdir()))).toBe(true);
  });

  it("has no OpenCode or credential variables", () => {
    const leaked = Object.keys(process.env).filter(
      (name) => name.startsWith("OPENCODE_") || /(_KEY|_TOKEN|_SECRET)$/.test(name),
    );

    expect(leaked).toEqual([]);
  });

  it("blocks fetch to anything but loopback", async () => {
    await expect(fetch("https://example.com")).rejects.toThrow(/example\.com/);
  });
});
