import { access, mkdir, readdir, readFile, rm, writeFile } from "fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { validateQuotaProviders } from "../src/lib/quota-providers.js";

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

  it("keeps the latest live-local snapshot available to export cache reads", async () => {
    const { __resetQuotaStateForTests, fetchQuotaProviderResult, readCachedProviderResult } =
      await import("../src/lib/quota-state.js");
    __resetQuotaStateForTests();
    const provider = {
      id: "cursor",
      fetch: vi
        .fn()
        .mockResolvedValueOnce({
          attempted: true,
          entries: [{ accounting: TEST_ACCOUNTING, name: "Cursor", percentRemaining: 72 }],
          errors: [],
        })
        .mockResolvedValueOnce({
          attempted: true,
          entries: [{ accounting: TEST_ACCOUNTING, name: "Cursor", percentRemaining: 64 }],
          errors: [],
        }),
    } as any;
    const ctx = createTestContext();

    await fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });
    await fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000, bypassCache: true });
    const cached = await readCachedProviderResult({ provider, ctx, ttlMs: 60_000 });

    expect(provider.fetch).toHaveBeenCalledTimes(2);
    expect(cached).toMatchObject({
      hit: true,
      result: { entries: [{ name: "Cursor", percentRemaining: 64 }] },
    });
  });

  it("uses identical cache identity for alias-normalized and canonical definitions", async () => {
    const { buildQuotaProviderStateCacheKey } = await import("../src/lib/quota-state.js");
    const base = {
      id: "custom",
      mode: "remote-api",
      url: "https://provider.example/quota",
    };
    const alias = validateQuotaProviders([{ ...base, format: "accounting-v1" }]);
    const canonical = validateQuotaProviders([{ ...base, format: "quota-v1" }]);
    expect(alias.issues).toEqual([]);
    expect(canonical.issues).toEqual([]);

    const contextWith = (quotaProviders: NonNullable<typeof canonical.value>) => ({
      ...createTestContext(),
      config: { ...createTestContext().config, quotaProviders },
    });
    expect(buildQuotaProviderStateCacheKey("quota-providers", contextWith(alias.value!))).toBe(
      buildQuotaProviderStateCacheKey("quota-providers", contextWith(canonical.value!)),
    );
  });

  it("includes the normalized json-v1 adapter in cache identity", async () => {
    const { buildQuotaProviderStateCacheKey } = await import("../src/lib/quota-state.js");
    const definition = (path: string) =>
      validateQuotaProviders([
        {
          id: "custom",
          mode: "remote-api",
          url: "https://provider.example/quota",
          format: "json-v1",
          adapter: {
            mappings: [
              {
                resultType: "usage",
                name: "Usage",
                metric: {
                  type: "value",
                  valueType: "used",
                  value: { path: [path] },
                },
              },
            ],
          },
        },
      ]).value!;
    const contextWith = (quotaProviders: ReturnType<typeof definition>) => ({
      ...createTestContext(),
      config: { ...createTestContext().config, quotaProviders },
    });

    expect(
      buildQuotaProviderStateCacheKey("quota-providers", contextWith(definition("used"))),
    ).not.toBe(
      buildQuotaProviderStateCacheKey("quota-providers", contextWith(definition("usage"))),
    );
  });

  it("uses the full ordered quota-provider configuration but never credentials in aggregate identity", async () => {
    const { buildQuotaProviderStateCacheKey } = await import("../src/lib/quota-state.js");
    const base = createTestContext();
    const first = {
      id: "first",
      providerId: "provider-one",
      label: "First",
      url: "https://one.example/accounting",
      format: "quota-v1",
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
    const { __resetQuotaStateForTests, fetchQuotaProviderResult } = await import(
      "../src/lib/quota-state.js"
    );
    __resetQuotaStateForTests();

    const definitions = [
      {
        id: "project-a-source",
        providerId: "project-a",
        label: "Project A",
        mode: "remote-api",
        url: "https://a.example/accounting",
        format: "quota-v1",
      },
      {
        id: "project-b-source",
        providerId: "project-b",
        label: "Project B",
        mode: "remote-api",
        url: "https://b.example/accounting",
        format: "quota-v1",
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
    const { __resetQuotaStateForTests, fetchQuotaProviderResult } = await import(
      "../src/lib/quota-state.js"
    );
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
            format: "quota-v1",
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
    const { __resetQuotaStateForTests, fetchQuotaProviderResult } = await import(
      "../src/lib/quota-state.js"
    );
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
            format: "quota-v1",
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
    const { __resetQuotaStateForTests, fetchQuotaProviderResult } = await import(
      "../src/lib/quota-state.js"
    );
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
    const { __resetQuotaStateForTests, fetchQuotaProviderResult } = await import(
      "../src/lib/quota-state.js"
    );
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

  it("accepts all four entry variants and isolates every nested cache clone", async () => {
    const { __resetQuotaStateForTests, fetchQuotaProviderResult } = await import(
      "../src/lib/quota-state.js"
    );
    __resetQuotaStateForTests();
    const entries = [
      {
        accounting: { ...TEST_ACCOUNTING, resultType: "budget" },
        kind: "percent",
        name: "Monthly budget",
        percentRemaining: 75,
        semantic: {
          metric: { kind: "window", window: "month" },
          prominence: "primary",
        },
        basis: {
          used: {
            quantity: { decimal: "25.00", unit: { kind: "currency", code: "USD" } },
            authority: "provider_reported",
          },
          limit: {
            quantity: { decimal: "100", unit: { kind: "currency", code: "USD" } },
            authority: "user_configured",
          },
          remaining: {
            quantity: { decimal: "75", unit: { kind: "currency", code: "USD" } },
            authority: "locally_derived",
          },
        },
      },
      {
        accounting: { ...TEST_ACCOUNTING, resultType: "status" },
        kind: "value",
        name: "Legacy status",
        value: "Active",
      },
      {
        accounting: { ...TEST_ACCOUNTING, resultType: "balance" },
        kind: "quantity",
        name: "Balance",
        semantic: {
          metric: { kind: "component", component: "current_balance" },
          prominence: "supplementary",
        },
        quantity: { decimal: "42.500", unit: { kind: "currency", code: "USD" } },
      },
      {
        accounting: { ...TEST_ACCOUNTING, resultType: "status" },
        kind: "boolean",
        name: "Auto-reload",
        semantic: {
          metric: { kind: "component", component: "auto_reload" },
          prominence: "supplementary",
        },
        value: true,
      },
    ] as const;
    const provider = {
      id: "synthetic",
      isAvailable: vi.fn(),
      fetch: vi.fn().mockResolvedValue({ attempted: true, entries, errors: [] }),
    } as any;
    const ctx = createTestContext();

    const first = await fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });
    (first.entries[0] as any).semantic.metric.window = "day";
    (first.entries[0] as any).basis.limit.quantity.decimal = "1";
    (first.entries[0] as any).basis.limit.quantity.unit.code = "CNY";
    (first.entries[2] as any).quantity.decimal = "0";
    (first.entries[3] as any).value = false;

    const second = await fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });
    expect(second.entries).toEqual(entries);
    expect((second.entries[0] as any).semantic).not.toBe(entries[0].semantic);
    expect((second.entries[0] as any).basis.limit.quantity).not.toBe(
      entries[0].basis.limit.quantity,
    );
    expect((second.entries[2] as any).quantity).not.toBe(entries[2].quantity);
    expect(provider.fetch).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight fetch and returns independent snapshots", async () => {
    const { __resetQuotaStateForTests, fetchQuotaProviderResult } = await import(
      "../src/lib/quota-state.js"
    );
    __resetQuotaStateForTests();
    let resolveFetch!: (value: unknown) => void;
    const provider = {
      id: "synthetic",
      isAvailable: vi.fn(),
      fetch: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    } as any;
    const ctx = createTestContext();

    const firstPromise = fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });
    const secondPromise = fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });
    await vi.waitFor(() => expect(provider.fetch).toHaveBeenCalledTimes(1));
    resolveFetch({
      attempted: true,
      entries: [{ accounting: TEST_ACCOUNTING, name: "Synthetic", percentRemaining: 80 }],
      errors: [],
    });
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.entries[0]).not.toBe(second.entries[0]);
  });

  it("clears a thrown fetch from the in-flight slot", async () => {
    const { __resetQuotaStateForTests, fetchQuotaProviderResult } = await import(
      "../src/lib/quota-state.js"
    );
    __resetQuotaStateForTests();
    const provider = {
      id: "synthetic",
      isAvailable: vi.fn(),
      fetch: vi
        .fn()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce({
          attempted: true,
          entries: [{ accounting: TEST_ACCOUNTING, name: "Synthetic", percentRemaining: 80 }],
          errors: [],
        }),
    } as any;
    const ctx = createTestContext();

    await expect(fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 })).rejects.toThrow(
      "boom",
    );
    await expect(fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 })).resolves.toMatchObject(
      {
        entries: [{ percentRemaining: 80 }],
      },
    );
    expect(provider.fetch).toHaveBeenCalledTimes(2);
  });

  it("publishes authoritative cache timestamps and retires superseded bypass snapshots", async () => {
    const callbacks = new Map<string, (result: { observe(value: number): void }) => void>();
    const collectMetric = (name: string) => {
      const values: number[] = [];
      callbacks.get(name)?.({ observe: (value) => values.push(value) });
      return values;
    };
    const telemetry = await import("../src/lib/quota-telemetry.js");
    telemetry.__resetQuotaTelemetryForTests();
    telemetry.__setQuotaTelemetryApiLoaderForTests(async () => ({
      metrics: {
        getMeter: () => ({
          createObservableGauge: (name: string) => ({
            addCallback: (callback: (result: { observe(value: number): void }) => void) => {
              callbacks.set(name, callback);
            },
            removeCallback: () => {},
          }),
        }),
      },
    }));

    const quotaState = await import("../src/lib/quota-state.js");
    quotaState.__resetQuotaStateForTests();
    const ctx = createTestContext();
    ctx.config.telemetryToken = telemetry.configureQuotaTelemetry({
      owner: ctx.client,
      enabled: true,
      identity: "cache-integration",
    });
    const provider = {
      id: "synthetic",
      isAvailable: vi.fn(),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [{ accounting: TEST_ACCOUNTING, name: "Synthetic", percentRemaining: 50 }],
        errors: [],
      }),
    } as any;

    vi.spyOn(Date, "now").mockReturnValue(1_000);
    await quotaState.fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });
    await telemetry.__flushQuotaTelemetryInitializationForTests();
    const key = quotaState.buildQuotaProviderStateCacheKey(provider.id, ctx);
    const path = quotaState.getQuotaProviderStateCacheFilePath(provider.id, key);
    const persisted = JSON.parse(await (await import("fs/promises")).readFile(path, "utf8"));
    expect(persisted.version).toBe(2);
    expect(persisted.timestamp).toBe(1_000);
    expect(JSON.stringify(persisted)).not.toContain("telemetry");

    vi.mocked(Date.now).mockReturnValue(1_600);
    await quotaState.fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });
    quotaState.__resetQuotaStateForTests();
    await quotaState.readCachedProviderResult({ provider, ctx, ttlMs: 60_000 });
    const ages: number[] = [];
    callbacks.get("opencode.quota.cache.age")?.({
      observe: (value) => ages.push(value),
    });
    expect(ages).toEqual([0.6]);
    expect(provider.fetch).toHaveBeenCalledTimes(1);

    provider.fetch.mockResolvedValueOnce({ attempted: true, entries: [], errors: [] });
    await quotaState.fetchQuotaProviderResult({ provider, ctx, ttlMs: 0 });
    const consumedAfterClear: number[] = [];
    callbacks.get("opencode.quota.consumed")?.({
      observe: (value) => consumedAfterClear.push(value),
    });
    expect(consumedAfterClear).toEqual([]);

    provider.fetch.mockResolvedValueOnce({
      attempted: true,
      entries: [{ accounting: TEST_ACCOUNTING, name: "Synthetic", percentRemaining: 25 }],
      errors: [],
    });
    await quotaState.fetchQuotaProviderResult({
      provider,
      ctx,
      ttlMs: 60_000,
      bypassCache: true,
    });
    expect(collectMetric("opencode.quota.cache.age")).toEqual([]);
    expect(collectMetric("opencode.quota.consumed")).toEqual([0.75]);

    provider.fetch.mockResolvedValueOnce({
      attempted: true,
      entries: [{ accounting: TEST_ACCOUNTING, name: "Synthetic", percentRemaining: 75 }],
      errors: [],
    });
    await quotaState.fetchQuotaProviderResult({ provider, ctx, ttlMs: 0 });
    expect(collectMetric("opencode.quota.consumed")).toEqual([0.25]);
    vi.mocked(Date.now).mockReturnValue(2_200);
    expect(collectMetric("opencode.quota.cache.age")).toEqual([0.6]);

    provider.fetch.mockResolvedValueOnce({
      attempted: true,
      entries: [{ accounting: TEST_ACCOUNTING, name: "Synthetic", percentRemaining: 10 }],
      errors: [],
    });
    await quotaState.fetchQuotaProviderResult({
      provider,
      ctx,
      ttlMs: 60_000,
      bypassCache: true,
    });
    expect(collectMetric("opencode.quota.consumed")).toEqual([0.9]);
    expect(collectMetric("opencode.quota.cache.age")).toEqual([0.6]);

    provider.fetch.mockResolvedValueOnce({ attempted: true, entries: [], errors: [] });
    await quotaState.fetchQuotaProviderResult({ provider, ctx, ttlMs: 0 });
    expect(collectMetric("opencode.quota.consumed")).toEqual([]);
    expect(collectMetric("opencode.quota.cache.age")).toEqual([]);

    telemetry.__resetQuotaTelemetryForTests();
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
        errors: [
          {
            kind: "intentional-filter",
            label: "OpenRouter",
            message: "Skipped (current model: synthetic/default)",
          },
        ],
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
      errors: [
        {
          kind: "intentional-filter",
          label: "OpenRouter",
          message: "Skipped (current model: synthetic/default)",
        },
      ],
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

  it("keeps malformed JSON as a quiet cache miss without removing it before refetch", async () => {
    const quotaStateA = await import("../src/lib/quota-state.js");
    quotaStateA.__resetQuotaStateForTests();

    let resolveFetch: ((value: any) => void) | undefined;
    const provider = {
      id: "synthetic",
      isAvailable: vi.fn(),
      fetch: vi
        .fn()
        .mockResolvedValueOnce({
          attempted: true,
          entries: [{ accounting: TEST_ACCOUNTING, name: "Cached", percentRemaining: 55 }],
          errors: [],
        })
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveFetch = resolve;
            }),
        ),
    } as any;
    const ctx = createTestContext();
    const key = quotaStateA.buildQuotaProviderStateCacheKey(provider.id, ctx);
    const path = quotaStateA.getQuotaProviderStateCacheFilePath(provider.id, key);

    await quotaStateA.fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });
    await writeFile(path, "{ definitely-not-json", "utf-8");

    vi.resetModules();
    const quotaStateB = await import("../src/lib/quota-state.js");
    const pending = quotaStateB.fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });
    await vi.waitFor(() => expect(provider.fetch).toHaveBeenCalledTimes(2));

    await expect(readFile(path, "utf-8")).resolves.toBe("{ definitely-not-json");

    resolveFetch?.({ attempted: false, entries: [], errors: [] });
    await pending;
  });

  it("removes a parsed structurally invalid cache entry before refetch", async () => {
    const quotaStateA = await import("../src/lib/quota-state.js");
    quotaStateA.__resetQuotaStateForTests();

    let resolveFetch: ((value: any) => void) | undefined;
    const provider = {
      id: "synthetic",
      isAvailable: vi.fn(),
      fetch: vi
        .fn()
        .mockResolvedValueOnce({
          attempted: true,
          entries: [{ accounting: TEST_ACCOUNTING, name: "Cached", percentRemaining: 55 }],
          errors: [],
        })
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveFetch = resolve;
            }),
        ),
    } as any;
    const ctx = createTestContext();
    const key = quotaStateA.buildQuotaProviderStateCacheKey(provider.id, ctx);
    const path = quotaStateA.getQuotaProviderStateCacheFilePath(provider.id, key);

    await quotaStateA.fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });
    await writeFile(path, JSON.stringify({ version: 2, key }), "utf-8");

    vi.resetModules();
    const quotaStateB = await import("../src/lib/quota-state.js");
    const pending = quotaStateB.fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });
    await vi.waitFor(() => expect(provider.fetch).toHaveBeenCalledTimes(2));

    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });

    resolveFetch?.({ attempted: false, entries: [], errors: [] });
    await pending;
  });

  it("leaves a valid expired cache entry in place while refetching", async () => {
    const quotaStateA = await import("../src/lib/quota-state.js");
    quotaStateA.__resetQuotaStateForTests();

    let resolveFetch: ((value: any) => void) | undefined;
    const provider = {
      id: "synthetic",
      isAvailable: vi.fn(),
      fetch: vi
        .fn()
        .mockResolvedValueOnce({
          attempted: true,
          entries: [{ accounting: TEST_ACCOUNTING, name: "Cached", percentRemaining: 55 }],
          errors: [],
        })
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveFetch = resolve;
            }),
        ),
    } as any;
    const ctx = createTestContext();
    const key = quotaStateA.buildQuotaProviderStateCacheKey(provider.id, ctx);
    const path = quotaStateA.getQuotaProviderStateCacheFilePath(provider.id, key);

    await quotaStateA.fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });
    const persisted = JSON.parse(await readFile(path, "utf-8"));
    persisted.timestamp = Date.now() - 120_000;
    await writeFile(path, JSON.stringify(persisted), "utf-8");

    vi.resetModules();
    const quotaStateB = await import("../src/lib/quota-state.js");
    const pending = quotaStateB.fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });
    await vi.waitFor(() => expect(provider.fetch).toHaveBeenCalledTimes(2));

    await expect(access(path)).resolves.toBeUndefined();
    expect(JSON.parse(await readFile(path, "utf-8")).timestamp).toBe(persisted.timestamp);

    resolveFetch?.({ attempted: false, entries: [], errors: [] });
    await pending;
  });

  it("keeps cache read and write failures nonfatal", async () => {
    const quotaState = await import("../src/lib/quota-state.js");
    quotaState.__resetQuotaStateForTests();
    const provider = {
      id: "synthetic",
      isAvailable: vi.fn(),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [{ accounting: TEST_ACCOUNTING, name: "Fresh", percentRemaining: 55 }],
        errors: [],
      }),
    } as any;
    const ctx = createTestContext();
    const key = quotaState.buildQuotaProviderStateCacheKey(provider.id, ctx);
    const path = quotaState.getQuotaProviderStateCacheFilePath(provider.id, key);
    await mkdir(path, { recursive: true });

    const first = await quotaState.fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });
    const second = await quotaState.fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });

    expect(first.entries[0]?.name).toBe("Fresh");
    expect(second).toEqual(first);
    expect(provider.fetch).toHaveBeenCalledTimes(1);
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
        version: 2,
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
    const { __resetQuotaStateForTests, fetchQuotaProviderResult } = await import(
      "../src/lib/quota-state.js"
    );
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
        statusDetails: [{ key: "balance_usd", value: "$42.50" }],
        rawDetails: [{ key: "usage_usd", value: "$2.50" }],
        diagnostics: [
          {
            sourceId: "custom",
            providerId: "provider-one",
            mode: "remote-api",
            format: "quota-v1",
            modelIds: null,
            apiKeyEnv: "EXPLICIT_KEY",
            selected: true,
            attempted: true,
            credentialSource: "explicit_env",
            outcome: "success",
            entryCount: 1,
            checkedPaths: ["env:EXPLICIT_KEY"],
            credentialDatabasePaths: ["/trusted/opencode.db"],
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
            format: "quota-v1",
            apiKeyEnv: "EXPLICIT_KEY",
          },
        ],
      },
    };

    const first = await fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });
    first.diagnostics![0]!.checkedPaths[0] = "mutated";
    first.statusDetails![0]!.value = "mutated";
    first.rawDetails![0]!.value = "mutated";
    const second = await fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });

    expect(provider.fetch).toHaveBeenCalledTimes(1);
    expect(second.errors).toEqual([{ label: "Other", message: "request failed" }]);
    expect(second.diagnostics?.[0]?.checkedPaths).toEqual(["env:EXPLICIT_KEY"]);
    expect(second.statusDetails).toEqual([{ key: "balance_usd", value: "$42.50" }]);
    expect(second.rawDetails).toEqual([{ key: "usage_usd", value: "$2.50" }]);
  });

  it("rejects persisted diagnostics that use the deprecated format name", async () => {
    const quotaState = await import("../src/lib/quota-state.js");
    quotaState.__resetQuotaStateForTests();
    const definition = {
      id: "custom",
      providerId: "provider-one",
      label: "Custom",
      mode: "remote-api",
      url: "https://one.example/accounting",
      format: "quota-v1",
    } as const;
    const freshResult = {
      attempted: true,
      entries: [
        {
          accounting: {
            ...TEST_ACCOUNTING,
            ownership: "user_configured",
            sourceId: "custom",
          },
          name: "Fresh",
          percentRemaining: 90,
        },
      ],
      errors: [],
      diagnostics: [
        {
          sourceId: "custom",
          providerId: "provider-one",
          mode: "remote-api",
          format: "quota-v1",
          modelIds: null,
          apiKeyEnv: null,
          selected: true,
          attempted: true,
          credentialSource: "opencode_db",
          outcome: "success",
          entryCount: 1,
          checkedPaths: [],
          credentialDatabasePaths: [],
        },
      ],
    } as const;
    const provider = {
      id: "quota-providers",
      isAvailable: vi.fn(),
      fetch: vi.fn().mockResolvedValue(freshResult),
    } as any;
    const ctx = {
      ...createTestContext(),
      config: {
        ...createTestContext().config,
        quotaProviders: [definition],
      },
    };
    const key = quotaState.buildQuotaProviderStateCacheKey(provider.id, ctx, {
      runtimeEligibleQuotaProviders: [],
    });
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
          ...freshResult,
          entries: [
            {
              accounting: {
                ...TEST_ACCOUNTING,
                ownership: "user_configured",
                sourceId: "custom",
              },
              name: "Stale",
              percentRemaining: 10,
            },
          ],
          diagnostics: [
            {
              ...freshResult.diagnostics[0],
              format: "accounting-v1",
            },
          ],
        },
      }),
      "utf-8",
    );

    const result = await quotaState.fetchQuotaProviderResult({
      provider,
      ctx,
      ttlMs: 60_000,
    });
    expect(result.entries[0]?.name).toBe("Fresh");
    expect(provider.fetch).toHaveBeenCalledTimes(1);
  });

  it("bypasses persistence entirely for live-local providers", async () => {
    const { __resetQuotaStateForTests, fetchQuotaProviderResult } = await import(
      "../src/lib/quota-state.js"
    );
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

  it("rejects and replaces a cache v2 row containing barValue", async () => {
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
              accounting: TEST_ACCOUNTING,
              name: "Stale",
              percentRemaining: 50,
              barValue: "USD 42.50",
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
    const replacement = JSON.parse(await (await import("fs/promises")).readFile(path, "utf8"));
    expect(replacement.version).toBe(2);
    expect(JSON.stringify(replacement)).not.toContain("barValue");
  });

  it("does not cache a malformed live provider result", async () => {
    const { fetchQuotaProviderResult, readCachedProviderResult } = await import(
      "../src/lib/quota-state.js"
    );
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

  it("rejects malformed structured variants and basis invariants", async () => {
    const { fetchQuotaProviderResult } = await import("../src/lib/quota-state.js");
    const semantic = {
      metric: { kind: "component", component: "current_balance" },
      prominence: "primary",
    };
    const base = { accounting: TEST_ACCOUNTING, name: "Invalid" };
    const invalidEntries = [
      {
        ...base,
        kind: "quantity",
        semantic: { metric: { kind: "aggregate" } },
        quantity: { decimal: "1", unit: { kind: "currency", code: "USD" } },
      },
      {
        ...base,
        kind: "quantity",
        semantic,
        quantity: { decimal: "01", unit: { kind: "currency", code: "USD" } },
      },
      {
        ...base,
        kind: "quantity",
        semantic,
        quantity: { decimal: "1", unit: { kind: "currency", code: "usd" } },
      },
      {
        ...base,
        kind: "quantity",
        semantic: { metric: { kind: "named", name: "\u001b[31m" }, prominence: "primary" },
        quantity: { decimal: "1", unit: { kind: "currency", code: "USD" } },
      },
      { ...base, kind: "boolean", semantic, value: "true" },
      {
        ...base,
        kind: "percent",
        percentRemaining: 50,
        basis: {
          used: {
            quantity: { decimal: "-1", unit: { kind: "count", unit: "token" } },
            authority: "provider_reported",
          },
        },
      },
      {
        ...base,
        kind: "percent",
        percentRemaining: 50,
        basis: {
          used: {
            quantity: { decimal: "1", unit: { kind: "count", unit: "token" } },
            authority: "provider_reported",
          },
          limit: {
            quantity: { decimal: "10", unit: { kind: "count", unit: "request" } },
            authority: "provider_reported",
          },
        },
      },
      {
        ...base,
        accounting: { ...TEST_ACCOUNTING, authority: "user_configured" },
        percentRemaining: 50,
      },
      {
        ...base,
        percentRemaining: 50,
        resetTimeIso: "\u001b[31m2026-08-01T00:00:00.000Z",
      },
    ];

    for (const entry of invalidEntries) {
      const provider = {
        id: "synthetic",
        isAvailable: vi.fn(),
        fetch: vi.fn().mockResolvedValue({ attempted: true, entries: [entry], errors: [] }),
      } as any;
      await expect(
        fetchQuotaProviderResult({
          provider,
          ctx: createTestContext(),
          ttlMs: 60_000,
          bypassCache: true,
        }),
      ).resolves.toMatchObject({
        attempted: true,
        entries: [],
        errors: [{ message: "Invalid normalized provider result" }],
      });
    }
  });

  it("sanitizes structured text before caching and reuses only the safe snapshot", async () => {
    const quotaStateA = await import("../src/lib/quota-state.js");
    quotaStateA.__resetQuotaStateForTests();
    const provider = {
      id: "synthetic",
      isAvailable: vi.fn(),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [
          {
            accounting: TEST_ACCOUNTING,
            kind: "quantity",
            name: "Known balance\u001b[31m",
            group: "Synthetic\u001b[0m",
            semantic: {
              metric: { kind: "named", name: "Known\u001b[31m API" },
              prominence: "primary",
            },
            quantity: { decimal: "25.5", unit: { kind: "custom", symbol: "NANO\u001b[31m" } },
          },
        ],
        errors: [],
      }),
    } as any;
    const ctx = createTestContext();

    const first = await quotaStateA.fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });
    expect(first.entries[0]).toMatchObject({
      name: "Known balance",
      group: "Synthetic",
      semantic: { metric: { name: "Known API" } },
      quantity: { unit: { symbol: "NANO" } },
    });
    const key = quotaStateA.buildQuotaProviderStateCacheKey(provider.id, ctx);
    const path = quotaStateA.getQuotaProviderStateCacheFilePath(provider.id, key);
    expect(await (await import("fs/promises")).readFile(path, "utf8")).not.toContain("\u001b");

    vi.resetModules();
    const quotaStateB = await import("../src/lib/quota-state.js");
    const second = await quotaStateB.fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });
    expect(second).toEqual(first);
    expect(provider.fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a live barValue row and does not cache it", async () => {
    const { fetchQuotaProviderResult, readCachedProviderResult } = await import(
      "../src/lib/quota-state.js"
    );
    const provider = {
      id: "opencode",
      isAvailable: vi.fn(),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [
          {
            accounting: TEST_ACCOUNTING,
            name: "",
            group: "OpenCode Zen",
            percentRemaining: 94.25,
            barValue: "USD 42.50",
          },
        ],
        errors: [],
      }),
    } as any;
    const ctx = createTestContext();

    const first = await fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });
    const second = await fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });

    expect(first).toEqual({
      attempted: true,
      entries: [],
      errors: [{ label: "OpenCode Zen", message: "Invalid normalized provider result" }],
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
    const { __resetQuotaStateForTests, readCachedProviderResult } = await import(
      "../src/lib/quota-state.js"
    );
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
