import { rm, readdir, readFile } from "node:fs/promises";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const root = "/tmp/opencode-quota-account-cache-tests";
vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirs: () => ({
    dataDir: `${root}/data`,
    configDir: `${root}/config`,
    cacheDir: `${root}/cache`,
    stateDir: `${root}/state`,
  }),
}));
const ctx = {
  config: { googleModels: [], alibabaCodingPlanTier: "lite", cursorPlan: "none" },
  client: {},
} as any;
const result = (account: string) => ({
  attempted: true,
  entries: [{ name: account, percentRemaining: 42 }],
  errors: [],
});
const identity = (account: string) => `rai1_${account.repeat(43)}`;
describe("account-scoped shared cache", () => {
  it("binds fresh and forced observations to the frozen principal and ignores display identity claims", async () => {
    const { openAIAccounting } = await import("../src/providers/accounting-adapters.js");
    const state = await import("../src/lib/quota-state.js");
    let selected = "a";
    const provider = {
      id: "fixture",
      fetch: vi.fn(() => {
        throw new Error("must use prepared snapshot");
      }),
      cachePolicy: {
        kind: "resolved-auth",
        prepare: async () => {
          const account = selected;
          selected = "b"; // simulate login switch after selection
          return {
            identity: identity(account),
            accountIdentity: { kind: "opaque", digest: account.repeat(64) },
            fetch: async () => ({
              ...result("label"),
              accounting: openAIAccounting({
                success: true,
                label: "OpenAI",
                windows: { weekly: { percentRemaining: 42 } },
              }),
            }),
          };
        },
      },
    } as any;
    const first = await state.fetchQuotaProviderResult({ provider, ctx, ttlMs: 60000 });
    expect(first.accountIdentity).toEqual({ kind: "opaque", digest: "a".repeat(64) });
    expect(first.accounting!.rows[0].account).toEqual(first.accountIdentity);
    const forced = await state.fetchQuotaProviderResult({
      provider,
      ctx,
      ttlMs: 60000,
      bypassCache: true,
    });
    expect(forced.accountIdentity).toEqual({ kind: "opaque", digest: "b".repeat(64) });
    expect(provider.fetch).not.toHaveBeenCalled();
    const unknown = await state.fetchQuotaProviderResult({
      provider: {
        id: "unknown",
        fetch: async () => ({
          ...result("label"),
          accountIdentity: { kind: "opaque", digest: "c".repeat(64) },
        }),
      } as any,
      ctx,
      ttlMs: 0,
    });
    expect(unknown.accountIdentity).toBeUndefined();
  });
  beforeEach(async () => {
    vi.resetModules();
    await rm(root, { recursive: true, force: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  it("separates account switches in memory, disk, and cached-only reads", async () => {
    let account = "A";
    const fetch = vi.fn(async (selected: string) => result(selected));
    const provider = {
      id: "fixture",
      fetch: () => fetch(account),
      cachePolicy: {
        kind: "resolved-auth",
        prepare: async () => {
          const selected = account;
          return { identity: identity(selected), fetch: () => fetch(selected) };
        },
      },
    } as any;
    let state = await import("../src/lib/quota-state.js");
    const params = { provider, ctx, ttlMs: 60000 };
    expect(await state.fetchQuotaProviderResult(params)).toEqual(
      expect.objectContaining(result("A")),
    );
    account = "B";
    expect(await state.readCachedProviderResult(params)).toEqual({ hit: false });
    expect(await state.fetchQuotaProviderResult(params)).toEqual(
      expect.objectContaining(result("B")),
    );
    vi.resetModules();
    state = await import("../src/lib/quota-state.js");
    account = "A";
    expect(await state.fetchQuotaProviderResult(params)).toEqual(
      expect.objectContaining(result("A")),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    const files = await readdir(`${root}/cache/quota-provider-state`);
    expect(files).toHaveLength(2);
    for (const file of files) {
      const text = await readFile(`${root}/cache/quota-provider-state/${file}`, "utf8");
      expect(text).not.toContain("rai1_");
      expect(JSON.parse(text).key).toMatch(/^[a-f0-9]{64}$/);
    }
  });
  it("does not reuse unidentified providers' snapshots", async () => {
    const state = await import("../src/lib/quota-state.js");
    const provider = { id: "fixture", fetch: vi.fn().mockResolvedValue(result("A")) } as any;
    const params = { provider, ctx, ttlMs: 60000 };
    await state.fetchQuotaProviderResult(params);
    await state.fetchQuotaProviderResult(params);
    expect(provider.fetch).toHaveBeenCalledTimes(2);
    expect(await state.readCachedProviderResult(params)).toEqual({ hit: false });
  });
  it("isolates simultaneous account requests and coalesces simultaneous same-account requests", async () => {
    let account = "A";
    const fetch = vi.fn(async (selected: string) => result(selected));
    const provider = {
      id: "fixture",
      fetch: () => fetch(account),
      cachePolicy: {
        kind: "resolved-auth",
        prepare: async () => {
          const selected = account;
          return { identity: identity(selected), fetch: () => fetch(selected) };
        },
      },
    } as any;
    const state = await import("../src/lib/quota-state.js");
    const params = { provider, ctx, ttlMs: 60000 };
    const a = state.fetchQuotaProviderResult(params);
    account = "B";
    const b = state.fetchQuotaProviderResult(params);
    expect(await a).toEqual(expect.objectContaining(result("A")));
    expect(await b).toEqual(expect.objectContaining(result("B")));
    state.__resetQuotaStateForTests();
    await rm(`${root}/cache`, { recursive: true, force: true });
    fetch.mockClear();
    await Promise.all([
      state.fetchQuotaProviderResult(params),
      state.fetchQuotaProviderResult(params),
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("fails closed when identity resolution is unavailable or malformed", async () => {
    const state = await import("../src/lib/quota-state.js");
    for (const scope of [null, { identity: "raw-credential", fetch: vi.fn() }]) {
      const provider = {
        id: "fixture",
        fetch: vi.fn().mockResolvedValue(result("live")),
        cachePolicy: { kind: "resolved-auth", prepare: async () => scope },
      } as any;
      const params = { provider, ctx, ttlMs: 60000 };
      await state.fetchQuotaProviderResult(params);
      await state.fetchQuotaProviderResult(params);
      expect(provider.fetch).toHaveBeenCalledTimes(2);
      expect(await state.readCachedProviderResult(params)).toEqual({ hit: false });
    }
  });

  it("bypasses pending cached work on an explicit fresh request", async () => {
    let complete!: (value: ReturnType<typeof result>) => void;
    let started!: () => void;
    const beginning = new Promise<void>((resolve) => {
      started = resolve;
    });
    let prepared = 0;
    const provider = {
      id: "fixture",
      fetch: vi.fn().mockResolvedValue(result("fresh")),
      cachePolicy: {
        kind: "resolved-auth",
        prepare: async () => {
          const first = prepared++ === 0;
          return {
            identity: identity("A"),
            fetch: () => {
              if (!first) return Promise.resolve(result("fresh"));
              started();
              return new Promise<ReturnType<typeof result>>((resolve) => {
                complete = resolve;
              });
            },
          };
        },
      },
    } as any;
    const state = await import("../src/lib/quota-state.js");
    const params = { provider, ctx, ttlMs: 60000 };
    const pending = state.fetchQuotaProviderResult(params);
    await beginning;
    expect(await state.fetchQuotaProviderResult({ ...params, bypassCache: true })).toEqual(
      expect.objectContaining(result("fresh")),
    );
    complete(result("cached-request"));
    expect(await pending).toEqual(expect.objectContaining(result("cached-request")));
    expect(provider.fetch).not.toHaveBeenCalled();
  });
});
