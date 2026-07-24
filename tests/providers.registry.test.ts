import { describe, expect, it } from "vitest";

import { QUOTA_PROVIDER_RUNTIME_IDS } from "../src/lib/provider-metadata.js";
import { getProviders } from "../src/providers/registry.js";

const EXPECTED_PROVIDER_ORDER = [
  "anthropic",
  "copilot",
  "openai",
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
  "kimi-for-coding",
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
    const ids = getProviders().map((provider) => provider.id);

    expect(ids).toEqual(EXPECTED_PROVIDER_ORDER);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids)).toEqual(new Set(Object.keys(QUOTA_PROVIDER_RUNTIME_IDS)));
  });
});
