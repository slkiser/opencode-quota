import { describe, expect, it } from "vitest";

import {
  getQuotaProviderDisplayLabel,
  normalizeQuotaProviderId,
} from "../src/lib/provider-metadata.js";

describe("provider-metadata", () => {
  it("normalizes provider synonyms to canonical ids", () => {
    expect(normalizeQuotaProviderId("claude")).toBe("anthropic");
    expect(normalizeQuotaProviderId("claude-code")).toBe("anthropic");
    expect(normalizeQuotaProviderId("github-copilot")).toBe("copilot");
    expect(normalizeQuotaProviderId("copilot-chat")).toBe("copilot");
    expect(normalizeQuotaProviderId("github-copilot-chat")).toBe("copilot");
    expect(normalizeQuotaProviderId("cursor-acp")).toBe("cursor");
    expect(normalizeQuotaProviderId("open-cursor")).toBe("cursor");
    expect(normalizeQuotaProviderId("@rama_nigg/open-cursor")).toBe("cursor");
    expect(normalizeQuotaProviderId("qwen")).toBe("qwen-code");
    expect(normalizeQuotaProviderId("alibaba")).toBe("alibaba-coding-plan");
    expect(normalizeQuotaProviderId("nano-gpt")).toBe("nanogpt");
  });

  it("returns display labels for known providers", () => {
    expect(getQuotaProviderDisplayLabel("anthropic")).toBe("Anthropic");
    expect(getQuotaProviderDisplayLabel("google-antigravity")).toBe("Google");
    expect(getQuotaProviderDisplayLabel("cursor")).toBe("Cursor");
    expect(getQuotaProviderDisplayLabel("alibaba-coding-plan")).toBe("Alibaba Coding Plan");
    expect(getQuotaProviderDisplayLabel("zai")).toBe("Z.ai");
    expect(getQuotaProviderDisplayLabel("nanogpt")).toBe("NanoGPT");
    expect(getQuotaProviderDisplayLabel("something-else")).toBe("something-else");
  });
});
