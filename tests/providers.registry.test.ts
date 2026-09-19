import { describe, expect, it } from "vitest";

import { QUOTA_PROVIDER_RUNTIME_IDS } from "../src/lib/provider-metadata.js";
import { QUOTA_PROVIDER_REGISTRATION_SOURCE } from "../src/lib/provider-registration.js";
import { getProviders } from "../src/providers/registry.js";

const EXPECTED_PROVIDER_ORDER = [
  "anthropic",
  "copilot",
  "openai",
  "openrouter",
  "kilo",
  "cursor",
  "qwen-code",
  "alibaba-coding-plan",
  "synthetic",
  "chutes",
  "google-antigravity",
  "google-gemini-cli",
  "google-agy",
  "zai",
  "zhipu",
  "nanogpt",
  "minimax-coding-plan",
  "minimax-china-coding-plan",
  "kimi-code-plan-global",
  "kimi-code-plan-cn",
  "deepseek",
  "xai",
  "xiaomi",
  "opencode-go",
  "opencode",
  "ollama-cloud",
  "quota-providers",
] as const;

describe("provider registry", () => {
  it("keeps every catalog provider exactly once in observable display order", () => {
    const first = getProviders();
    const second = getProviders();
    const ids = first.map((provider) => provider.id);

    expect(QUOTA_PROVIDER_REGISTRATION_SOURCE.map(({ id }) => id)).toEqual(EXPECTED_PROVIDER_ORDER);
    expect(ids).toEqual(EXPECTED_PROVIDER_ORDER);
    expect(second.map((provider) => provider.id)).toEqual(EXPECTED_PROVIDER_ORDER);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids)).toEqual(new Set(Object.keys(QUOTA_PROVIDER_RUNTIME_IDS)));
    expect(second).not.toBe(first);
    expect(second).toHaveLength(first.length);
    first.forEach((provider, index) => {
      expect(second[index]).toBe(provider);
    });
  });
});
