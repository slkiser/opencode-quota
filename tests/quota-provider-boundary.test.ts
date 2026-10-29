import { describe, expect, it } from "vite-plus/test";

import { listProviders as listModelsDevProviders } from "../src/lib/modelsdev-pricing.js";
import { QUOTA_PROVIDER_CATALOG, QUOTA_PROVIDER_SHAPES } from "../src/lib/provider-metadata.js";
import { QUOTA_PROVIDER_REGISTRATION_SOURCE } from "../src/lib/provider-registration.js";
import { getProviders } from "../src/providers/registry.js";
import { PROVIDER_ACCOUNTING_LEDGER } from "./helpers/provider-assertions.js";

describe("quota provider boundary", () => {
  it("keeps registration, metadata, runtime, and accounting boundaries complete", () => {
    const registrationIds = QUOTA_PROVIDER_REGISTRATION_SOURCE.map(({ id }) => id);
    const quotaProviders = getProviders().map((p) => p.id);
    expect(Object.keys(QUOTA_PROVIDER_CATALOG)).toEqual(registrationIds);
    expect(QUOTA_PROVIDER_SHAPES.map((shape) => shape.id)).toEqual(registrationIds);
    expect(quotaProviders).toEqual(registrationIds);
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
