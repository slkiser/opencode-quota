import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  EMPTY_CONFIGURED_USAGE_PRICES,
  loadConfiguredUsagePrices,
} from "../src/lib/opencode-usage-pricing.js";
import { useOpencodeFolders } from "./helpers/opencode-folders.js";

const folders = useOpencodeFolders();
const directory = join(folders.root, "repo", "app");
const cost = { input: 2, output: 6, cache: { read: 0.5, write: 0 } };
const base = { input: 2, output: 6, reasoning: 6, cache_read: 0.5, cache_write: 0 };
const config = (model: unknown) => ({
  providers: { "team-gateway": { models: { "demo/model": model } } },
});

function writeConfig(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

describe("configured Usage price snapshots", () => {
  it.each([
    { label: "keeps earlier prices when cost is omitted", model: { name: "Local" }, rates: [base] },
    {
      label: "ignores an invalid cost declaration",
      model: { cost: { input: "2", output: 6 } },
      rates: [base],
    },
    {
      label: "replaces whole lists with valid entries, without inheriting cache rates",
      model: { cost: [null, { input: 3, output: 9 }] },
      rates: [{ input: 3, output: 9, reasoning: 9, cache_read: 0, cache_write: 0 }],
    },
    { label: "clears earlier prices with an explicit empty list", model: { cost: [] }, rates: [] },
  ])("$label", async ({ model, rates }) => {
    writeConfig(join(folders.configDir, "opencode.json"), config({ cost: [cost] }));
    writeConfig(join(directory, "opencode.jsonc"), config(model));
    const snapshot = await loadConfiguredUsagePrices(directory);
    expect(snapshot.providers["team-gateway"]!["demo/model"]).toEqual(rates);
  });

  it.each([
    { label: "a nonnumeric cache read", value: { ...cost, cache: { read: "0.5" } } },
    { label: "a negative cache write", value: { ...cost, cache: { write: -1 } } },
    { label: "an invalid cache object", value: { ...cost, cache: null } },
    { label: "an unknown tier type", value: { ...cost, tier: { type: "tokens", size: 100 } } },
    { label: "a negative threshold", value: { ...cost, tier: { type: "context", size: -1 } } },
    { label: "a fractional threshold", value: { ...cost, tier: { type: "context", size: 0.5 } } },
    { label: "a fully invalid nonempty array", value: [null, { input: "2", output: 6 }] },
  ])("ignores $label rather than making it free or unpriced", async ({ value }) => {
    const globalPath = join(folders.configDir, "opencode.json");
    writeConfig(globalPath, config({ cost }));
    const original = await loadConfiguredUsagePrices(directory);
    writeConfig(join(directory, "opencode.jsonc"), config({ cost: value }));
    expect(await loadConfiguredUsagePrices(directory)).toEqual(original);
    rmSync(globalPath);
    expect(await loadConfiguredUsagePrices(directory)).toBe(EMPTY_CONFIGURED_USAGE_PRICES);
  });

  it("applies config file priority to complete price lists", async () => {
    const explicit = join(folders.root, "custom.json");
    vi.stubEnv("OPENCODE_CONFIG", explicit);
    const files = [
      join(folders.configDir, "opencode.json"),
      join(folders.configDir, "opencode.jsonc"),
      explicit,
      join(folders.root, "repo", "opencode.json"),
      join(directory, "opencode.json"),
      join(directory, "opencode.jsonc"),
      join(folders.root, "repo", ".opencode", "opencode.json"),
      join(directory, ".opencode", "opencode.jsonc"),
    ];
    for (const [input, path] of files.entries()) {
      writeConfig(path, config({ cost: { input, output: 0 } }));
    }
    // Removing each winning document exposes the next source's complete cost list.
    for (let input = files.length - 1; input >= 0; input--) {
      const snapshot = await loadConfiguredUsagePrices(directory);
      expect(snapshot.providers["team-gateway"]!["demo/model"], files[input]).toEqual([
        { input, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
      ]);
      rmSync(files[input]!);
    }
  });

  it("keeps the fingerprint independent of file paths and provider/model key order", async () => {
    const a = join(folders.root, "a");
    const b = join(folders.root, "b");
    const models = { "demo/model": { cost }, "other/model": { cost: [] } };
    const reversed = Object.fromEntries(Object.entries(models).toReversed());
    writeConfig(join(a, "opencode.json"), {
      providers: { alpha: { models }, beta: { models } },
    });
    writeConfig(join(b, "opencode.jsonc"), {
      unrelated: "synthetic",
      providers: { beta: { models: reversed }, alpha: { models: reversed } },
    });
    const [first, same] = await Promise.all([
      loadConfiguredUsagePrices(a),
      loadConfiguredUsagePrices(b),
    ]);
    expect(same.fingerprint).toBe(first.fingerprint);
  });
});
