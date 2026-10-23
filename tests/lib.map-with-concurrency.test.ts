import { describe, expect, it, vi } from "vite-plus/test";

import { mapWithConcurrency } from "../src/lib/map-with-concurrency.js";

async function measureMaxActive(concurrency: number): Promise<number> {
  let active = 0;
  let maxActive = 0;
  await mapWithConcurrency([0, 1, 2, 3, 4, 5], concurrency, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
  });
  return maxActive;
}

describe("mapWithConcurrency", () => {
  it("returns an empty result without invoking the callback", async () => {
    const map = vi.fn(async () => 1);
    await expect(mapWithConcurrency([], 3, map)).resolves.toEqual([]);
    expect(map).not.toHaveBeenCalled();
  });

  it("limits active callbacks to the requested concurrency", async () => {
    await expect(measureMaxActive(3)).resolves.toBe(3);
  });

  it("preserves source ordering when callbacks finish out of order", async () => {
    const values = [3, 2, 1, 0];
    const results = await mapWithConcurrency(values, 4, async (value, index) => {
      await new Promise((resolve) => setTimeout(resolve, value * 2));
      return `${index}:${value}`;
    });
    expect(results).toEqual(["0:3", "1:2", "2:1", "3:0"]);
  });

  it("clamps non-positive and fractional concurrency to an integer", async () => {
    await expect(measureMaxActive(0)).resolves.toBe(1);
    await expect(measureMaxActive(-2)).resolves.toBe(1);
    await expect(measureMaxActive(2.9)).resolves.toBe(2);
  });

  it("rejects when a callback rejects", async () => {
    await expect(
      mapWithConcurrency([0, 1, 2], 2, async (value) => {
        if (value === 1) throw new Error("callback failed");
        return value;
      }),
    ).rejects.toThrow("callback failed");
  });
});
