import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTuiRefreshLifecycle } from "../src/lib/tui-refresh-lifecycle.js";

function createHarness() {
  let scheduleRefresh: () => void = () => {};
  const load = vi.fn(async () => "value");
  const unsubscribe = vi.fn();
  const onDispose = vi.fn();
  const lifecycle = createTuiRefreshLifecycle({
    load,
    apply: () => {},
    intervalMs: 60_000,
    eventRefreshDelaysMs: [150, 600],
    subscribe: (schedule) => {
      scheduleRefresh = schedule;
      return [unsubscribe];
    },
    onDispose,
  });
  lifecycle.retain();
  return { lifecycle, load, onDispose, emit: () => scheduleRefresh() };
}

describe("tui refresh lifecycle event bursts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces 30 events 20ms apart into one early load and one final load", async () => {
    const { load, emit } = createHarness();
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 30; i += 1) {
      emit();
      await vi.advanceTimersByTimeAsync(20);
    }
    // Last event happened at t=580; the final refresh is due 600ms after it.
    await vi.advanceTimersByTimeAsync(600);

    expect(load).toHaveBeenCalledTimes(1 + 2);
  });

  it("coalesces a 100-event burst into one early load and one final load", async () => {
    const { load, emit } = createHarness();
    await vi.advanceTimersByTimeAsync(0);
    load.mockClear();

    for (let i = 0; i < 100; i += 1) emit();
    expect(vi.getTimerCount()).toBeLessThanOrEqual(3);

    await vi.advanceTimersByTimeAsync(150);
    expect(load).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(450);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("always runs a final refresh 600ms after the last event", async () => {
    const { load, emit } = createHarness();
    await vi.advanceTimersByTimeAsync(0);
    load.mockClear();

    emit();
    await vi.advanceTimersByTimeAsync(400);
    emit();
    await vi.advanceTimersByTimeAsync(599);
    expect(load).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("starts a fresh burst after the final refresh", async () => {
    const { load, emit } = createHarness();
    await vi.advanceTimersByTimeAsync(0);
    load.mockClear();

    emit();
    await vi.advanceTimersByTimeAsync(600);
    expect(load).toHaveBeenCalledTimes(2);

    emit();
    await vi.advanceTimersByTimeAsync(600);
    expect(load).toHaveBeenCalledTimes(4);
  });

  it("clears pending event timers on dispose", async () => {
    const { lifecycle, load, emit, onDispose } = createHarness();
    await vi.advanceTimersByTimeAsync(0);
    load.mockClear();

    for (let i = 0; i < 5; i += 1) emit();
    lifecycle.release();

    expect(onDispose).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(load).not.toHaveBeenCalled();
  });
});
