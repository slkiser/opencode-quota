import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { convertV5, loadSettings, saveSettings, settingsPath } from "../src/settings/index.js";

const during = vi.hoisted(() => ({
  /** Runs once, while a save writes: after it read the file and before it renames over it. */
  write: undefined as (() => void) | undefined,
  /**
   * Runs once, right after the settings file is looked up for the `nth` time from now. The
   * second lookup of a save is inside its lock, just before the lock reads the file.
   */
  lookup: undefined as { nth: number; run: () => void } | undefined,
}));

vi.mock("../src/lib/atomic-json.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/atomic-json.js")>();
  return {
    ...real,
    writeTextAtomic: async (...args: Parameters<typeof real.writeTextAtomic>) => {
      const write = during.write;
      during.write = undefined;
      write?.();
      return real.writeTextAtomic(...args);
    },
  };
});

vi.mock("../src/lib/config-write-target.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/config-write-target.js")>();
  return {
    ...real,
    resolveConfigWriteTarget: async (...args: Parameters<typeof real.resolveConfigWriteTarget>) => {
      const target = await real.resolveConfigWriteTarget(...args);
      const lookup = during.lookup;
      if (lookup) {
        lookup.nth -= 1;
        if (lookup.nth === 0) {
          during.lookup = undefined;
          lookup.run();
        }
      }
      return target;
    },
  };
});

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "quota-settings-hand-edit-"));
  vi.stubEnv("OPENCODE_CONFIG_DIR", join(root, "config"));
  vi.stubEnv("XDG_STATE_HOME", join(root, "state"));
});

afterEach(async () => {
  during.write = undefined;
  during.lookup = undefined;
  await rm(root, { recursive: true, force: true });
});

it("keeps a hand edit made while a save writes, and saves on top of it", async () => {
  const path = settingsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '{ "words": { "percent": "used" } }');
  during.write = () =>
    writeFileSync(path, '{ "words": { "percent": "used", "detail": "detailed" } }');

  const result = await saveSettings({ words: { reset: "short" } });

  expect(result.ok).toBe(true);
  expect(during.write).toBeUndefined();
  expect((await loadSettings()).settings.words).toMatchObject({
    percent: "used",
    detail: "detailed",
    reset: "short",
  });
  expect(readFileSync(path, "utf8")).toContain('"detail": "detailed"');
});

it("keeps a settings.jsonc made while the first start after 4.x or 5.x writes one", async () => {
  const old = join(root, "config", "opencode-quota", "quota-toast.jsonc");
  mkdirSync(dirname(old), { recursive: true });
  writeFileSync(old, JSON.stringify({ percentDisplayMode: "used" }));
  const path = settingsPath();
  const mine = '{ "system": { "oldCommands": false } }';
  during.lookup = {
    nth: 2,
    run: () => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, mine);
    },
  };

  expect(await convertV5()).toBeUndefined();

  expect(during.lookup).toBeUndefined();
  expect(readFileSync(path, "utf8")).toBe(mine);
});
