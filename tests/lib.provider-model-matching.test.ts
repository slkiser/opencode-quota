import { describe, expect, it } from "vite-plus/test";

import {
  modelIncludesAny,
  modelProviderIncludesAny,
  modelProviderMatchesRuntimeId,
  parseProviderModelRef,
  providerIdIncludesAny,
} from "../src/lib/provider-model-matching.js";

describe("provider model matching helpers", () => {
  it("parses and lowercases provider/model refs", () => {
    expect(parseProviderModelRef("Google-Gemini-CLI/GEMINI-2.5-Pro")).toEqual({
      lower: "google-gemini-cli/gemini-2.5-pro",
      providerId: "google-gemini-cli",
      modelId: "gemini-2.5-pro",
    });
  });

  it("handles model ids without a slash", () => {
    expect(parseProviderModelRef("OPENROUTER")).toEqual({
      lower: "openrouter",
      providerId: "openrouter",
      modelId: "",
    });
  });

  it("does not trim whitespace before parsing", () => {
    expect(parseProviderModelRef(" openrouter/gemini")).toEqual({
      lower: " openrouter/gemini",
      providerId: " openrouter",
      modelId: "gemini",
    });
    expect(modelProviderMatchesRuntimeId(" openrouter/gemini", "openrouter")).toBe(false);
  });

  it("matches canonical runtime ids for provider prefixes", () => {
    expect(modelProviderMatchesRuntimeId("opencode/gpt-5", "opencode")).toBe(true);
    expect(modelProviderMatchesRuntimeId("opencode-zen/gpt-5", "opencode")).toBe(true);
    expect(modelProviderMatchesRuntimeId("openai/gpt-4.1", "opencode")).toBe(false);
    expect(modelProviderMatchesRuntimeId("alibaba-token-plan/qwen3", "alibaba-token-plan")).toBe(
      true,
    );
    expect(modelProviderMatchesRuntimeId("alibaba/qwen3", "alibaba-token-plan")).toBe(false);
    expect(modelProviderMatchesRuntimeId("alibaba-token-plan/qwen3", "alibaba-coding-plan")).toBe(
      false,
    );
  });

  it("supports provider prefix fragment checks", () => {
    expect(providerIdIncludesAny("github-copilot", ["copilot", "google"])).toBe(true);
    expect(modelProviderIncludesAny("opencode-google-auth/gemini", ["google"])).toBe(true);
    expect(modelProviderIncludesAny("anthropic/claude-3", ["google"])).toBe(false);
  });

  it("supports full-model substring checks", () => {
    expect(modelIncludesAny("github-copilot/claude-sonnet", ["copilot", "gemini"])).toBe(true);
    expect(modelIncludesAny("openai/gpt-4.1", ["gemini", "claude"])).toBe(false);
  });
});
