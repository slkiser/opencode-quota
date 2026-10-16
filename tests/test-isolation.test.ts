import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { describe, expect, it } from "vite-plus/test";

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
