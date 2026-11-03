import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  clearCache,
  getCacheEntryCount,
  getCachedToast,
  getOrFetch,
  getOrFetchWithCacheControl,
  shouldFetch,
  updateCache,
} from "../src/lib/cache.js";

describe("cache", () => {
  const primaryKey = "toast:primary";
  const secondaryKey = "toast:secondary";

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    clearCache();
  });

  afterEach(() => {
    clearCache();
  });

  it("returns cached toast within minIntervalMs", () => {
    updateCache(primaryKey, "hello");
    expect(getCachedToast(primaryKey, 60_000)).toBe("hello");

    vi.advanceTimersByTime(59_999);
    expect(getCachedToast(primaryKey, 60_000)).toBe("hello");
  });

  it("treats cached toast as stale after minIntervalMs", () => {
    updateCache(primaryKey, "hello");
    vi.advanceTimersByTime(60_000);
    expect(getCachedToast(primaryKey, 60_000)).toBeNull();
  });

  it("deduplicates concurrent fetches per key", async () => {
    const fetchFn = vi.fn(async () => {
      await vi.advanceTimersByTimeAsync(10);
      return "result";
    });

    const p1 = getOrFetch(primaryKey, fetchFn, 0);
    const p2 = getOrFetch(primaryKey, fetchFn, 0);

    await vi.runAllTimersAsync();

    await expect(p1).resolves.toBe("result");
    await expect(p2).resolves.toBe("result");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("shouldFetch honors minIntervalMs per key", () => {
    // shouldFetch is based on internal lastFetchTime; this asserts its basic behavior
    // when the cache layer calls into it.
    expect(shouldFetch(primaryKey, 60_000)).toBe(true);
  });

  it("does not cache when cache=false", async () => {
    const fetchFn = vi.fn(async () => ({ message: "err", cache: false }));

    const out1 = await getOrFetchWithCacheControl(primaryKey, fetchFn, 60_000);
    expect(out1).toBe("err");
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Second call should fetch again (not cached / not throttled)
    const out2 = await getOrFetchWithCacheControl(primaryKey, fetchFn, 60_000);
    expect(out2).toBe("err");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("keeps keyed caches isolated", async () => {
    const fetchFn = vi.fn();
    fetchFn.mockResolvedValueOnce({ message: "primary", cache: true });
    fetchFn.mockResolvedValueOnce({ message: "secondary", cache: true });

    await expect(getOrFetchWithCacheControl(primaryKey, fetchFn, 60_000)).resolves.toBe("primary");
    await expect(getOrFetchWithCacheControl(secondaryKey, fetchFn, 60_000)).resolves.toBe(
      "secondary",
    );

    expect(getCachedToast(primaryKey, 60_000)).toBe("primary");
    expect(getCachedToast(secondaryKey, 60_000)).toBe("secondary");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("clears only the requested key when given one", () => {
    updateCache(primaryKey, "primary");
    updateCache(secondaryKey, "secondary");

    clearCache(primaryKey);

    expect(getCachedToast(primaryKey, 60_000)).toBeNull();
    expect(getCachedToast(secondaryKey, 60_000)).toBe("secondary");
  });

  it("still falls back to an expired toast when its refresh fails", async () => {
    await getOrFetchWithCacheControl(primaryKey, async () => ({ message: "old" }), 1_000);
    vi.advanceTimersByTime(1_500);
    await expect(
      getOrFetchWithCacheControl(
        primaryKey,
        async () => {
          throw new Error("refresh failed");
        },
        1_000,
      ),
    ).rejects.toThrow("refresh failed");
    vi.advanceTimersByTime(10);

    const fetchFn = vi.fn(async () => ({ message: "new" }));
    await expect(getOrFetchWithCacheControl(primaryKey, fetchFn, 1_000)).resolves.toBe("old");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("keeps a recently used entry when the cap drops older ones", async () => {
    await getOrFetchWithCacheControl(primaryKey, async () => ({ message: "primary" }), 60_000);
    for (let i = 0; i < 99; i++) {
      await getOrFetchWithCacheControl(`toast:a-${i}`, async () => ({ message: `a${i}` }), 60_000);
    }
    await getOrFetchWithCacheControl(primaryKey, async () => ({ message: "again" }), 60_000);
    for (let i = 0; i < 50; i++) {
      await getOrFetchWithCacheControl(`toast:b-${i}`, async () => ({ message: `b${i}` }), 60_000);
    }

    expect(getCacheEntryCount()).toBe(100);
    expect(getCachedToast(primaryKey, 60_000)).toBe("primary");
    expect(getCachedToast("toast:a-0", 60_000)).toBeNull();
  });

  it("holds the cap after many fetches that ran at the same time finish", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetches = Array.from({ length: 150 }, (_, i) =>
      getOrFetchWithCacheControl(
        `toast:parallel-${i}`,
        async () => {
          await gate;
          return { message: `p${i}` };
        },
        60_000,
      ),
    );
    expect(getCacheEntryCount()).toBe(150);

    release?.();
    await Promise.all(fetches);

    expect(getCacheEntryCount()).toBe(100);
  });

  it("caps the number of entries and evicts the oldest first", async () => {
    for (let i = 0; i < 10_000; i++) {
      await getOrFetchWithCacheControl(
        `toast:session-${i}`,
        async () => ({ message: `m${i}`, cache: true }),
        60_000,
      );
    }

    expect(getCacheEntryCount()).toBeLessThanOrEqual(100);
    expect(getCachedToast("toast:session-9999", 60_000)).toBe("m9999");
    expect(getCachedToast("toast:session-0", 60_000)).toBeNull();
  });

  it("never evicts an entry that is still fetching", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inFlight = getOrFetchWithCacheControl(
      primaryKey,
      async () => {
        await gate;
        return { message: "slow", cache: true };
      },
      60_000,
    );

    for (let i = 0; i < 300; i++) {
      await getOrFetchWithCacheControl(
        `toast:other-${i}`,
        async () => ({ message: `m${i}`, cache: true }),
        60_000,
      );
    }

    release?.();
    await expect(inFlight).resolves.toBe("slow");
    expect(getCachedToast(primaryKey, 60_000)).toBe("slow");
  });
});
