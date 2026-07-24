import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTuiRefreshLifecycle } from "../src/lib/tui-refresh-lifecycle.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("TUI refresh lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("coalesces refreshes, rejects the stale completion, and applies only the follow-up", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const apply = vi.fn();
    const afterApply = vi.fn();
    const lifecycle = createTuiRefreshLifecycle({
      load,
      apply,
      afterApply,
      intervalMs: 60_000,
      eventRefreshDelaysMs: [150, 600],
      subscribe: () => [],
      onDispose: vi.fn(),
    });
    lifecycle.retain();

    lifecycle.reload();
    lifecycle.reload();
    expect(load).toHaveBeenCalledOnce();

    first.resolve("stale");
    await flushPromises();
    expect(load).toHaveBeenCalledTimes(2);
    expect(apply).not.toHaveBeenCalled();

    second.resolve("accepted");
    await flushPromises();
    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith("accepted");
    expect(afterApply).toHaveBeenCalledOnce();
    expect(afterApply).toHaveBeenCalledWith("accepted");
    lifecycle.release();
  });

  it("preserves the last applied value after rejection and permits a later refresh", async () => {
    const failed = deferred<string>();
    const load = vi
      .fn()
      .mockResolvedValueOnce("initial")
      .mockReturnValueOnce(failed.promise)
      .mockResolvedValueOnce("recovered");
    const apply = vi.fn();
    const lifecycle = createTuiRefreshLifecycle({
      load,
      apply,
      intervalMs: 60_000,
      eventRefreshDelaysMs: [150, 600],
      subscribe: () => [],
      onDispose: vi.fn(),
    });
    lifecycle.retain();
    await flushPromises();
    expect(apply).toHaveBeenLastCalledWith("initial");

    lifecycle.reload();
    failed.reject(new Error("unavailable"));
    await flushPromises();
    expect(apply).toHaveBeenCalledTimes(1);

    lifecycle.reload();
    await flushPromises();
    expect(apply).toHaveBeenLastCalledWith("recovered");
    lifecycle.release();
  });

  it("uses configured delays and disposes only after the final release", async () => {
    let scheduleRefresh!: () => void;
    const unsubscribe = vi.fn();
    const onDispose = vi.fn();
    const load = vi.fn().mockResolvedValue("value");
    const lifecycle = createTuiRefreshLifecycle({
      load,
      apply: vi.fn(),
      intervalMs: 60_000,
      eventRefreshDelaysMs: [150, 600],
      recoveryDelaysMs: [500, 1_500, 4_000],
      subscribe: (schedule) => {
        scheduleRefresh = schedule;
        return [unsubscribe];
      },
      onDispose,
    });
    lifecycle.retain();
    lifecycle.retain();
    await flushPromises();

    scheduleRefresh();
    await vi.advanceTimersByTimeAsync(150);
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(350);
    expect(load).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(100);
    expect(load).toHaveBeenCalledTimes(4);

    lifecycle.release();
    expect(unsubscribe).not.toHaveBeenCalled();
    lifecycle.release();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(onDispose).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(load).toHaveBeenCalledTimes(4);
  });

  it("ignores an in-flight completion after disposal", async () => {
    const pending = deferred<string>();
    const apply = vi.fn();
    const afterApply = vi.fn();
    const lifecycle = createTuiRefreshLifecycle({
      load: () => pending.promise,
      apply,
      afterApply,
      intervalMs: 60_000,
      eventRefreshDelaysMs: [150, 600],
      subscribe: () => [],
      onDispose: vi.fn(),
    });
    lifecycle.retain();
    lifecycle.release();

    pending.resolve("late");
    await flushPromises();
    expect(apply).not.toHaveBeenCalled();
    expect(afterApply).not.toHaveBeenCalled();
  });
});
