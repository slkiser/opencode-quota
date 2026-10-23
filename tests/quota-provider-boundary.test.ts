import { describe, expect, it } from "vite-plus/test";

import { getProviders } from "../src/providers/registry.js";
import { SHIPPED_PRICE_LIST } from "./helpers/shipped-price-list.js";

describe("quota provider boundary", () => {
  it("models.dev pricing providers include ids beyond quota provider support", () => {
    const quotaSet = new Set(getProviders().map((p) => p.id));
    const modelsDevProviders = Object.keys(SHIPPED_PRICE_LIST.providers);
    const notInQuotaRegistry = modelsDevProviders.filter((id) => !quotaSet.has(id));
    expect(notInQuotaRegistry.length).toBeGreaterThan(0);
  });
});
