import { describe, expect, it } from "vitest";

import { listProviders as listModelsDevProviders } from "../src/lib/modelsdev-pricing.js";
import { QUOTA_PROVIDER_SHAPES } from "../src/lib/provider-metadata.js";
import { getProviders } from "../src/providers/registry.js";
import { PROVIDER_ACCOUNTING_LEDGER } from "./helpers/provider-assertions.js";

describe("quota provider boundary", () => {
  it("keeps the runtime registry aligned with the canonical provider catalog", () => {
    const quotaProviders = getProviders().map((p) => p.id);
    expect(quotaProviders).toEqual(QUOTA_PROVIDER_SHAPES.map((shape) => shape.id));
    expect(quotaProviders).toContain("synthetic");
    expect(quotaProviders).toContain("xiaomi");
    expect(Object.keys(PROVIDER_ACCOUNTING_LEDGER)).toEqual(expect.arrayContaining(quotaProviders));
    expect(Object.keys(PROVIDER_ACCOUNTING_LEDGER)).toHaveLength(quotaProviders.length);
  });

  it("models.dev pricing providers include ids beyond quota provider support", () => {
    const quotaSet = new Set(getProviders().map((p) => p.id));
    const modelsDevProviders = listModelsDevProviders();
    const notInQuotaRegistry = modelsDevProviders.filter((id) => !quotaSet.has(id));
    expect(notInQuotaRegistry.length).toBeGreaterThan(0);
  });
});
