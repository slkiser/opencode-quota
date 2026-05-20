import { describe, expect, it } from "vitest";

import {
  QUOTA_PROVIDER_ID_SYNONYMS,
  QUOTA_PROVIDER_RUNTIME_IDS,
  QUOTA_PROVIDER_SHAPES,
  getQuotaProviderDisplayLabel,
  getQuotaProviderRuntimeIds,
  getQuotaProviderShape,
  normalizeQuotaProviderId,
} from "../src/lib/provider-metadata.js";

describe("provider-metadata", () => {
  it("defines the canonical provider setup catalog", () => {
    expect(QUOTA_PROVIDER_SHAPES).toEqual([
      {
        id: "anthropic",
        autoSetup: "needs_quick_setup",
        authentication: "local_cli_auth",
        quota: "local_cli_report",
        quickSetupAnchor: "anthropic-quick-setup",
      },
      {
        id: "copilot",
        autoSetup: "usually",
        authentication: "github_oauth_or_pat",
        quota: "remote_api",
        notes: "OAuth for personal flow; PAT for managed billing",
      },
      {
        id: "openai",
        autoSetup: "yes",
        authentication: "opencode_auth_oauth_token",
        quota: "remote_api",
      },
      {
        id: "cursor",
        autoSetup: "needs_quick_setup",
        authentication: "companion_auth_oauth_token",
        quota: "local_runtime_accounting",
        quickSetupAnchor: "cursor-quick-setup",
        notes: "companion runtime/plugin integration plus local usage accounting",
      },
      {
        id: "qwen-code",
        autoSetup: "needs_quick_setup",
        authentication: "companion_auth_oauth_token",
        quota: "local_estimation",
        quickSetupAnchor: "qwen-code-quick-setup",
      },
      {
        id: "alibaba-coding-plan",
        autoSetup: "yes",
        authentication: "opencode_auth_api_key",
        authFallbacks: ["env_api_key", "global_opencode_config"],
        quota: "local_estimation",
      },
      {
        id: "synthetic",
        autoSetup: "yes",
        authentication: "opencode_auth_api_key",
        authFallbacks: ["env_api_key", "global_opencode_config"],
        quota: "remote_api",
      },
      {
        id: "chutes",
        autoSetup: "usually",
        authentication: "opencode_auth_api_key",
        authFallbacks: ["env_api_key", "global_opencode_config"],
        quota: "remote_api",
      },
      {
        id: "crof",
        autoSetup: "manual_env_config",
        authentication: "external_api_key",
        authFallbacks: ["env_api_key", "global_opencode_config"],
        quota: "remote_api",
        notes: "Requires CROF_API_KEY, CROFAI_API_KEY, or trusted user/global config; not available through OpenCode /connect",
      },
      {
        id: "google-antigravity",
        autoSetup: "needs_quick_setup",
        authentication: "companion_auth_oauth_token",
        quota: "remote_api",
        quickSetupAnchor: "google-antigravity-quick-setup",
      },
      {
        id: "google-gemini-cli",
        autoSetup: "needs_quick_setup",
        authentication: "companion_auth_oauth_token",
        quota: "remote_api",
        quickSetupAnchor: "google-gemini-cli-quick-setup",
      },
      {
        id: "zai",
        autoSetup: "yes",
        authentication: "opencode_auth_api_key",
        authFallbacks: ["env_api_key", "global_opencode_config"],
        quota: "remote_api",
      },
      {
        id: "zhipu",
        autoSetup: "yes",
        authentication: "opencode_auth_api_key",
        authFallbacks: ["env_api_key", "global_opencode_config"],
        quota: "remote_api",
      },
      {
        id: "nanogpt",
        autoSetup: "usually",
        authentication: "opencode_auth_api_key",
        authFallbacks: ["env_api_key", "global_opencode_config"],
        quota: "remote_api",
      },
      {
        id: "minimax-coding-plan",
        autoSetup: "yes",
        authentication: "opencode_auth_api_key",
        authFallbacks: ["env_api_key", "global_opencode_config"],
        quota: "remote_api",
      },
      {
        id: "minimax-china-coding-plan",
        autoSetup: "yes",
        authentication: "opencode_auth_api_key",
        authFallbacks: ["env_api_key", "global_opencode_config"],
        quota: "remote_api",
      },
      {
        id: "kimi-for-coding",
        autoSetup: "yes",
        authentication: "opencode_auth_api_key",
        authFallbacks: ["env_api_key", "global_opencode_config"],
        quota: "remote_api",
      },
      {
        id: "deepseek",
        autoSetup: "yes",
        authentication: "opencode_auth_api_key",
        authFallbacks: ["env_api_key", "global_opencode_config"],
        quota: "remote_api",
      },
      {
        id: "opencode-go",
        autoSetup: "needs_quick_setup",
        authentication: "state_only",
        quota: "remote_api",
        quickSetupAnchor: "opencode-go-quick-setup",
        notes: "Scrapes the OpenCode Go dashboard; requires workspaceId and authCookie",
      },
    ]);
  });

  it("keeps canonical provider setup ids unique", () => {
    const ids = QUOTA_PROVIDER_SHAPES.map((shape) => shape.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("normalizes provider synonyms to canonical ids", () => {
    expect(normalizeQuotaProviderId("  openai  ")).toBe("openai");

    for (const [alias, canonicalId] of Object.entries(QUOTA_PROVIDER_ID_SYNONYMS)) {
      expect(normalizeQuotaProviderId(alias)).toBe(canonicalId);
    }
  });

  it("defines conservative runtime ids for provider matching", () => {
    expect(QUOTA_PROVIDER_RUNTIME_IDS.copilot).toEqual([
      "copilot",
      "github-copilot",
      "copilot-chat",
      "github-copilot-chat",
    ]);
    expect(QUOTA_PROVIDER_RUNTIME_IDS.anthropic).toEqual(["anthropic"]);
    expect(QUOTA_PROVIDER_RUNTIME_IDS.openai).toEqual(["openai", "chatgpt", "codex"]);
    expect(QUOTA_PROVIDER_RUNTIME_IDS.cursor).toEqual(["cursor", "cursor-acp"]);
    expect(QUOTA_PROVIDER_RUNTIME_IDS.synthetic).toEqual(["synthetic"]);
    expect(QUOTA_PROVIDER_RUNTIME_IDS.chutes).toEqual(["chutes", "chutes-ai"]);
    expect(QUOTA_PROVIDER_RUNTIME_IDS.crof).toEqual(["crof"]);
    expect(QUOTA_PROVIDER_RUNTIME_IDS["google-antigravity"]).toEqual([
      "google-antigravity",
      "google",
      "antigravity",
    ]);
    expect(QUOTA_PROVIDER_RUNTIME_IDS["google-gemini-cli"]).toEqual([
      "google-gemini-cli",
      "gemini-cli",
      "gemini",
      "opencode-gemini-auth",
      "google",
    ]);
    expect(QUOTA_PROVIDER_RUNTIME_IDS.zai).toEqual(["zai", "glm", "zai-coding-plan"]);
    expect(QUOTA_PROVIDER_RUNTIME_IDS.zhipu).toEqual([
      "zhipu",
      "glm-coding-plan",
      "zhipu-coding-plan",
    ]);
    expect(QUOTA_PROVIDER_RUNTIME_IDS.nanogpt).toEqual(["nanogpt", "nano-gpt"]);
    expect(QUOTA_PROVIDER_RUNTIME_IDS["minimax-coding-plan"]).toEqual([
      "minimax-coding-plan",
      "minimax",
    ]);
    expect(QUOTA_PROVIDER_RUNTIME_IDS["minimax-china-coding-plan"]).toEqual([
      "minimax-china-coding-plan",
      "minimax-cn-coding-plan",
      "minimax-cn",
      "minimax-china",
    ]);
    expect(QUOTA_PROVIDER_RUNTIME_IDS["kimi-for-coding"]).toEqual([
      "kimi-for-coding",
      "kimi",
      "kimi-code",
    ]);
    expect(QUOTA_PROVIDER_RUNTIME_IDS.deepseek).toEqual(["deepseek"]);
  });

  it("keeps runtime ids distinct from broad normalization aliases", () => {
    expect(getQuotaProviderRuntimeIds("github-copilot")).toEqual([
      "copilot",
      "github-copilot",
      "copilot-chat",
      "github-copilot-chat",
    ]);
    expect(getQuotaProviderRuntimeIds("claude")).toEqual(["anthropic"]);
    expect(getQuotaProviderRuntimeIds("openai")).toEqual(["openai", "chatgpt", "codex"]);
    expect(getQuotaProviderRuntimeIds("open-cursor")).toEqual(["cursor", "cursor-acp"]);
    expect(getQuotaProviderRuntimeIds("google-antigravity")).toEqual([
      "google-antigravity",
      "google",
      "antigravity",
    ]);
    expect(getQuotaProviderRuntimeIds("gemini-cli")).toEqual([
      "google-gemini-cli",
      "gemini-cli",
      "gemini",
      "opencode-gemini-auth",
      "google",
    ]);
    expect(getQuotaProviderRuntimeIds("zai")).toEqual(["zai", "glm", "zai-coding-plan"]);
    expect(getQuotaProviderRuntimeIds("zhipu-coding-plan")).toEqual([
      "zhipu",
      "glm-coding-plan",
      "zhipu-coding-plan",
    ]);
    expect(getQuotaProviderRuntimeIds("glm-coding-plan")).toEqual([
      "zhipu",
      "glm-coding-plan",
      "zhipu-coding-plan",
    ]);
    expect(getQuotaProviderRuntimeIds("minimax")).toEqual([
      "minimax-coding-plan",
      "minimax",
    ]);
    expect(getQuotaProviderRuntimeIds("minimax-cn")).toEqual([
      "minimax-china-coding-plan",
      "minimax-cn-coding-plan",
      "minimax-cn",
      "minimax-china",
    ]);
    expect(getQuotaProviderRuntimeIds("kimi")).toEqual(["kimi-for-coding", "kimi", "kimi-code"]);
    expect(getQuotaProviderRuntimeIds("deep-seek")).toEqual(["deepseek"]);
    expect(getQuotaProviderRuntimeIds("not-a-provider")).toEqual([]);
  });

  it("returns provider setup metadata for canonical ids and aliases", () => {
    expect(getQuotaProviderShape("openai")).toEqual({
      id: "openai",
      autoSetup: "yes",
      authentication: "opencode_auth_oauth_token",
      quota: "remote_api",
    });
    expect(getQuotaProviderShape("github-copilot")).toEqual({
      id: "copilot",
      autoSetup: "usually",
      authentication: "github_oauth_or_pat",
      quota: "remote_api",
      notes: "OAuth for personal flow; PAT for managed billing",
    });
    expect(getQuotaProviderShape("qwen")).toEqual({
      id: "qwen-code",
      autoSetup: "needs_quick_setup",
      authentication: "companion_auth_oauth_token",
      quota: "local_estimation",
      quickSetupAnchor: "qwen-code-quick-setup",
    });
    expect(getQuotaProviderShape("gemini-cli")).toEqual({
      id: "google-gemini-cli",
      autoSetup: "needs_quick_setup",
      authentication: "companion_auth_oauth_token",
      quota: "remote_api",
      quickSetupAnchor: "google-gemini-cli-quick-setup",
    });
    expect(getQuotaProviderShape("deep-seek")).toEqual({
      id: "deepseek",
      autoSetup: "yes",
      authentication: "opencode_auth_api_key",
      authFallbacks: ["env_api_key", "global_opencode_config"],
      quota: "remote_api",
    });
    expect(getQuotaProviderShape("not-a-provider")).toBeUndefined();
  });

  it("returns display labels for known providers", () => {
    expect(getQuotaProviderDisplayLabel("anthropic")).toBe("Anthropic");
    expect(getQuotaProviderDisplayLabel("google-antigravity")).toBe("Google");
    expect(getQuotaProviderDisplayLabel("gemini-cli")).toBe("Gemini CLI");
    expect(getQuotaProviderDisplayLabel("cursor")).toBe("Cursor");
    expect(getQuotaProviderDisplayLabel("alibaba-coding-plan")).toBe("Alibaba Coding Plan");
    expect(getQuotaProviderDisplayLabel("synthetic")).toBe("Synthetic");
    expect(getQuotaProviderDisplayLabel("zai")).toBe("Z.ai");
    expect(getQuotaProviderDisplayLabel("zhipu")).toBe("Zhipu");
    expect(getQuotaProviderDisplayLabel("zhipu-coding-plan")).toBe("Zhipu");
    expect(getQuotaProviderDisplayLabel("nanogpt")).toBe("NanoGPT");
    expect(getQuotaProviderDisplayLabel("nano-gpt")).toBe("NanoGPT");
    expect(getQuotaProviderDisplayLabel("minimax")).toBe("MiniMax Coding Plan");
    expect(getQuotaProviderDisplayLabel("minimax-cn-coding-plan")).toBe("MiniMax Coding Plan (CN)");
    expect(getQuotaProviderDisplayLabel("kimi-code")).toBe("Kimi Code");
    expect(getQuotaProviderDisplayLabel("kimi")).toBe("Kimi Code");
    expect(getQuotaProviderDisplayLabel("deep-seek")).toBe("DeepSeek");
    expect(getQuotaProviderDisplayLabel("something-else")).toBe("something-else");
  });
});
