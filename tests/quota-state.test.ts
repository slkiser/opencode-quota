import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readdir, rm, writeFile } from "fs/promises";

const TEST_RUNTIME_ROOT = "/tmp/opencode-quota-state-tests";

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirs: () => ({
    dataDir: `${TEST_RUNTIME_ROOT}/data`,
    configDir: `${TEST_RUNTIME_ROOT}/config`,
    cacheDir: `${TEST_RUNTIME_ROOT}/cache`,
    stateDir: `${TEST_RUNTIME_ROOT}/state`,
  }),
}));

function createTestContext() {
  return {
    client: {
      config: {
        providers: async () => ({ data: { providers: [] } }),
        get: async () => ({ data: {} }),
      },
    },
    config: {
      googleModels: ["CLAUDE"],
      anthropicBinaryPath: "claude",
      alibabaCodingPlanTier: "lite",
      cursorPlan: "none",
      onlyCurrentModel: false,
    },
  } as any;
}

describe("quota-state shared cache", () => {
  it("retains accounting through coalescing/restart and isolates nested facts from callers", async () => {
    const { openAIAccounting } = await import("../src/providers/accounting-adapters.js");
    const accounting = openAIAccounting({
      success: true,
      label: "OpenAI",
      windows: { weekly: { percentRemaining: 42 } },
    });
    let state = await import("../src/lib/quota-state.js");
    const provider = {
      id: "accounting-fixture",
      cachePolicy: { kind: "account-neutral" },
      fetch: vi.fn(async () => ({
        attempted: true,
        entries: [{ name: "OpenAI Weekly", percentRemaining: 42 }],
        errors: [],
        accounting,
      })),
    } as any;
    const params = { provider, ctx: createTestContext(), ttlMs: 60_000 };
    const [first, second] = await Promise.all([
      state.fetchQuotaProviderResult(params),
      state.fetchQuotaProviderResult(params),
    ]);
    expect(provider.fetch).toHaveBeenCalledTimes(1);
    first.accounting!.rows[0].source.authority = "unknown";
    first.accounting!.rows[0].value = { kind: "percent", remaining: 0 };
    expect(second.accounting).toEqual(accounting);
    vi.resetModules();
    state = await import("../src/lib/quota-state.js");
    expect((await state.fetchQuotaProviderResult(params)).accounting).toEqual(accounting);
    expect(provider.fetch).toHaveBeenCalledTimes(1);
    const path = state.getQuotaProviderStateCacheFilePath(
      provider.id,
      state.buildQuotaProviderStateCacheKey(provider.id, params.ctx),
    );
    const { readFile } = await import("fs/promises");
    const persisted = JSON.parse(await readFile(path, "utf8"));
    persisted.result.accounting.version = 99;
    await writeFile(path, JSON.stringify(persisted));
    vi.resetModules();
    state = await import("../src/lib/quota-state.js");
    expect((await state.fetchQuotaProviderResult(params)).accounting).toEqual(accounting);
    expect(provider.fetch).toHaveBeenCalledTimes(2);
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
  });

  it("retries error-only results immediately and never persists them", async () => {
    const { fetchQuotaProviderResult } = await import("../src/lib/quota-state.js");
    const failure = {
      attempted: true,
      entries: [],
      errors: [{ label: "Synthetic", message: "Temporary failure" }],
    };
    const healthy = {
      attempted: true,
      entries: [{ name: "Synthetic", percentRemaining: 55 }],
      errors: [],
    };
    const provider = {
      id: "synthetic",
      cachePolicy: { kind: "account-neutral" },
      fetch: vi.fn().mockResolvedValueOnce(failure).mockResolvedValue(healthy),
    } as any;
    const params = { provider, ctx: createTestContext(), ttlMs: 60_000 };
    expect(await fetchQuotaProviderResult(params)).toEqual(expect.objectContaining(failure));
    const files = await readdir(`${TEST_RUNTIME_ROOT}/cache/quota-provider-state`).catch(() => []);
    expect(files.filter((file) => file.endsWith(".json"))).toEqual([]);
    expect(await fetchQuotaProviderResult(params)).toEqual(expect.objectContaining(healthy));
    expect(provider.fetch).toHaveBeenCalledTimes(2);
  });

  it("ignores an error-only snapshot left on disk by an older build", async () => {
    const state = await import("../src/lib/quota-state.js");
    const healthy = {
      attempted: true,
      entries: [{ name: "Synthetic", percentRemaining: 55 }],
      errors: [],
    };
    const provider = {
      id: "synthetic",
      cachePolicy: { kind: "account-neutral" },
      fetch: vi.fn().mockResolvedValue(healthy),
    } as any;
    const params = { provider, ctx: createTestContext(), ttlMs: 60_000 };
    await state.fetchQuotaProviderResult(params);
    const path = state.getQuotaProviderStateCacheFilePath(
      provider.id,
      state.buildQuotaProviderStateCacheKey(provider.id, params.ctx),
    );
    const { readFile } = await import("fs/promises");
    const persisted = JSON.parse(await readFile(path, "utf8"));
    persisted.result = {
      attempted: true,
      entries: [],
      errors: [{ label: "Synthetic", message: "Old failure" }],
    };
    await writeFile(path, JSON.stringify(persisted));
    vi.resetModules();
    const freshState = await import("../src/lib/quota-state.js");
    expect(await freshState.fetchQuotaProviderResult(params)).toEqual(
      expect.objectContaining(healthy),
    );
    expect(provider.fetch).toHaveBeenCalledTimes(2);
  });

  it("preserves the prior observation and its timestamp after a failed refresh", async () => {
    const { fetchQuotaProviderResult, readCachedProviderResult } =
      await import("../src/lib/quota-state.js");
    const healthy = {
      attempted: true,
      entries: [{ name: "Synthetic", percentRemaining: 55 }],
      errors: [],
    };
    const failure = {
      attempted: true,
      entries: [],
      errors: [{ label: "Synthetic", message: "Temporary failure" }],
    };
    const provider = {
      id: "synthetic",
      cachePolicy: { kind: "account-neutral" },
      fetch: vi.fn().mockResolvedValueOnce(healthy).mockResolvedValue(failure),
    } as any;
    const params = { provider, ctx: createTestContext(), ttlMs: 0 };
    await fetchQuotaProviderResult(params);
    const before = await readCachedProviderResult(params);
    expect(await fetchQuotaProviderResult(params)).toEqual(expect.objectContaining(failure));
    expect(await readCachedProviderResult(params)).toEqual(before);
  });

  it("keeps partial results visibly partial when cached", async () => {
    const { fetchQuotaProviderResult } = await import("../src/lib/quota-state.js");
    const partial = {
      attempted: true,
      entries: [{ name: "Account A", percentRemaining: 55 }],
      errors: [{ label: "Account B", message: "Unavailable" }],
    };
    const provider = {
      id: "synthetic",
      cachePolicy: { kind: "account-neutral" },
      fetch: vi.fn().mockResolvedValue(partial),
    } as any;
    const params = { provider, ctx: createTestContext(), ttlMs: 60_000 };
    expect(await fetchQuotaProviderResult(params)).toEqual(expect.objectContaining(partial));
    expect(await fetchQuotaProviderResult(params)).toEqual(expect.objectContaining(partial));
    expect(provider.fetch).toHaveBeenCalledTimes(1);
  });

  it("builds a provider cache key that ignores formatStyle-like extras", async () => {
    const { buildQuotaProviderStateCacheKey } = await import("../src/lib/quota-state.js");
    const base = createTestContext();

    const singleWindowKey = buildQuotaProviderStateCacheKey("synthetic", {
      ...base,
      config: { ...base.config, formatStyle: "singleWindow" },
    } as any);
    const allWindowsKey = buildQuotaProviderStateCacheKey("synthetic", {
      ...base,
      config: { ...base.config, formatStyle: "allWindows" },
    } as any);

    expect(singleWindowKey).toBe(allWindowsKey);
  });

  it("returns cache-owned clones for repeated non-live provider reads", async () => {
    const { __resetQuotaStateForTests, fetchQuotaProviderResult } =
      await import("../src/lib/quota-state.js");
    __resetQuotaStateForTests();

    const provider = {
      id: "synthetic",
      cachePolicy: { kind: "account-neutral" },
      isAvailable: vi.fn(),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [
          {
            name: "Synthetic Weekly",
            group: "Synthetic",
            label: "Weekly:",
            percentRemaining: 84,
            right: "$8/$50",
            resetTimeIso: "2026-04-21T18:00:00.000Z",
          },
        ],
        errors: [],
        presentation: {
          singleWindowShowRight: true,
        },
      }),
    } as any;

    const first = await fetchQuotaProviderResult({
      provider,
      ctx: createTestContext(),
      ttlMs: 60_000,
    });
    const firstEntry = first.entries[0] as any;
    firstEntry.right = "$0/$1";
    firstEntry.percentRemaining = 1;

    const second = await fetchQuotaProviderResult({
      provider,
      ctx: createTestContext(),
      ttlMs: 60_000,
    });

    expect(second).toEqual(
      expect.objectContaining({
        attempted: true,
        entries: [
          {
            name: "Synthetic Weekly",
            group: "Synthetic",
            label: "Weekly:",
            percentRemaining: 84,
            right: "$8/$50",
            resetTimeIso: "2026-04-21T18:00:00.000Z",
          },
        ],
        errors: [],
        presentation: {
          singleWindowShowRight: true,
        },
      }),
    );
    expect(provider.fetch).toHaveBeenCalledTimes(1);
  });

  it("reuses the persisted cache across module resets", async () => {
    const quotaStateA = await import("../src/lib/quota-state.js");
    quotaStateA.__resetQuotaStateForTests();

    const provider = {
      id: "synthetic",
      cachePolicy: { kind: "account-neutral" },
      isAvailable: vi.fn(),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [{ name: "Synthetic", percentRemaining: 55 }],
        errors: [],
      }),
    } as any;

    await quotaStateA.fetchQuotaProviderResult({
      provider,
      ctx: createTestContext(),
      ttlMs: 60_000,
    });
    expect(provider.fetch).toHaveBeenCalledTimes(1);

    vi.resetModules();
    const quotaStateB = await import("../src/lib/quota-state.js");
    const second = await quotaStateB.fetchQuotaProviderResult({
      provider,
      ctx: createTestContext(),
      ttlMs: 60_000,
    });

    expect(second).toEqual(
      expect.objectContaining({
        attempted: true,
        entries: [{ name: "Synthetic", percentRemaining: 55 }],
        errors: [],
      }),
    );
    expect(provider.fetch).toHaveBeenCalledTimes(1);
  });

  it("accepts persisted legacy classic presentation fields for cache compatibility", async () => {
    const quotaStateA = await import("../src/lib/quota-state.js");
    quotaStateA.__resetQuotaStateForTests();

    const provider = {
      id: "synthetic",
      cachePolicy: { kind: "account-neutral" },
      isAvailable: vi.fn(),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [{ name: "Synthetic", percentRemaining: 55 }],
        errors: [],
      }),
    } as any;
    const ctx = createTestContext();
    const key = quotaStateA.buildQuotaProviderStateCacheKey(provider.id, ctx);
    const path = quotaStateA.getQuotaProviderStateCacheFilePath(provider.id, key);
    const { getPackageVersion } = await import("../src/lib/version.js");
    const packageVersion = (await getPackageVersion()) ?? "unknown";

    await mkdir(`${TEST_RUNTIME_ROOT}/cache/quota-provider-state`, { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        version: 2,
        packageVersion,
        key: quotaStateA.getQuotaProviderCacheLocator(key),
        providerId: provider.id,
        timestamp: Date.now(),
        result: {
          attempted: true,
          entries: [{ name: "Synthetic", percentRemaining: 55 }],
          errors: [],
          presentation: {
            classicDisplayName: "Synthetic",
            classicShowRight: true,
            classicStrategy: "preserve",
          },
        },
      }),
      "utf-8",
    );

    vi.resetModules();
    const quotaStateB = await import("../src/lib/quota-state.js");
    const result = await quotaStateB.fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });

    expect(result).toEqual(
      expect.objectContaining({
        attempted: true,
        entries: [{ name: "Synthetic", percentRemaining: 55 }],
        errors: [],
        presentation: {
          classicDisplayName: "Synthetic",
          classicShowRight: true,
          classicStrategy: "preserve",
        },
      }),
    );
    expect(provider.fetch).not.toHaveBeenCalled();
  });

  it("treats cache corruption as a miss and refetches live data", async () => {
    const quotaStateA = await import("../src/lib/quota-state.js");
    quotaStateA.__resetQuotaStateForTests();

    const provider = {
      id: "synthetic",
      cachePolicy: { kind: "account-neutral" },
      isAvailable: vi.fn(),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [{ name: "Synthetic", percentRemaining: 55 }],
        errors: [],
      }),
    } as any;
    const ctx = createTestContext();
    const key = quotaStateA.buildQuotaProviderStateCacheKey(provider.id, ctx);
    const path = quotaStateA.getQuotaProviderStateCacheFilePath(provider.id, key);

    await quotaStateA.fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });
    await writeFile(path, "{ definitely-not-json", "utf-8");

    vi.resetModules();
    const quotaStateB = await import("../src/lib/quota-state.js");
    await quotaStateB.fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });

    expect(provider.fetch).toHaveBeenCalledTimes(2);
  });

  it("treats cache package-version mismatches as a miss and refetches live data", async () => {
    const quotaStateA = await import("../src/lib/quota-state.js");
    quotaStateA.__resetQuotaStateForTests();

    const provider = {
      id: "synthetic",
      cachePolicy: { kind: "account-neutral" },
      isAvailable: vi.fn(),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [{ name: "Synthetic", percentRemaining: 55 }],
        errors: [],
      }),
    } as any;
    const ctx = createTestContext();
    const key = quotaStateA.buildQuotaProviderStateCacheKey(provider.id, ctx);
    const path = quotaStateA.getQuotaProviderStateCacheFilePath(provider.id, key);

    await quotaStateA.fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });
    await writeFile(
      path,
      JSON.stringify({
        version: 2,
        packageVersion: "0.0.0-stale-cache",
        key: quotaStateA.getQuotaProviderCacheLocator(key),
        providerId: provider.id,
        timestamp: Date.now(),
        result: {
          attempted: true,
          entries: [{ name: "Synthetic", percentRemaining: 10 }],
          errors: [],
        },
      }),
      "utf-8",
    );

    vi.resetModules();
    const quotaStateB = await import("../src/lib/quota-state.js");
    await quotaStateB.fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });

    expect(provider.fetch).toHaveBeenCalledTimes(2);
  });

  it("treats cache version mismatches as a miss and refetches live data", async () => {
    const quotaStateA = await import("../src/lib/quota-state.js");
    quotaStateA.__resetQuotaStateForTests();

    const provider = {
      id: "synthetic",
      cachePolicy: { kind: "account-neutral" },
      isAvailable: vi.fn(),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [{ name: "Synthetic", percentRemaining: 55 }],
        errors: [],
      }),
    } as any;
    const ctx = createTestContext();
    const key = quotaStateA.buildQuotaProviderStateCacheKey(provider.id, ctx);
    const path = quotaStateA.getQuotaProviderStateCacheFilePath(provider.id, key);

    await quotaStateA.fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });
    await writeFile(
      path,
      JSON.stringify({
        version: 999,
        key: quotaStateA.getQuotaProviderCacheLocator(key),
        providerId: provider.id,
        timestamp: Date.now(),
        result: {
          attempted: true,
          entries: [{ name: "Synthetic", percentRemaining: 10 }],
          errors: [],
        },
      }),
      "utf-8",
    );

    vi.resetModules();
    const quotaStateB = await import("../src/lib/quota-state.js");
    await quotaStateB.fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });

    expect(provider.fetch).toHaveBeenCalledTimes(2);
  });

  it("bypasses persistence entirely for live-local providers", async () => {
    const { __resetQuotaStateForTests, fetchQuotaProviderResult } =
      await import("../src/lib/quota-state.js");
    __resetQuotaStateForTests();

    const provider = {
      id: "qwen-code",
      isAvailable: vi.fn(),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [{ name: "Qwen Free Daily", percentRemaining: 99 }],
        errors: [],
      }),
    } as any;

    await fetchQuotaProviderResult({
      provider,
      ctx: createTestContext(),
      ttlMs: 60_000,
    });
    await fetchQuotaProviderResult({
      provider,
      ctx: createTestContext(),
      ttlMs: 60_000,
    });

    await expect(readdir(`${TEST_RUNTIME_ROOT}/cache/quota-provider-state`)).rejects.toThrow();
    expect(provider.fetch).toHaveBeenCalledTimes(2);
  });
});

describe("readCachedProviderResult", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
  });

  it("returns { hit: false } when no memory or disk cache entry exists", async () => {
    const { __resetQuotaStateForTests, readCachedProviderResult } =
      await import("../src/lib/quota-state.js");
    __resetQuotaStateForTests();

    const provider = {
      id: "synthetic",
      cachePolicy: { kind: "account-neutral" },
      isAvailable: vi.fn(),
      fetch: vi.fn(),
    } as any;

    const result = await readCachedProviderResult({
      provider,
      ctx: createTestContext(),
      ttlMs: 60_000,
    });

    expect(result).toEqual(expect.objectContaining({ hit: false }));
  });

  it("returns { hit: true } with the cached result when cache is populated", async () => {
    const { __resetQuotaStateForTests, fetchQuotaProviderResult, readCachedProviderResult } =
      await import("../src/lib/quota-state.js");
    __resetQuotaStateForTests();

    const provider = {
      id: "synthetic",
      cachePolicy: { kind: "account-neutral" },
      isAvailable: vi.fn(),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [{ name: "Synthetic", percentRemaining: 75 }],
        errors: [],
      }),
    } as any;

    await fetchQuotaProviderResult({
      provider,
      ctx: createTestContext(),
      ttlMs: 60_000,
    });

    const result = await readCachedProviderResult({
      provider,
      ctx: createTestContext(),
      ttlMs: 60_000,
    });

    expect(result).toMatchObject({
      hit: true,
      result: {
        attempted: true,
        entries: [{ name: "Synthetic", percentRemaining: 75 }],
        errors: [],
      },
    });
  });

  it("populates inMemoryCache from disk entry on first read", async () => {
    const quotaStateA = await import("../src/lib/quota-state.js");
    quotaStateA.__resetQuotaStateForTests();

    const provider = {
      id: "synthetic",
      cachePolicy: { kind: "account-neutral" },
      isAvailable: vi.fn(),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [{ name: "Synthetic", percentRemaining: 42 }],
        errors: [],
      }),
    } as any;
    const ctx = createTestContext();
    const key = quotaStateA.buildQuotaProviderStateCacheKey(provider.id, ctx);
    const path = quotaStateA.getQuotaProviderStateCacheFilePath(provider.id, key);
    const { getPackageVersion } = await import("../src/lib/version.js");
    const packageVersion = (await getPackageVersion()) ?? "unknown";

    await mkdir(`${TEST_RUNTIME_ROOT}/cache/quota-provider-state`, { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        version: 2,
        packageVersion,
        key: quotaStateA.getQuotaProviderCacheLocator(key),
        providerId: provider.id,
        timestamp: Date.now(),
        result: {
          attempted: true,
          entries: [{ name: "Synthetic", percentRemaining: 42 }],
          errors: [],
        },
      }),
      "utf-8",
    );

    // First read: populates inMemoryCache from disk.
    const first = await quotaStateA.readCachedProviderResult({
      provider,
      ctx,
      ttlMs: 60_000,
    });
    expect(first).toMatchObject({ hit: true, result: { entries: [{ percentRemaining: 42 }] } });

    // Mutate the returned result to verify the cache stores a clone.
    (first as any).result.entries[0].percentRemaining = 999;

    // Second read: should still return the original cached value (not the mutated one).
    const second = await quotaStateA.readCachedProviderResult({
      provider,
      ctx,
      ttlMs: 60_000,
    });
    expect(second).toMatchObject({ hit: true, result: { entries: [{ percentRemaining: 42 }] } });
  });
});

describe("quota observation contract", () => {
  beforeEach(async () => {
    vi.resetModules();
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
  });
  afterEach(async () => {
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  it("preserves observation identity/time across coalescing, clones and disk reload; live fetches remain distinct", async () => {
    const state = await import("../src/lib/quota-state.js");
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const provider = {
      id: "synthetic",
      cachePolicy: { kind: "account-neutral" },
      fetch: vi.fn(async () => ({
        attempted: true,
        entries: [{ name: "Synthetic", percentRemaining: 55 }],
        errors: [],
      })),
    } as any;
    const params = { provider, ctx: createTestContext(), ttlMs: 60000 };
    const [a, b] = await Promise.all([
      state.fetchQuotaProviderResult(params),
      state.fetchQuotaProviderResult(params),
    ]);
    expect(provider.fetch).toHaveBeenCalledTimes(1);
    expect(a.observation).toEqual(b.observation);
    expect(a.observation).not.toBe(b.observation);
    state.__resetQuotaStateForTests();
    expect((await state.fetchQuotaProviderResult(params)).observation).toEqual(a.observation);
    const fresh = await state.fetchQuotaProviderResult({ ...params, bypassCache: true });
    expect(fresh.observation!.observedAt).toBe(a.observation!.observedAt);
    expect(fresh.observation!.id).not.toBe(a.observation!.id);
    // A v2 cache has a deterministic safe ID across independent legacy reads.
    const file = state.getQuotaProviderStateCacheFilePath(
      provider.id,
      state.buildQuotaProviderStateCacheKey(provider.id, params.ctx),
    );
    const { readFile } = await import("fs/promises");
    const data = JSON.parse(await readFile(file, "utf8"));
    data.version = 2;
    delete data.result.observation;
    await writeFile(file, JSON.stringify(data));
    state.__resetQuotaStateForTests();
    const legacy = await state.fetchQuotaProviderResult(params);
    state.__resetQuotaStateForTests();
    expect((await state.fetchQuotaProviderResult(params)).observation).toEqual(legacy.observation);
    expect(legacy.observation!.observedAt).toBe(data.timestamp);
    expect(legacy.observation!.id).toMatch(/^[a-f0-9]{64}$/);
  });
});
