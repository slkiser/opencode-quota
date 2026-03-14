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
});
