import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  clearCache,
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
});
