import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { loadProviderSource, type ProviderSourceHost } from "../src/core/provider-source.js";
import { createQuotaStore } from "../src/core/store.js";
import {
  API_KEY_VENDORS,
  readProviderConfigString,
  resolveApiKeyFromEnvAndConfig,
} from "../src/lib/api-key-resolver.js";
import type { QuotaProvider } from "../src/lib/entries.js";
import {
  openCodeConfigFiles,
  readOpenCodeConfigs,
  withOpenCodeConfigReadScope,
} from "../src/lib/opencode-config-files.js";
import { statusReport } from "../src/lib/quota-dialog-commands.js";
import { defaultSettings } from "../src/settings/index.js";
import { answer, percentRow } from "./helpers/fake-answers.js";
import { useOpencodeFolders } from "./helpers/opencode-folders.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const folders = useOpencodeFolders();
let directory: string;
let configPath: string;
let configPaths: Set<string>;

function writeKey(key: string) {
  writeFileSync(
    configPath,
    JSON.stringify({ providers: { deepseek: { settings: { apiKey: key } } } }),
  );
}

function configReadAttempts(): number {
  return vi.mocked(readFile).mock.calls.filter(([path]) => configPaths.has(String(path))).length;
}

function hostFor(providers: QuotaProvider[]): ProviderSourceHost {
  return {
    client: {} as never,
    workspaceRoot: directory,
    locationDirectory: directory,
    settings: () => ({
      path: "settings.jsonc",
      exists: true,
      settings: defaultSettings(),
      issues: [],
      fromFile: [],
      notRead: [],
    }),
    providers: () => providers,
  };
}

const key = () => resolveApiKeyFromEnvAndConfig(API_KEY_VENDORS.deepseek, directory);

/** Availability, identity and fetch all use the real key resolver. */
function providerFor(
  fetch = async () => {
    await key();
    return answer({ name: "DeepSeek", rows: [percentRow("balance", "Balance", 80)] });
  },
): QuotaProvider {
  return {
    id: "deepseek",
    cachePolicy: {
      kind: "resolved-auth",
      resolveIdentity: async () => (await key())?.key ?? null,
    },
    isAvailable: async () => Boolean(await key()),
    fetch,
  };
}

beforeEach(() => {
  vi.stubEnv("DEEPSEEK_API_KEY", undefined);
  vi.stubEnv("OPENCODE_CONFIG", undefined);
  vi.stubEnv("OPENCODE_CONFIG_PROJECT_DISABLE", undefined);
  vi.stubEnv("OPENCODE_DISABLE_PROJECT_CONFIG", undefined);
  directory = join(folders.root, "project");
  mkdirSync(directory, { recursive: true });
  mkdirSync(folders.configDir, { recursive: true });
  configPath = join(directory, "opencode.jsonc");
  configPaths = new Set(openCodeConfigFiles(directory));
  writeKey("first");
  vi.mocked(readFile).mockClear();
});

describe("config reads within one pass", () => {
  it("shares concurrent and sequential lookups without reversing precedence or caching resolved keys", async () => {
    writeFileSync(
      join(folders.configDir, "opencode.json"),
      JSON.stringify({
        provider: { deepseek: { options: { apiKey: "global" } } },
      }),
    );
    writeFileSync(
      join(directory, "opencode.json"),
      JSON.stringify({
        providers: { deepseek: { settings: { apiKey: "project" } } },
      }),
    );
    await withOpenCodeConfigReadScope(async () => {
      const results = await Promise.all(Array.from({ length: 20 }, key));
      expect(results).toEqual(
        Array.from({ length: 20 }, () => ({ key: "first", source: "opencode.jsonc" })),
      );
      expect(await readProviderConfigString("deepseek", "apiKey", directory)).toBe("first");
      expect((await readOpenCodeConfigs(directory)).map(({ path }) => path)).toEqual([
        join(folders.configDir, "opencode.json"),
        join(directory, "opencode.json"),
        configPath,
      ]);
      writeKey("second");
      expect(await key()).toEqual({ key: "first", source: "opencode.jsonc" });
      vi.stubEnv("DEEPSEEK_API_KEY", "environment");
      expect(await key()).toEqual({ key: "environment", source: "env:DEEPSEEK_API_KEY" });
      vi.stubEnv("DEEPSEEK_API_KEY", undefined);
    });
    expect(configReadAttempts()).toBe(configPaths.size);
    await withOpenCodeConfigReadScope(async () => {
      expect(await key()).toEqual({ key: "second", source: "opencode.jsonc" });
    });
    expect(configReadAttempts()).toBe(configPaths.size * 2);
  });

  it("keeps simultaneous passes separate and reads uncached outside a pass", async () => {
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready!: () => void;
    const read = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const first = withOpenCodeConfigReadScope(async () => {
      expect((await key())?.key).toBe("first");
      ready();
      await paused;
      expect((await key())?.key).toBe("first");
    });
    await read;
    writeKey("second");
    await withOpenCodeConfigReadScope(async () => {
      expect((await key())?.key).toBe("second");
    });
    release();
    await first;
    expect(configReadAttempts()).toBe(configPaths.size * 2);
    writeKey("third");
    expect((await key())?.key).toBe("third");
    expect(configReadAttempts()).toBe(configPaths.size * 3);
  });

  it("shares discovery, initial identity and fetch, but rechecks identity fresh after fetching", async () => {
    const fetchedKeys: string[] = [];
    const host = hostFor([
      providerFor(async () => {
        fetchedKeys.push((await key())?.key ?? "");
        await key();
        return answer({ name: "DeepSeek", rows: [percentRow("balance", "Balance", 80)] });
      }),
    ]);
    const store = createQuotaStore({ source: () => loadProviderSource(host), file: null });
    try {
      const first = await store.refresh({ reason: "manual" });
      expect(first.providers[0]?.rows).toHaveLength(1);
      // One read for discovery/identity/fetch, and a fresh one for the final identity check.
      expect(configReadAttempts()).toBe(configPaths.size * 2);
      writeKey("second");
      await store.refresh({ reason: "manual" });
      expect(fetchedKeys).toEqual(["first", "second"]);
      expect(configReadAttempts()).toBe(configPaths.size * 4);
    } finally {
      await store.dispose();
    }
  });

  it("drops a fetched answer when config changes during the request", async () => {
    const host = hostFor([
      providerFor(async () => {
        expect((await key())?.key).toBe("first");
        writeKey("second");
        return answer({ name: "DeepSeek", rows: [percentRow("balance", "Balance", 80)] });
      }),
    ]);
    const store = createQuotaStore({ source: () => loadProviderSource(host), file: null });
    try {
      const snapshot = await store.refresh({ reason: "manual" });
      expect(snapshot.providers[0]?.rows).toEqual([]);
      expect(configReadAttempts()).toBe(configPaths.size * 2);
    } finally {
      await store.dispose();
    }
  });

  it("shares the status report's discovery with its store check", async () => {
    await statusReport(hostFor([providerFor()]), { origin: "cli", nowMs: Date.now() });
    expect(configReadAttempts()).toBe(configPaths.size * 2);
  });

  it("rereads config when a generation change restarts a pass still reading providers", async () => {
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready!: () => void;
    const read = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const fetchedKeys: string[] = [];
    const provider = providerFor(async () => {
      fetchedKeys.push((await key())?.key ?? "");
      return answer({ name: "DeepSeek", rows: [percentRow("balance", "Balance", 80)] });
    });
    let first = true;
    provider.isAvailable = async () => {
      const resolved = await key();
      if (first) {
        first = false;
        ready();
        await paused;
      }
      return Boolean(resolved);
    };
    const store = createQuotaStore({
      source: () => loadProviderSource(hostFor([provider])),
      file: null,
    });
    try {
      const running = store.refresh({ reason: "manual" });
      await read;
      writeKey("second");
      store.invalidateIdentity();
      release();
      expect((await running).providers[0]?.rows).toHaveLength(1);
      expect(fetchedKeys.length).toBeGreaterThan(0);
      expect(fetchedKeys.every((value) => value === "second")).toBe(true);
    } finally {
      release();
      await store.dispose();
    }
  });

  it("shares one read across providers during discovery and sees edits on the next discovery", async () => {
    const first = providerFor();
    const second = { ...providerFor(), id: "zai" };
    const host = hostFor([first, second]);
    expect((await loadProviderSource(host)).providers).toHaveLength(2);
    expect(configReadAttempts()).toBe(configPaths.size);
    writeKey("");
    expect((await loadProviderSource(host)).providers).toHaveLength(0);
    expect(configReadAttempts()).toBe(configPaths.size * 2);
  });
});
