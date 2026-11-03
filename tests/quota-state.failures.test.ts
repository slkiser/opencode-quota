import { access, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { runtimeRoot } = vi.hoisted(() => ({
  runtimeRoot: `/tmp/opencode-quota-failure-tests-${process.pid}`,
}));

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirs: () => ({
    dataDir: `${runtimeRoot}/data`,
    configDir: `${runtimeRoot}/config`,
    cacheDir: `${runtimeRoot}/cache`,
    stateDir: `${runtimeRoot}/state`,
  }),
}));

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const success = {
  attempted: true,
  entries: [
    {
      accounting: {
        resultType: "quota",
        acquisitionMethod: "remote_api",
        ownership: "maintained",
        authority: "provider_reported",
      },
      name: "Claude",
      percentRemaining: 80,
    },
  ],
  errors: [],
};

describe.each(["darwin", "win32"] as const)("quota failure backoff on %s", (platform) => {
  beforeEach(async () => {
    vi.resetModules();
    Object.defineProperty(process, "platform", { configurable: true, value: platform });
    await rm(runtimeRoot, { recursive: true, force: true });
  });

  afterEach(async () => {
    Object.defineProperty(process, "platform", platformDescriptor);
    vi.restoreAllMocks();
    await rm(runtimeRoot, { recursive: true, force: true });
  });

  it.skipIf(platform !== "win32" && typeof process.getuid !== "function")(
    "limits 20 immediate failed reads to one fetch per account without persisting errors",
    async () => {
      const quotaState = await import("../src/lib/quota-state.js");
      const { deriveResolvedAuthIdentity, isResolvedAuthIdentityKeyProcessLocal } =
        await import("../src/lib/resolved-auth-identity.js");
      expect(isResolvedAuthIdentityKeyProcessLocal()).toBe(platform === "win32");
      let account = "account-one";
      const provider = {
        id: "anthropic",
        cachePolicy: {
          kind: "resolved-auth",
          resolveIdentity: () =>
            deriveResolvedAuthIdentity({
              providerId: "anthropic",
              principal: { kind: "credential", value: account },
            }),
        },
        fetch: vi.fn().mockResolvedValue({
          attempted: true,
          entries: [],
          errors: [{ label: "Claude", message: "Service unavailable" }],
        }),
      } as any;
      const ctx = { client: {}, config: { cursorPlan: "none" } } as any;
      const read = () => quotaState.fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });

      for (let i = 0; i < 20; i++) await read();
      expect(provider.fetch).toHaveBeenCalledTimes(1);
      const key = quotaState.buildQuotaProviderStateCacheKey(provider.id, ctx, {
        resolvedAuthIdentity: await provider.cachePolicy.resolveIdentity(),
      });
      await expect(
        access(quotaState.getQuotaProviderStateCacheFilePath(provider.id, key)),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });

      account = "account-two";
      await read();
      expect(provider.fetch).toHaveBeenCalledTimes(2);
      account = "account-one";
      await read();
      expect(provider.fetch).toHaveBeenCalledTimes(2);

      quotaState.__resetQuotaStateForTests();
      await read();
      expect(provider.fetch).toHaveBeenCalledTimes(3);
    },
  );

  it.each([
    { ttlMs: 60_000, waitMs: 30_000 },
    { ttlMs: 10_000, waitMs: 10_000 },
    { ttlMs: 60_000, waitMs: 10_000, providerWaitMs: 10_000 },
    { ttlMs: 60_000, waitMs: 120_000, providerWaitMs: 120_000 },
  ])(
    "retries after $waitMs ms with TTL $ttlMs and provider wait $providerWaitMs",
    async ({ ttlMs, waitMs, providerWaitMs }) => {
      const { fetchQuotaProviderResult } = await import("../src/lib/quota-state.js");
      const startedAt = Date.now();
      const now = vi.spyOn(Date, "now").mockReturnValue(startedAt);
      const failure = {
        attempted: true,
        entries: [],
        errors: [
          {
            label: "Claude",
            message: "Service unavailable",
            ...(providerWaitMs === undefined ? {} : { retryAtMs: startedAt + providerWaitMs }),
          },
        ],
      };
      const provider = {
        id: "anthropic",
        cachePolicy: { kind: "account-neutral" },
        fetch: vi.fn().mockResolvedValueOnce(failure).mockResolvedValue(success),
      } as any;
      const ctx = { client: {}, config: { cursorPlan: "none" } } as any;
      const read = () => fetchQuotaProviderResult({ provider, ctx, ttlMs });

      expect(await read()).toEqual(failure);
      now.mockReturnValue(startedAt + waitMs - 1);
      expect(await read()).toEqual(failure);
      expect(provider.fetch).toHaveBeenCalledTimes(1);
      now.mockReturnValue(startedAt + waitMs);
      expect(await read()).toEqual(success);
      expect(await read()).toEqual(success);
      expect(provider.fetch).toHaveBeenCalledTimes(2);
    },
  );

  it("replaces a cached failure after a successful forced retry", async () => {
    const { fetchQuotaProviderResult, readCachedProviderResult } =
      await import("../src/lib/quota-state.js");
    const provider = {
      id: "anthropic",
      cachePolicy: { kind: "account-neutral" },
      fetch: vi
        .fn()
        .mockResolvedValueOnce({
          attempted: true,
          entries: [],
          errors: [{ label: "Claude", message: "Service unavailable" }],
        })
        .mockResolvedValue(success),
    } as any;
    const params = {
      provider,
      ctx: { client: {}, config: { cursorPlan: "none" } } as any,
      ttlMs: 60_000,
    };

    await fetchQuotaProviderResult(params);
    expect(await fetchQuotaProviderResult({ ...params, bypassCache: true })).toEqual(success);
    expect(await fetchQuotaProviderResult(params)).toEqual(success);
    expect(await readCachedProviderResult(params)).toMatchObject({ hit: true, result: success });
    expect(provider.fetch).toHaveBeenCalledTimes(2);
  });

  it("removes a persisted success when its refresh returns only errors", async () => {
    const quotaState = await import("../src/lib/quota-state.js");
    const startedAt = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(startedAt);
    const failure = {
      attempted: true,
      entries: [],
      errors: [{ label: "Claude", message: "Service unavailable" }],
    };
    const provider = {
      id: "anthropic",
      cachePolicy: { kind: "account-neutral" },
      fetch: vi.fn().mockResolvedValueOnce(success).mockResolvedValue(failure),
    } as any;
    const ctx = { client: {}, config: { cursorPlan: "none" } } as any;
    const params = { provider, ctx, ttlMs: 60_000 };
    const path = quotaState.getQuotaProviderStateCacheFilePath(
      provider.id,
      quotaState.buildQuotaProviderStateCacheKey(provider.id, ctx),
    );

    await quotaState.fetchQuotaProviderResult(params);
    await expect(access(path)).resolves.toBeUndefined();
    now.mockReturnValue(startedAt + 60_000);
    expect(await quotaState.fetchQuotaProviderResult(params)).toEqual(failure);
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await quotaState.fetchQuotaProviderResult(params)).toEqual(failure);
    expect(provider.fetch).toHaveBeenCalledTimes(2);
  });
});
