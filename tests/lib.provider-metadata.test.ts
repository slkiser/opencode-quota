import { describe, expect, it } from "vite-plus/test";

import {
  getCanonicalQuotaProviderId,
  getQuotaProviderDisplayLabel,
  getQuotaProviderIdsForRuntimeId,
  getQuotaProviderRuntimeIds,
  QUOTA_PROVIDER_CATALOG,
} from "../src/lib/provider-metadata.js";
import { QUOTA_PROVIDER_REGISTRATION_SOURCE } from "../src/lib/provider-registration.js";

const COPILOT = ["copilot", "github-copilot", "copilot-chat", "github-copilot-chat"];
const GEMINI_CLI = ["google-gemini-cli", "gemini-cli", "gemini", "opencode-gemini-auth", "google"];
const ZHIPU = ["zhipu", "glm-coding-plan", "zhipu-coding-plan", "zhipuai-coding-plan"];
const MINIMAX_CN = [
  "minimax-china-coding-plan",
  "minimax-cn-coding-plan",
  "minimax-cn",
  "minimax-china",
];
const KIMI_CN = ["kimi-code-plan-cn", "kimi-for-coding", "kimi", "kimi-code"];
const XIAOMI = ["xiaomi", "xiaomi-token-plan-cn", "xiaomi-token-plan-ams", "xiaomi-token-plan-sgp"];

describe("provider-metadata", () => {
  it("lists every registered provider once, in order", () => {
    const ids = QUOTA_PROVIDER_REGISTRATION_SOURCE.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.keys(QUOTA_PROVIDER_CATALOG)).toEqual(ids);
    expect(getCanonicalQuotaProviderId("alibaba")).toBe("alibaba-coding-plan");
    expect(getCanonicalQuotaProviderId("not-a-provider")).toBeUndefined();
  });

  // Synonyms name the provider; runtime ids are only the OpenCode ids that count as it.
  it.each([
    ["  OpenAI  ", "openai", "OpenAI", ["openai", "chatgpt", "codex"]],
    ["claude", "anthropic", "Anthropic", ["anthropic", "claude-code"]],
    ["claude-code", "anthropic", "Anthropic", ["anthropic", "claude-code"]],
    ["github-copilot", "copilot", "Copilot", COPILOT],
    ["open-cursor", "cursor", "Cursor", ["cursor", "cursor-acp"]],
    ["gemini-cli", "google-gemini-cli", "Gemini CLI", GEMINI_CLI],
    [
      "alibaba-token-plan",
      "alibaba-token-plan",
      "Alibaba Token Plan",
      ["alibaba-token-plan", "alibaba-token-plan-cn"],
    ],
    ["glm-coding-plan", "zhipu", "Zhipu", ZHIPU],
    ["minimax-cn-coding-plan", "minimax-china-coding-plan", "MiniMax Token Plan (CN)", MINIMAX_CN],
    ["kimi-code-plan-global", "kimi-code-plan-global", "Kimi Code", ["kimi-code-plan-global"]],
    ["kimi", "kimi-code-plan-cn", "Kimi Code (CN)", KIMI_CN],
    ["deep-seek", "deepseek", "DeepSeek", ["deepseek"]],
    ["opencode-zen", "opencode", "OpenCode Zen", ["opencode", "opencode-zen"]],
    ["xiaomi-token-plan-ams", "xiaomi", "Xiaomi MiMo", XIAOMI],
    ["quota-providers", "quota-providers", "Custom providers", []],
    ["google-antigravity", undefined, "google-antigravity", []],
    ["mimo", undefined, "mimo", []],
    ["grok", undefined, "grok", []],
  ])("knows %j as %s (%s)", (input, id, label, runtimeIds) => {
    expect(getCanonicalQuotaProviderId(input)).toBe(id);
    expect(getQuotaProviderDisplayLabel(input)).toBe(label);
    expect(getQuotaProviderRuntimeIds(input)).toEqual(runtimeIds);
  });

  it.each([
    ["alibaba-token-plan-cn", ["alibaba-token-plan"]],
    ["kimi", ["kimi-code-plan-cn"]],
    [" KIMI-CODE-PLAN-GLOBAL ", ["kimi-code-plan-global"]],
    ["google", ["google-gemini-cli"]],
    ["claude", []],
    ["claude-code", ["anthropic"]],
  ])("finds the provider owning the runtime id %j", (runtimeId, ids) => {
    expect(getQuotaProviderIdsForRuntimeId(runtimeId)).toEqual(ids);
  });

  // `runtimeIds` only cover the OpenCode side; `providers.off` and the saved `names`/`rowOrder`
  // keys go through `normalizeQuotaProviderId`, which reads synonyms and never runtime ids. So the
  // older spelling needs both to keep a configured user working.
  it("names the provider for the older spelling as a synonym, not only as a runtime id", () => {
    expect(getCanonicalQuotaProviderId("alibaba-token-plan-cn")).toBe("alibaba-token-plan");
    expect(getCanonicalQuotaProviderId("alibaba-token-plan")).toBe("alibaba-token-plan");
  });
});
