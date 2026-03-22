import { describe, expect, it } from "vitest";

import { listProviders as listModelsDevProviders } from "../src/lib/modelsdev-pricing.js";
import { getProviders } from "../src/providers/registry.js";

describe("quota provider boundary", () => {
  it("keeps quota providers limited to the curated registry", () => {
    const quotaProviders = getProviders().map((p) => p.id);
    expect(quotaProviders).toEqual([
      "copilot",
      "openai",
      "cursor",
      "qwen-code",
      "alibaba-coding-plan",
      "firmware",
      "chutes",
      "google-antigravity",
      "zai",
      "nanogpt",
    ]);
  });

  it("models.dev pricing providers include ids beyond quota provider support", () => {
    const quotaSet = new Set(getProviders().map((p) => p.id));
    const modelsDevProviders = listModelsDevProviders();
    const notInQuotaRegistry = modelsDevProviders.filter((id) => !quotaSet.has(id));
    expect(notInQuotaRegistry.length).toBeGreaterThan(0);
  });
});
