import { describe, expect, it } from "vitest";

import {
  getQuotaProviderDisplayLabel,
  normalizeQuotaProviderId,
} from "../src/lib/provider-metadata.js";

describe("provider-metadata", () => {
  it("normalizes provider synonyms to canonical ids", () => {
    expect(normalizeQuotaProviderId("github-copilot")).toBe("copilot");
    expect(normalizeQuotaProviderId("copilot-chat")).toBe("copilot");
    expect(normalizeQuotaProviderId("github-copilot-chat")).toBe("copilot");
    expect(normalizeQuotaProviderId("qwen")).toBe("qwen-code");
    expect(normalizeQuotaProviderId("alibaba")).toBe("alibaba-coding-plan");
  });

  it("returns display labels for known providers", () => {
    expect(getQuotaProviderDisplayLabel("google-antigravity")).toBe("Google");
    expect(getQuotaProviderDisplayLabel("alibaba-coding-plan")).toBe("Alibaba Coding Plan");
    expect(getQuotaProviderDisplayLabel("zai")).toBe("Z.ai");
    expect(getQuotaProviderDisplayLabel("something-else")).toBe("something-else");
  });
});
