import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { activePriceList } from "../src/lib/modelsdev-pricing.js";
import { createLiveSettings, type LiveSettings } from "../src/settings/index.js";

let configDir: string;
const cleanups: Array<() => void> = [];

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "quota-live-settings-"));
  vi.stubEnv("OPENCODE_CONFIG_DIR", configDir);
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  await rm(configDir, { recursive: true, force: true });
});

/** Writes a file under the config folder; an object is written as JSON. */
function writeConfig(name: string, content: unknown): void {
  const path = join(configDir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
}

const writeSettings = (settings: unknown) => writeConfig("opencode-quota/settings.jsonc", settings);

/** Live settings until the test ends; with `follow`, `changes` collects every change. */
async function start(options: { follow?: boolean; debounceMs?: number } = {}) {
  const debounceMs = options.debounceMs ?? 20;
  const live = await createLiveSettings({ projectDir: configDir, debounceMs });
  const changes: unknown[] = [];
  const watch = options.follow
    ? await live.follow(async (change) => {
        changes.push(change);
      })
    : undefined;
  cleanups.push(() => {
    watch?.close();
    live.dispose();
  });
  return { live, changes };
}

const BASE = { providers: { checking: { minIntervalMs: 60_000, waitForQuotaReset: true } } };
const NEW_SNAPSHOT = { recheck: false, oldCommands: false };

describe("createLiveSettings", () => {
  it.each([
    { name: "new words", next: { ...BASE, words: { percent: "used" } }, change: NEW_SNAPSHOT },
    {
      name: "the same checking keys in another order, and new words",
      next: {
        words: { percent: "used" },
        providers: { checking: { waitForQuotaReset: true, minIntervalMs: 60_000 } },
      },
      change: NEW_SNAPSHOT,
    },
    {
      name: "a time limit newly set to its default",
      next: { providers: { checking: { ...BASE.providers.checking, requestTimeoutMs: 5_000 } } },
      change: { recheck: true, oldCommands: false },
    },
    {
      name: "another price list",
      next: { ...BASE, providers: { ...BASE.providers, pricing: { source: "runtime" } } },
      change: { recheck: true, oldCommands: false },
    },
    {
      name: "the old command names switched off",
      next: { ...BASE, system: { oldCommands: false } },
      change: { recheck: false, oldCommands: true },
    },
    { name: "only a problem in the file", next: { ...BASE, unknown: 1 }, change: undefined },
  ])("holds a file edit and reports $name", async ({ next, change }) => {
    writeSettings(BASE);
    const { live, changes } = await start({ follow: true });
    const before = live.current();

    writeSettings(next);

    await vi.waitFor(() => expect(live.current()).not.toBe(before), { timeout: 5_000 });
    expect(changes).toEqual(change ? [change] : []);
  });

  it("holds a save before it answers, and the watch's read of it is no second change", async () => {
    writeSettings(BASE);
    // A debounce well past the save's own read, so the watch reads the saved file after it.
    const { live, changes } = await start({ follow: true, debounceMs: 200 });

    const refused = await live.save({ system: { exportPath: "/elsewhere.json" } }, {});
    const saved = await live.save({ words: { percent: "used" } }, {});
    const heldBySave = live.current();
    expect([refused.ok, saved.ok, heldBySave.settings.words.percent]).toEqual([
      false,
      true,
      "used",
    ]);

    await vi.waitFor(() => expect(live.current()).not.toBe(heldBySave), { timeout: 5_000 });
    expect(live.current().settings.words.percent).toBe("used");
    expect(changes).toEqual([NEW_SNAPSHOT]);
  });

  it.each([
    {
      name: "an edit",
      write: (live: LiveSettings) => live.edit(() => ({ words: { percent: "used" } })),
    },
    {
      name: "a file edit",
      write: (live: LiveSettings) =>
        live.editFile(() => [{ path: ["words", "percent"], value: "used" }]),
    },
  ])("holds $name before it answers, like a save", async ({ write }) => {
    writeSettings(BASE);
    const { live, changes } = await start({ follow: true, debounceMs: 200 });

    expect((await write(live)).ok).toBe(true);

    expect(live.current().settings.words.percent).toBe("used");
    expect(changes).toEqual([NEW_SNAPSHOT]);
  });

  it.each([
    { name: "a v5 file, written at the start", atStart: true, afterSave: true, files: {} },
    {
      name: "a v5 file that does not parse, written by the first save",
      atStart: false,
      afterSave: true,
      files: { "opencode-quota/quota-toast.jsonc": "{ broken" },
    },
    {
      name: "settings.jsonc, never",
      atStart: false,
      afterSave: false,
      files: { "opencode-quota/settings.jsonc": "{}" },
    },
  ])("says it converted from $name", async ({ atStart, afterSave, files }) => {
    writeConfig("opencode.json", { experimental: { quotaToast: { percentDisplayMode: "used" } } });
    for (const [name, content] of Object.entries(files)) writeConfig(name, content);
    const { live } = await start();
    expect(live.converted()).toBe(atStart);

    expect((await live.save({ words: { reset: "compact" } }, {})).ok).toBe(true);

    expect(live.converted()).toBe(afterSave);
    expect(live.current().settings.words.reset).toBe("compact");
  });

  it("says nothing was converted after an edit that changes nothing", async () => {
    writeConfig("opencode.json", { experimental: { quotaToast: { percentDisplayMode: "used" } } });
    writeConfig("opencode-quota/quota-toast.jsonc", "{ broken");
    const { live } = await start();

    expect((await live.edit(() => undefined)).ok).toBe(true);

    expect(live.converted()).toBe(false);
    expect(live.current().exists).toBe(false);
  });

  it("gives the price list its settings from the start, and takes them back on dispose", async () => {
    writeSettings({ providers: { pricing: { source: "bundled" } } });
    const { live: running } = await start({ follow: true });
    const stopped = await createLiveSettings({ projectDir: configDir });
    expect(activePriceList().selection).toBe("bundled");
    stopped.dispose();

    writeSettings({ providers: { pricing: { source: "runtime" } } });

    await vi.waitFor(
      () => expect(running.current().settings.providers.pricing.source).toBe("runtime"),
      { timeout: 5_000 },
    );
    expect(activePriceList().selection).toBe("runtime");
  });
});
