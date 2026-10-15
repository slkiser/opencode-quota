import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuotaRefreshController } from "../src/gui/quota-refresh-controller.js";
import type { QuotaFetchResult } from "../src/gui/ipc/quota.js";
import { normalizeGuiRefreshInterval } from "../src/lib/gui-config.js";
import { projectAccountingDetails } from "../src/lib/accounting-display.js";
import { openAIAccounting } from "../src/providers/accounting-adapters.js";

const result = (remaining = 75): QuotaFetchResult => ({
  entries: [{ name: "Fixture", percentRemaining: remaining }],
  errors: [],
  detectedProviderIds: ["openai"],
});
const failure: QuotaFetchResult = {
  entries: [],
  errors: [{ label: "OpenAI", message: "Offline" }],
  detectedProviderIds: ["openai"],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("desktop quota refresh controller", () => {
  it("retains and clears detail metadata together with its corresponding observation", async () => {
    const details = projectAccountingDetails("openai", {
      attempted: true,
      entries: [],
      errors: [],
      accounting: openAIAccounting({
        success: true,
        label: "Account A",
        windows: { weekly: { percentRemaining: 75 } },
      }),
    });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ...result(), accountingDetails: details })
      .mockResolvedValue(failure);
    const { controller } = create(fetch);
    await controller.start();
    await controller.refresh(true);
    expect(controller.getState().previousObservation).toBe(true);
    expect(controller.getState().accountingDetails).toEqual(details);
    controller.clearObservation();
    expect(controller.getState().accountingDetails).toBeUndefined();
  });
  const controllers: QuotaRefreshController[] = [];
  function create(fetch = vi.fn(async () => result()), intervalMs = 10_000, onChange = vi.fn()) {
    const controller = new QuotaRefreshController({ fetch, intervalMs, onChange });
    controllers.push(controller);
    return { controller, fetch, onChange };
  }
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
  });
  afterEach(() => {
    controllers.splice(0).forEach((controller) => controller.dispose());
  });

  it("fetches once at startup and schedules independent of a renderer, with state updates", async () => {
    const { controller, fetch, onChange } = create();
    const initial = controller.start();
    expect(controller.getState()).toMatchObject({ fetching: true, lastAttemptAt: 100_000 });
    await initial;
    expect(fetch).toHaveBeenCalledExactlyOnceWith(false);
    expect(controller.getState()).toMatchObject({
      fetching: false,
      stale: false,
      lastSuccessAt: 100_000,
      nextRefreshAt: 110_000,
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.every(([fresh]) => fresh === false)).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(6);
    expect(onChange.mock.calls.map(([snapshot]) => snapshot.revision)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("coalesces overlapping fresh requests and automatic requests into one fresh query", async () => {
    const slow = deferred<QuotaFetchResult>();
    const { controller, fetch } = create(vi.fn(() => slow.promise));
    const first = controller.refresh(true);
    expect(controller.refresh(true)).toBe(first);
    expect(controller.refresh(false)).toBe(first);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(true);
    slow.resolve(result());
    await first;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("queues one fresh query after an automatic query, without overlapping or returning cached data to manual callers", async () => {
    const slow = deferred<QuotaFetchResult>();
    const fetch = vi.fn().mockReturnValueOnce(slow.promise).mockResolvedValue(result(50));
    const { controller } = create(fetch);
    const automatic = controller.start();
    const manual = controller.refresh(true);
    expect(controller.refresh(true)).toBe(manual);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(false);
    slow.resolve(result());
    await automatic;
    expect((await manual).entries).toEqual(result(50).entries);
    expect(fetch.mock.calls).toEqual([[false], [true]]);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("retains labelled previous data on failure, backs off, and recovers on the regular interval", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(failure)
      .mockResolvedValueOnce(failure)
      .mockResolvedValue(result(40));
    const { controller } = create(fetch);
    await controller.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(controller.getState()).toMatchObject({
      entries: result().entries,
      errors: failure.errors,
      stale: true,
      previousObservation: true,
      lastSuccessAt: 100_000,
      lastObservationAt: 100_000,
      nextRefreshAt: 140_000,
    });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.getState().nextRefreshAt).toBe(200_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(controller.getState()).toMatchObject({
      entries: result(40).entries,
      stale: false,
      previousObservation: false,
      lastSuccessAt: 200_000,
      nextRefreshAt: 210_000,
    });
  });

  it("allows one coalesced manual retry during backoff and redacts thrown failures", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(result())
      .mockRejectedValue(new Error("private credential"));
    const { controller } = create(fetch);
    await controller.start();
    await controller.refresh(true);
    expect(controller.getState()).toMatchObject({
      errors: [{ label: "Quota", message: "Quota refresh failed" }],
      previousObservation: true,
    });
    expect(JSON.stringify(controller.getState())).not.toContain("private credential");
    const retry = controller.refresh(true);
    expect(controller.refresh(true)).toBe(retry);
    await retry;
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("explains empty provider disappearance and keeps partial new results separate from previous rows", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce({ entries: [], errors: [], detectedProviderIds: [] })
      .mockResolvedValueOnce({ ...result(25), errors: failure.errors });
    const { controller } = create(fetch);
    await controller.start();
    const empty = await controller.refresh();
    expect(empty).toMatchObject({
      stale: true,
      previousObservation: true,
      entries: result().entries,
    });
    expect(empty.errors[0].message).toContain("No providers available");
    const partial = await controller.refresh();
    expect(partial.entries).toEqual(result(25).entries);
    expect(partial.previousObservation).toBe(false);
    expect(partial.stale).toBe(true);
  });

  it("pauses during sleep and performs one cache-aware refresh on wake", async () => {
    const { controller, fetch } = create();
    await controller.start();
    controller.suspend();
    expect(controller.getState().nextRefreshAt).toBeNull();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    const wake = controller.resume();
    expect(controller.resume()).toBe(wake);
    await wake;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenLastCalledWith(false);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("does not schedule a pending completion while asleep; wake joins the existing query", async () => {
    const slow = deferred<QuotaFetchResult>();
    const { controller, fetch } = create(vi.fn(() => slow.promise));
    const initial = controller.start();
    controller.suspend();
    expect(controller.resume()).toBe(initial);
    controller.suspend();
    slow.resolve(result());
    await initial;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reschedules changed intervals and can disable automatic work without disabling manual refresh", async () => {
    const { controller, fetch } = create();
    await controller.start();
    controller.setInterval(20_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    controller.setInterval(0);
    await vi.advanceTimersByTimeAsync(300_000);
    controller.suspend();
    await controller.resume();
    expect(fetch).toHaveBeenCalledTimes(2);
    await controller.refresh(true);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disposes timers and suppresses queued refreshes and late events after quit", async () => {
    const slow = deferred<QuotaFetchResult>();
    const { controller, fetch, onChange } = create(vi.fn(() => slow.promise));
    const pending = controller.start();
    const queued = controller.refresh(true);
    await Promise.resolve();
    controller.dispose();
    const events = onChange.mock.calls.length;
    slow.resolve(result());
    await pending;
    await queued;
    await vi.advanceTimersByTimeAsync(300_000);
    await controller.refresh(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(events);
    expect(vi.getTimerCount()).toBe(0);
    expect(controller.getState().entries).toEqual([]);
  });

  it("isolates snapshots and tolerates a closed renderer; changed settings clear previous observations", async () => {
    const { controller, fetch } = create(
      vi.fn(async () => result()),
      10_000,
      vi.fn(() => {
        throw new Error("closed renderer");
      }),
    );
    await controller.start();
    controller.getState().entries.length = 0;
    expect(controller.getState().entries).toHaveLength(1);
    controller.clearObservation();
    fetch.mockResolvedValue(failure);
    const failed = await controller.refresh();
    expect(failed.entries).toEqual([]);
    expect(failed.previousObservation).toBe(false);
    expect(failed.lastSuccessAt).toBeNull();
    expect(vi.getTimerCount()).toBe(1);
  });

  it("bounds accepted intervals while rejecting invalid configuration", () => {
    expect(normalizeGuiRefreshInterval(0)).toBe(0);
    expect(normalizeGuiRefreshInterval(1)).toBe(10_000);
    expect(normalizeGuiRefreshInterval(1e20)).toBe(86_400_000);
    for (const invalid of [NaN, Infinity, -1, "10000", null, undefined]) {
      expect(normalizeGuiRefreshInterval(invalid)).toBe(300_000);
    }
  });
});
