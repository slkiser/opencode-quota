import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_PRICING_SNAPSHOT_MAX_AGE_MS,
  getPricingSnapshotHealth,
  getPricingSnapshotMeta,
} from "../src/lib/modelsdev-pricing.js";

describe("pricing snapshot health", () => {
  it("marks snapshot as fresh before the max-age boundary", () => {
    const generatedAt = getPricingSnapshotMeta().generatedAt;
    const health = getPricingSnapshotHealth({
      nowMs: generatedAt + DEFAULT_PRICING_SNAPSHOT_MAX_AGE_MS - 1,
      maxAgeMs: DEFAULT_PRICING_SNAPSHOT_MAX_AGE_MS,
    });

    expect(health.stale).toBe(false);
    expect(health.ageMs).toBe(DEFAULT_PRICING_SNAPSHOT_MAX_AGE_MS - 1);
  });

  it("marks snapshot as stale after the max-age boundary", () => {
    const generatedAt = getPricingSnapshotMeta().generatedAt;
    const health = getPricingSnapshotHealth({
      nowMs: generatedAt + DEFAULT_PRICING_SNAPSHOT_MAX_AGE_MS + 1,
      maxAgeMs: DEFAULT_PRICING_SNAPSHOT_MAX_AGE_MS,
    });

    expect(health.stale).toBe(true);
    expect(health.ageMs).toBe(DEFAULT_PRICING_SNAPSHOT_MAX_AGE_MS + 1);
  });
});
