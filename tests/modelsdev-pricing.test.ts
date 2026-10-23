import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { SHIPPED_PRICE_LIST as SHIPPED } from "./helpers/shipped-price-list.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const SHIPPED_AT = SHIPPED._meta.generatedAt;
/** Four days after the shipped list was made: stale after 3 days, fresh with 7. */
const NOW = SHIPPED_AT + 4 * DAY_MS;
const SHIPPED_MINI = SHIPPED.providers.openai["gpt-4o-mini"];
/** A model the fake models.dev reply leaves out, as models.dev does with retired ones. */
const SHIPPED_GPT_4O = SHIPPED.providers.openai["gpt-4o"];

type Settings = { source: "auto" | "bundled" | "runtime"; autoRefreshDays: number };
const STALE: Settings = { source: "auto", autoRefreshDays: 3 };

/** A downloaded list made at `generatedAt`: openai/gpt-4o-mini at `input`, plus `models`. */
function downloadedList(generatedAt: number, input: number, models: object = {}) {
  return {
    _meta: { source: "test", generatedAt, providers: ["openai"], units: "USD per 1M tokens" },
    providers: { openai: { "gpt-4o-mini": { input, output: input * 4 }, ...models } },
  };
}

/** A models.dev reply listing only openai/gpt-4o-mini. */
function modelsDevReply(cost: Record<string, number>, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify({ openai: { models: { "gpt-4o-mini": { cost } } } }), {
    headers,
  });
}

/** A models.dev that answers only when told; `called` resolves with the request's signal. */
function pendingFetch() {
  let started!: (signal: AbortSignal | undefined) => void;
  let reply!: (response: Response) => void;
  const called = new Promise<AbortSignal | undefined>((resolve) => {
    started = resolve;
  });
  const fetch = (_url: string | URL | Request, init?: RequestInit) => {
    started(init?.signal ?? undefined);
    return new Promise<Response>((resolve) => {
      reply = resolve;
    });
  };
  return { fetch, called, answer: (response: Response) => reply(response) };
}

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

/**
 * A new process: a fresh price list module following `settings`, with OpenCode's cache folder
 * in `root` (a new temp folder by default) and models.dev answering through `fetch` (down by
 * default). The clock stands still at `nowMs`, so a check waits for its whole download.
 */
async function start(settings: Settings, options: { root?: string; nowMs?: number } = {}) {
  const root = options.root ?? (await mkdtemp(join(tmpdir(), "opencode-quota-pricing-")));
  if (!options.root) tempRoots.push(root);
  vi.stubEnv("XDG_CACHE_HOME", root);
  vi.useRealTimers();
  vi.useFakeTimers({ now: options.nowMs ?? NOW, toFake: ["Date", "setTimeout", "clearTimeout"] });
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    throw new Error("network down");
  });
  vi.stubGlobal("fetch", fetch);
  vi.resetModules();
  const pricing = await import("../src/lib/modelsdev-pricing.js");
  pricing.usePricingSettings(() => settings);
  const dir = join(root, "opencode", "opencode-quota");
  const paths = {
    snapshot: join(dir, "modelsdev-pricing.runtime.min.json"),
    refreshState: join(dir, "modelsdev-pricing.refresh-state.json"),
  };
  const write = async (path: string, value: unknown) => {
    await mkdir(dir, { recursive: true });
    await writeFile(path, JSON.stringify(value), "utf-8");
  };
  return {
    root,
    pricing,
    fetch,
    paths,
    writeDownloaded: (value: unknown) => write(paths.snapshot, value),
    writeRefreshState: (value: unknown) => write(paths.refreshState, value),
    readDownloaded: async () => JSON.parse(await readFile(paths.snapshot, "utf-8")),
    refreshState: async () => (await pricing.describePriceList()).refreshState,
  };
}

describe("the price list lookups use", () => {
  it.each([
    {
      name: "auto: a download newer than the shipped list",
      source: "auto",
      at: NOW,
      uses: "runtime",
    },
    {
      name: "auto: the shipped list over an older download",
      source: "auto",
      at: SHIPPED_AT - DAY_MS,
      uses: "bundled",
    },
    {
      name: "runtime: an older download",
      source: "runtime",
      at: SHIPPED_AT - DAY_MS,
      uses: "runtime",
    },
    {
      name: "runtime: the shipped list without a download",
      source: "runtime",
      at: null,
      uses: "bundled",
    },
    {
      name: "bundled: the shipped list over a newer download",
      source: "bundled",
      at: NOW,
      uses: "bundled",
    },
  ] as const)("$name", async ({ source, at, uses }) => {
    const { pricing, writeDownloaded } = await start({ source, autoRefreshDays: 7 });
    if (at !== null) await writeDownloaded(downloadedList(at, 9.99));

    expect(pricing.activePriceList()).toMatchObject({ selection: source, source: uses });
    const input = uses === "runtime" ? 9.99 : SHIPPED_MINI.input;
    expect(pricing.lookupCost("openai", "gpt-4o-mini")?.input).toBe(input);
    // A download saved before retired models were kept gets them from the shipped list.
    expect(pricing.lookupCost("openai", "gpt-4o")).toEqual(SHIPPED_GPT_4O);
  });

  it("follows a settings change at the next lookup, with nothing to call in between", async () => {
    const settings: Settings = { source: "bundled", autoRefreshDays: 7 };
    const { pricing, writeDownloaded } = await start(settings);
    await writeDownloaded(downloadedList(NOW, 9.99));
    expect(pricing.lookupCost("openai", "gpt-4o-mini")?.input).toBe(SHIPPED_MINI.input);

    settings.source = "runtime";

    expect(pricing.lookupCost("openai", "gpt-4o-mini")?.input).toBe(9.99);
    expect(pricing.activePriceList().selection).toBe("runtime");
  });
});

describe("refreshPricesIfDue", () => {
  it.each([
    { days: 7, maxAgeDays: 7, due: false },
    { days: 1, maxAgeDays: 1, due: true },
    { days: 0, maxAgeDays: 7, due: false }, // not a positive number: the 7-day default
  ])(
    "downloads a 4-day-old list after $days configured days: $due",
    async ({ days, maxAgeDays, due }) => {
      const { pricing, fetch, paths } = await start({ source: "auto", autoRefreshDays: days });
      const before = await pricing.describePriceList();

      await pricing.refreshPricesIfDue();

      expect(before).toMatchObject({
        health: { ageMs: 4 * DAY_MS, maxAgeMs: maxAgeDays * DAY_MS, stale: due },
        paths,
        refreshState: null,
      });
      expect(fetch).toHaveBeenCalledTimes(due ? 1 : 0);
      // No timer is left to keep a CLI run going once the check is over.
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("never downloads with the settings on the shipped list", async () => {
    const { pricing, fetch } = await start({ source: "bundled", autoRefreshDays: 1 });

    await pricing.refreshPricesIfDue();

    expect(fetch).not.toHaveBeenCalled();
    expect(await pricing.describePriceList()).toMatchObject({
      source: "bundled",
      health: { stale: true },
      refreshState: null,
    });
  });

  it("saves new prices of the known kinds and keeps dropped models, the last download's price first", async () => {
    const { pricing, fetch, writeDownloaded, readDownloaded, refreshState } = await start(STALE);
    const lastPrice = { input: 5, output: 6 };
    await writeDownloaded(downloadedList(SHIPPED_AT - DAY_MS, 9.99, { "gpt-4o": lastPrice }));
    const cost = { input: 0.123, output: 0.456, cache_read: 0.01, reasoning: 999, x: 1 };
    fetch.mockResolvedValue(modelsDevReply(cost, { etag: "etag-1" }));

    await pricing.refreshPricesIfDue();

    const saved = await readDownloaded();
    expect(saved._meta.generatedAt).toBe(NOW);
    expect(saved.providers.openai["gpt-4o-mini"]).toEqual({
      input: 0.123,
      output: 0.456,
      cache_read: 0.01,
    });
    expect(saved.providers.openai["gpt-4o"]).toEqual(lastPrice);
    expect(saved.providers.openai["gpt-4.1"]).toEqual(SHIPPED.providers.openai["gpt-4.1"]);
    expect(pricing.activePriceList().source).toBe("runtime");
    expect(pricing.lookupCost("openai", "gpt-4o-mini")?.input).toBe(0.123);
    expect(await refreshState()).toMatchObject({
      lastResult: "success",
      lastSuccessAt: NOW,
      etag: "etag-1",
    });
  });

  it("asks with the saved etag and, on 304, dates the prices in use now", async () => {
    const { pricing, fetch, writeRefreshState, readDownloaded, refreshState } = await start(STALE);
    const lastAttemptAt = NOW - 7 * HOUR_MS;
    await writeRefreshState({
      version: 1,
      updatedAt: lastAttemptAt,
      lastAttemptAt,
      etag: "etag-0",
    });
    fetch.mockResolvedValue(new Response(null, { status: 304 }));

    await pricing.refreshPricesIfDue();

    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("if-none-match")).toBe("etag-0");
    const saved = await readDownloaded();
    expect(saved._meta.generatedAt).toBe(NOW);
    expect(saved.providers.openai["gpt-4o-mini"]).toEqual(SHIPPED_MINI);
    expect(pricing.activePriceList()).toMatchObject({
      source: "runtime",
      meta: { generatedAt: NOW },
    });
    expect(await refreshState()).toMatchObject({ lastResult: "not_modified", etag: "etag-0" });
  });

  it("keeps the list in use when a download fails, and no process tries again within 6 hours", async () => {
    const first = await start(STALE);

    await first.pricing.refreshPricesIfDue();

    expect(first.pricing.lookupCost("openai", "gpt-4o-mini")).toEqual(SHIPPED_MINI);
    expect(await first.refreshState()).toMatchObject({
      lastResult: "failed",
      lastFailureAt: NOW,
      lastError: "network down",
    });
    for (const [laterMs, tries] of [
      [6 * HOUR_MS - 1, 0],
      [6 * HOUR_MS, 1],
    ]) {
      const next = await start(STALE, { root: first.root, nowMs: NOW + laterMs });
      await next.pricing.refreshPricesIfDue();
      expect(next.fetch).toHaveBeenCalledTimes(tries);
    }
  });

  it("downloads once at a time, and once per process", async () => {
    const { pricing, fetch } = await start(STALE);
    const pending = pendingFetch();
    fetch.mockImplementation(pending.fetch);

    const downloads = [pricing.downloadPrices(), pricing.downloadPrices()];
    await pending.called;
    pending.answer(new Response("", { status: 503 }));
    await Promise.all(downloads);
    // Still stale and past the 6-hour wait, but this process has had its download.
    vi.setSystemTime(NOW + 7 * HOUR_MS);
    await pricing.refreshPricesIfDue();

    expect(fetch).toHaveBeenCalledOnce();
  });

  it("waits at most 0.75 s for a download, which gives up after 6 s and keeps the list", async () => {
    const { pricing, fetch, refreshState } = await start(STALE);
    const pending = pendingFetch();
    fetch.mockImplementation(pending.fetch);
    let waited = false;

    const check = pricing.refreshPricesIfDue().then(() => {
      waited = true;
    });
    const signal = await pending.called;
    await vi.advanceTimersByTimeAsync(749);
    expect(waited).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await check;

    expect(await refreshState()).toBeNull();
    await vi.advanceTimersByTimeAsync(6_000 - 750);
    await vi.waitFor(async () =>
      expect(await refreshState()).toMatchObject({
        lastResult: "failed",
        lastError: "Request timeout after 6s",
      }),
    );
    expect(signal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    expect(pricing.lookupCost("openai", "gpt-4o-mini")).toEqual(SHIPPED_MINI);
  });
});

describe("downloadPrices", () => {
  it.each([
    {
      name: "takes new prices whatever the list's age",
      source: "auto",
      reply: async () => modelsDevReply({ input: 0.222 }),
      answer: { ok: true, message: "Downloaded new prices from models.dev." },
      uses: 0.222,
    },
    {
      name: "saves new prices but keeps the shipped list the settings choose",
      source: "bundled",
      reply: async () => modelsDevReply({ input: 0.222 }),
      answer: {
        ok: true,
        message:
          "Downloaded new prices. Usage keeps the built-in prices: the pricing source setting is bundled.",
      },
      uses: SHIPPED_MINI.input,
    },
    {
      name: "says why a download failed",
      source: "auto",
      reply: async (): Promise<Response> => {
        throw new Error("network down");
      },
      answer: { ok: false, message: "Couldn't download new prices: network down." },
      uses: SHIPPED_MINI.input,
    },
  ] as const)("$name", async ({ source, reply, answer, uses }) => {
    const { pricing, fetch, readDownloaded } = await start({ source, autoRefreshDays: 7 });
    fetch.mockImplementation(reply);

    await expect(pricing.downloadPrices()).resolves.toEqual(answer);

    expect(pricing.lookupCost("openai", "gpt-4o-mini")?.input).toBe(uses);
    if (answer.ok) {
      expect((await readDownloaded()).providers.openai["gpt-4o-mini"].input).toBe(0.222);
    }
  });

  it("downloads after an automatic check that runs when asked, not taking its answer", async () => {
    const { pricing, fetch } = await start({ source: "auto", autoRefreshDays: 7 });
    fetch.mockResolvedValue(modelsDevReply({ input: 0.222 }));

    const check = pricing.refreshPricesIfDue();
    await expect(pricing.downloadPrices()).resolves.toEqual({
      ok: true,
      message: "Downloaded new prices from models.dev.",
    });
    await check;

    expect(fetch).toHaveBeenCalledOnce();
    expect(pricing.lookupCost("openai", "gpt-4o-mini")?.input).toBe(0.222);
  });
});
