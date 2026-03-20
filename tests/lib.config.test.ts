import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/lib/config.js";

describe("loadConfig", () => {
  it("defaults alibabaCodingPlanTier to lite and accepts explicit overrides", async () => {
    const defaults = await loadConfig({
      config: { get: async () => ({ data: { experimental: { quotaToast: {} } } }) },
    });
    expect(defaults.alibabaCodingPlanTier).toBe("lite");

    const explicit = await loadConfig({
      config: {
        get: async () => ({
          data: { experimental: { quotaToast: { alibabaCodingPlanTier: "pro" } } },
        }),
      },
    });
    expect(explicit.alibabaCodingPlanTier).toBe("pro");
  });

  it("normalizes cursor config fields without coercing invalid values", async () => {
    const defaults = await loadConfig({
      config: {
        get: async () => ({
          data: {
            experimental: {
              quotaToast: {
                cursorPlan: "bad-plan" as any,
                cursorIncludedApiUsd: -5,
                cursorBillingCycleStartDay: 31,
              },
            },
          },
        }),
      },
    });
    expect(defaults.cursorPlan).toBe("none");
    expect(defaults.cursorIncludedApiUsd).toBeUndefined();
    expect(defaults.cursorBillingCycleStartDay).toBeUndefined();

    const explicit = await loadConfig({
      config: {
        get: async () => ({
          data: {
            experimental: {
              quotaToast: {
                cursorPlan: "pro-plus",
                cursorIncludedApiUsd: 42,
                cursorBillingCycleStartDay: 7,
              },
            },
          },
        }),
      },
    });
    expect(explicit.cursorPlan).toBe("pro-plus");
    expect(explicit.cursorIncludedApiUsd).toBe(42);
    expect(explicit.cursorBillingCycleStartDay).toBe(7);
  });

  it("defaults pricingSnapshot config and accepts valid overrides", async () => {
    const defaults = await loadConfig({
      config: { get: async () => ({ data: { experimental: { quotaToast: {} } } }) },
    });
    expect(defaults.pricingSnapshot.source).toBe("auto");
    expect(defaults.pricingSnapshot.autoRefresh).toBe(5);

    const bundled = await loadConfig({
      config: {
        get: async () => ({
          data: {
            experimental: {
              quotaToast: {
                pricingSnapshot: { source: "bundled", autoRefresh: 7 },
              },
            },
          },
        }),
      },
    });
    expect(bundled.pricingSnapshot.source).toBe("bundled");
    expect(bundled.pricingSnapshot.autoRefresh).toBe(7);

    const runtime = await loadConfig({
      config: {
        get: async () => ({
          data: {
            experimental: {
              quotaToast: {
                pricingSnapshot: { source: "runtime", autoRefresh: 2 },
              },
            },
          },
        }),
      },
    });
    expect(runtime.pricingSnapshot.source).toBe("runtime");
    expect(runtime.pricingSnapshot.autoRefresh).toBe(2);

    const invalid = await loadConfig({
      config: {
        get: async () => ({
          data: {
            experimental: {
              quotaToast: {
                pricingSnapshot: { source: "remote" as any, autoRefresh: 0 },
              },
            },
          },
        }),
      },
    });
    expect(invalid.pricingSnapshot.source).toBe("auto");
    expect(invalid.pricingSnapshot.autoRefresh).toBe(5);
  });
});
