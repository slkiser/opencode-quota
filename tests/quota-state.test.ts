import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readdir, rm, writeFile } from "fs/promises";

const TEST_RUNTIME_ROOT = "/tmp/opencode-quota-state-tests";
const TEST_ACCOUNTING = {
  resultType: "quota",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
} as const;

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
      cursorPlan: "none",
      onlyCurrentModel: false,
    },
  } as any;
}

describe("quota-state shared cache", () => {
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

  it("uses the full ordered quota-provider configuration but never credentials in aggregate identity", async () => {
    const { buildQuotaProviderStateCacheKey } = await import("../src/lib/quota-state.js");
    const base = createTestContext();
    const first = {
      id: "first",
      providerId: "provider-one",
      label: "First",
      url: "https://one.example/accounting",
      format: "accounting-v1",
      apiKeyEnv: "EXPLICIT_KEY",
      modelIds: ["provider-one/a", "provider-one/b"],
    };
    const second = {
      id: "second",
      providerId: "provider-two",
      label: "Second",
      url: "https://two.example/key",
      format: "openrouter-key-v1",
    };
    process.env.EXPLICIT_KEY = "credential-must-not-be-in-cache-key";
    try {
      const key = buildQuotaProviderStateCacheKey("quota-providers", {
        ...base,
        config: { ...base.config, quotaProviders: [first, second] },
      } as any);
      const reordered = buildQuotaProviderStateCacheKey("quota-providers", {
        ...base,
        config: { ...base.config, quotaProviders: [second, first] },
      } as any);
      const relabeled = buildQuotaProviderStateCacheKey("quota-providers", {
        ...base,
        config: {
          ...base.config,
          quotaProviders: [{ ...first, label: "Changed" }, second],
        },
      } as any);
      const modelReordered = buildQuotaProviderStateCacheKey("quota-providers", {
        ...base,
        config: {
          ...base.config,
          quotaProviders: [{ ...first, modelIds: ["provider-one/b", "provider-one/a"] }, second],
        },
      } as any);

      expect(key).toContain("EXPLICIT_KEY");
      expect(key).not.toContain("credential-must-not-be-in-cache-key");
      expect(new Set([key, reordered, relabeled, modelReordered]).size).toBe(4);
      expect(
        buildQuotaProviderStateCacheKey("synthetic", {
          ...base,
          config: { ...base.config, quotaProviders: [first] },
        } as any),
      ).toBe(
        buildQuotaProviderStateCacheKey("synthetic", {
          ...base,
          config: { ...base.config, quotaProviders: [second] },
        } as any),
      );
    } finally {
      delete process.env.EXPLICIT_KEY;
    }
  });

  it("isolates aggregate cache entries for disjoint project provider catalogs", async () => {
    const { __resetQuotaStateForTests, fetchQuotaProviderResult } =
      await import("../src/lib/quota-state.js");
    __resetQuotaStateForTests();

    const definitions = [
      {
        id: "project-a-source",
        providerId: "project-a",
        label: "Project A",
        mode: "remote-api",
        url: "https://a.example/accounting",
        format: "accounting-v1",
      },
      {
        id: "project-b-source",
        providerId: "project-b",
        label: "Project B",
        mode: "remote-api",
        url: "https://b.example/accounting",
        format: "accounting-v1",
      },
    ];
    const provider = {
      id: "quota-providers",
      isAvailable: vi.fn(),
      fetch: vi.fn(async (ctx: any) => {
        const catalog = await ctx.client.config.providers();
        const name = catalog.data.providers[0].id;
        return {
          attempted: true,
          entries: [
            {
              accounting: {
                ...TEST_ACCOUNTING,
                ownership: "user_configured",
              },
              name,
              percentRemaining: 50,
            },
          ],
          errors: [],
        };
      }),
    } as any;
    const contextFor = (providerId: string) => ({
      ...createTestContext(),
      client: {
        config: {
          providers: async () => ({ data: { providers: [{ id: providerId }] } }),
          get: async () => ({ data: {} }),
        },
      },
      config: {
        ...createTestContext().config,
        enabledProviders: "auto",
        quotaProviders: definitions,
      },
    });

    const projectA = await fetchQuotaProviderResult({
      provider,
      ctx: contextFor("project-a") as any,
      ttlMs: 60_000,
    });
    const projectB = await fetchQuotaProviderResult({
      provider,
      ctx: contextFor("project-b") as any,
      ttlMs: 60_000,
    });
    const projectAAgain = await fetchQuotaProviderResult({
      provider,
      ctx: contextFor("project-a") as any,
      ttlMs: 60_000,
    });

    expect(projectA.entries[0]?.name).toBe("project-a");
    expect(projectB.entries[0]?.name).toBe("project-b");
    expect(projectAAgain.entries[0]?.name).toBe("project-a");
    expect(provider.fetch).toHaveBeenCalledTimes(2);
  });

  it("does not share aggregate cache state when the runtime provider catalog is unavailable", async () => {
    const { __resetQuotaStateForTests, fetchQuotaProviderResult } =
      await import("../src/lib/quota-state.js");
    __resetQuotaStateForTests();

    let fetchCount = 0;
    const provider = {
      id: "quota-providers",
      isAvailable: vi.fn(),
      fetch: vi.fn(async () => ({
        attempted: true,
        entries: [
          {
            accounting: { ...TEST_ACCOUNTING, ownership: "user_configured" },
            name: `fresh-${++fetchCount}`,
            percentRemaining: 50,
          },
        ],
        errors: [],
      })),
    } as any;
    const ctx = {
      ...createTestContext(),
      client: {
        config: {
          providers: async () => {
            throw new Error("catalog unavailable");
          },
          get: async () => ({ data: {} }),
        },
      },
      config: {
        ...createTestContext().config,
        quotaProviders: [
          {
            id: "remote-project",
            providerId: "remote-project",
            label: "Remote",
            mode: "remote-api",
            url: "https://remote.example/accounting",
            format: "accounting-v1",
          },
        ],
      },
    } as any;

    const first = await fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });
    const second = await fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });

    expect(first.entries[0]?.name).toBe("fresh-1");
    expect(second.entries[0]?.name).toBe("fresh-2");
    expect(provider.fetch).toHaveBeenCalledTimes(2);
  });

  it("retains remote child TTL caching without another runtime catalog lookup", async () => {
    const { __resetQuotaStateForTests, fetchQuotaProviderResult } =
      await import("../src/lib/quota-state.js");
    __resetQuotaStateForTests();

    const provider = {
      id: "quota-providers:remote-project",
      isAvailable: vi.fn(),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [
          {
            accounting: { ...TEST_ACCOUNTING, ownership: "user_configured" },
            name: "Remote project",
            percentRemaining: 50,
          },
        ],
        errors: [],
      }),
    } as any;
    const providers = vi.fn(async () => {
      throw new Error("child cache must not resolve the runtime catalog");
    });
    const ctx = {
      ...createTestContext(),
      client: { config: { providers, get: async () => ({ data: {} }) } },
      config: {
        ...createTestContext().config,
        quotaProviders: [
          {
            id: "remote-project",
            providerId: "remote-project",
            label: "Remote",
            mode: "remote-api",
            url: "https://remote.example/accounting",
            format: "accounting-v1",
          },
        ],
      },
    } as any;

    await fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });
    await fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });

    expect(providers).not.toHaveBeenCalled();
    expect(provider.fetch).toHaveBeenCalledTimes(1);
  });

  it("refreshes aggregates that have a runtime-eligible local definition", async () => {
    const { __resetQuotaStateForTests, fetchQuotaProviderResult } =
      await import("../src/lib/quota-state.js");
    __resetQuotaStateForTests();

    let fetchCount = 0;
    const provider = {
      id: "quota-providers",
      isAvailable: vi.fn(),
      fetch: vi.fn(async () => {
        fetchCount += 1;
        return {
          attempted: true,
          entries: [
            {
              accounting: {
                resultType: "rate_limit",
                acquisitionMethod: "local_estimation",
                ownership: "user_configured",
                authority: "locally_derived",
              },
              name: "Local",
              percentRemaining: 100 - fetchCount,
            },
          ],
          errors: [],
        };
      }),
    } as any;
    const ctx = {
      ...createTestContext(),
      client: {
        config: {
          providers: async () => ({ data: { providers: [{ id: "local-project" }] } }),
          get: async () => ({ data: {} }),
        },
      },
      config: {
        ...createTestContext().config,
        enabledProviders: "auto",
        quotaProviders: [
          {
            id: "local-project",
            providerId: "local-project",
            label: "Local",
            mode: "local-estimate",
            windows: [{ id: "day", label: "Day", type: "utc-day", requestLimit: 10 }],
          },
        ],
      },
    } as any;

    const first = await fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });
    const second = await fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });

    expect(provider.fetch).toHaveBeenCalledTimes(2);
    expect(first.entries[0]?.percentRemaining).toBe(99);
    expect(second.entries[0]?.percentRemaining).toBe(98);
  });

  it("returns cache-owned clones for repeated non-live provider reads", async () => {
    const { __resetQuotaStateForTests, fetchQuotaProviderResult } =
      await import("../src/lib/quota-state.js");
    __resetQuotaStateForTests();

    const provider = {
      id: "synthetic",
      isAvailable: vi.fn(),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [
          {
            accounting: TEST_ACCOUNTING,
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
    firstEntry.accounting.resultType = "status";

    const second = await fetchQuotaProviderResult({
      provider,
      ctx: createTestContext(),
      ttlMs: 60_000,
    });

    expect(second).toEqual({
      attempted: true,
      entries: [
        {
          accounting: TEST_ACCOUNTING,
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
    });
    expect(provider.fetch).toHaveBeenCalledTimes(1);
  });

  it("reuses cache v2 with accounting metadata across module resets", async () => {
    const quotaStateA = await import("../src/lib/quota-state.js");
    quotaStateA.__resetQuotaStateForTests();

    const provider = {
      id: "synthetic",
      isAvailable: vi.fn(),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [{ accounting: TEST_ACCOUNTING, name: "Synthetic", percentRemaining: 55 }],
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

    expect(second).toEqual({
      attempted: true,
      entries: [{ accounting: TEST_ACCOUNTING, name: "Synthetic", percentRemaining: 55 }],
      errors: [],
    });
    expect(provider.fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects cache v1 and legacy-only presentation fields without migration", async () => {
    const quotaStateA = await import("../src/lib/quota-state.js");
    quotaStateA.__resetQuotaStateForTests();

    const provider = {
      id: "synthetic",
      isAvailable: vi.fn(),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [{ accounting: TEST_ACCOUNTING, name: "Synthetic", percentRemaining: 55 }],
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
        version: 1,
        packageVersion,
        key,
        providerId: provider.id,
        timestamp: Date.now(),
        result: {
          attempted: true,
          entries: [{ accounting: TEST_ACCOUNTING, name: "Synthetic", percentRemaining: 55 }],
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

    expect(result).toEqual({
      attempted: true,
      entries: [{ accounting: TEST_ACCOUNTING, name: "Synthetic", percentRemaining: 55 }],
      errors: [],
    });
    expect(provider.fetch).toHaveBeenCalledTimes(1);
  });

  it("treats cache corruption as a miss and refetches live data", async () => {
    const quotaStateA = await import("../src/lib/quota-state.js");
    quotaStateA.__resetQuotaStateForTests();

    const provider = {
      id: "synthetic",
      isAvailable: vi.fn(),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [{ accounting: TEST_ACCOUNTING, name: "Synthetic", percentRemaining: 55 }],
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
      isAvailable: vi.fn(),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [{ accounting: TEST_ACCOUNTING, name: "Synthetic", percentRemaining: 55 }],
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
        version: 1,
        packageVersion: "0.0.0-stale-cache",
        key,
        providerId: provider.id,
        timestamp: Date.now(),
        result: {
          attempted: true,
          entries: [{ accounting: TEST_ACCOUNTING, name: "Synthetic", percentRemaining: 10 }],
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
      isAvailable: vi.fn(),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [{ accounting: TEST_ACCOUNTING, name: "Synthetic", percentRemaining: 55 }],
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
        key,
        providerId: provider.id,
        timestamp: Date.now(),
        result: {
          attempted: true,
          entries: [{ accounting: TEST_ACCOUNTING, name: "Synthetic", percentRemaining: 10 }],
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

  it("does not cache attempted provider results that contain only errors", async () => {
    const { __resetQuotaStateForTests, fetchQuotaProviderResult, readCachedProviderResult } =
      await import("../src/lib/quota-state.js");
    __resetQuotaStateForTests();

    const provider = {
      id: "anthropic",
      isAvailable: vi.fn(),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [],
        errors: [{ label: "Anthropic", message: "rate limited" }],
      }),
    } as any;
    const ctx = createTestContext();

    await fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });
    await fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });

    expect(provider.fetch).toHaveBeenCalledTimes(2);
    await expect(readCachedProviderResult({ provider, ctx, ttlMs: 60_000 })).resolves.toEqual({
      hit: false,
    });
  });

  it("caches entry-bearing partial aggregates including internal diagnostics", async () => {
    const { __resetQuotaStateForTests, fetchQuotaProviderResult } =
      await import("../src/lib/quota-state.js");
    __resetQuotaStateForTests();

    const provider = {
      id: "quota-providers",
      isAvailable: vi.fn(),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [
          {
            accounting: {
              ...TEST_ACCOUNTING,
              ownership: "user_configured",
            },
            name: "Custom",
            percentRemaining: 50,
          },
        ],
        errors: [{ label: "Other", message: "request failed" }],
        diagnostics: [
          {
            sourceId: "custom",
            providerId: "provider-one",
            mode: "remote-api",
            format: "accounting-v1",
            modelIds: null,
            apiKeyEnv: "EXPLICIT_KEY",
            selected: true,
            attempted: true,
            credentialSource: "explicit_env",
            outcome: "success",
            entryCount: 1,
            checkedPaths: ["env:EXPLICIT_KEY"],
            authPaths: ["/trusted/auth.json"],
          },
        ],
      }),
    } as any;
    const ctx = {
      ...createTestContext(),
      config: {
        ...createTestContext().config,
        quotaProviders: [
          {
            id: "custom",
            providerId: "provider-one",
            label: "Custom",
            mode: "remote-api",
            url: "https://one.example/accounting",
            format: "accounting-v1",
            apiKeyEnv: "EXPLICIT_KEY",
          },
        ],
      },
    };

    const first = await fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });
    first.diagnostics![0]!.checkedPaths[0] = "mutated";
    const second = await fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });

    expect(provider.fetch).toHaveBeenCalledTimes(1);
    expect(second.errors).toEqual([{ label: "Other", message: "request failed" }]);
    expect(second.diagnostics?.[0]?.checkedPaths).toEqual(["env:EXPLICIT_KEY"]);
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
        entries: [{ accounting: TEST_ACCOUNTING, name: "Qwen Free Daily", percentRemaining: 99 }],
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

  it("rejects the whole cache v2 result when one entry is malformed", async () => {
    const quotaStateA = await import("../src/lib/quota-state.js");
    quotaStateA.__resetQuotaStateForTests();

    const provider = {
      id: "synthetic",
      isAvailable: vi.fn(),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [{ accounting: TEST_ACCOUNTING, name: "Fresh", percentRemaining: 90 }],
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
        key,
        providerId: provider.id,
        timestamp: Date.now(),
        result: {
          attempted: true,
          entries: [
            { accounting: TEST_ACCOUNTING, name: "Valid", percentRemaining: 50 },
            { name: "Missing accounting", percentRemaining: 25 },
          ],
          errors: [],
        },
      }),
      "utf-8",
    );

    const result = await quotaStateA.fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });
    expect(result.entries).toEqual([
      { accounting: TEST_ACCOUNTING, name: "Fresh", percentRemaining: 90 },
    ]);
    expect(provider.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not cache a malformed live provider result", async () => {
    const { fetchQuotaProviderResult, readCachedProviderResult } =
      await import("../src/lib/quota-state.js");
    const provider = {
      id: "synthetic",
      isAvailable: vi.fn(),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [{ name: "Missing accounting", percentRemaining: 25 }],
        errors: [],
      }),
    } as any;
    const ctx = createTestContext();

    const first = await fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });
    const second = await fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });

    expect(first).toEqual({
      attempted: true,
      entries: [],
      errors: [{ label: "Synthetic", message: "Invalid normalized provider result" }],
    });
    expect(second).toEqual(first);
    expect(provider.fetch).toHaveBeenCalledTimes(2);
    await expect(readCachedProviderResult({ provider, ctx, ttlMs: 60_000 })).resolves.toEqual({
      hit: false,
    });
  });

  it("rejects cache v2 timestamps that are parseable but not ISO", async () => {
    const quotaState = await import("../src/lib/quota-state.js");
    quotaState.__resetQuotaStateForTests();
    const provider = {
      id: "synthetic",
      isAvailable: vi.fn(),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [{ accounting: TEST_ACCOUNTING, name: "Fresh", percentRemaining: 90 }],
        errors: [],
      }),
    } as any;
    const ctx = createTestContext();
    const key = quotaState.buildQuotaProviderStateCacheKey(provider.id, ctx);
    const path = quotaState.getQuotaProviderStateCacheFilePath(provider.id, key);
    const { getPackageVersion } = await import("../src/lib/version.js");
    const packageVersion = (await getPackageVersion()) ?? "unknown";

    await mkdir(`${TEST_RUNTIME_ROOT}/cache/quota-provider-state`, { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        version: 2,
        packageVersion,
        key,
        providerId: provider.id,
        timestamp: Date.now(),
        result: {
          attempted: true,
          entries: [
            {
              accounting: { ...TEST_ACCOUNTING, observedAtIso: "07/11/2026" },
              name: "Stale",
              percentRemaining: 10,
              resetTimeIso: "July 11, 2026",
            },
          ],
          errors: [],
        },
      }),
      "utf-8",
    );

    const result = await quotaState.fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });
    expect(result.entries[0]?.name).toBe("Fresh");
    expect(provider.fetch).toHaveBeenCalledTimes(1);
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
      isAvailable: vi.fn(),
      fetch: vi.fn(),
    } as any;

    const result = await readCachedProviderResult({
      provider,
      ctx: createTestContext(),
      ttlMs: 60_000,
    });

    expect(result).toEqual({ hit: false });
  });

  it("returns { hit: true } with the cached result when cache is populated", async () => {
    const { __resetQuotaStateForTests, fetchQuotaProviderResult, readCachedProviderResult } =
      await import("../src/lib/quota-state.js");
    __resetQuotaStateForTests();

    const provider = {
      id: "synthetic",
      isAvailable: vi.fn(),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [{ accounting: TEST_ACCOUNTING, name: "Synthetic", percentRemaining: 75 }],
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
        entries: [{ accounting: TEST_ACCOUNTING, name: "Synthetic", percentRemaining: 75 }],
        errors: [],
      },
    });
  });

  it("populates inMemoryCache from disk entry on first read", async () => {
    const quotaStateA = await import("../src/lib/quota-state.js");
    quotaStateA.__resetQuotaStateForTests();

    const provider = {
      id: "synthetic",
      isAvailable: vi.fn(),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [{ accounting: TEST_ACCOUNTING, name: "Synthetic", percentRemaining: 42 }],
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
        key,
        providerId: provider.id,
        timestamp: Date.now(),
        result: {
          attempted: true,
          entries: [{ accounting: TEST_ACCOUNTING, name: "Synthetic", percentRemaining: 42 }],
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
    (first as any).result.entries[0].accounting.resultType = "status";

    // Second read: should still return the original cached value (not the mutated one).
    const second = await quotaStateA.readCachedProviderResult({
      provider,
      ctx,
      ttlMs: 60_000,
    });
    expect(second).toMatchObject({
      hit: true,
      result: { entries: [{ accounting: TEST_ACCOUNTING, percentRemaining: 42 }] },
    });
  });
});
