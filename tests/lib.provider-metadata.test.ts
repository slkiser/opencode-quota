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
        notes: "companion runtime/plugin integration plus local usage accounting",
      },
      {
        id: "qwen-code",
        autoSetup: "needs_quick_setup",
        authentication: "companion_auth_oauth_token",
        quota: "local_estimation",
      },
      {
        id: "alibaba-coding-plan",
        autoSetup: "yes",
        authentication: "opencode_auth_api_key",
        quota: "local_estimation",
      },
      {
        id: "firmware",
        autoSetup: "usually",
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
        id: "google-antigravity",
        autoSetup: "needs_quick_setup",
        authentication: "companion_auth_oauth_token",
        quota: "remote_api",
      },
      {
        id: "zai",
        autoSetup: "yes",
        authentication: "opencode_auth_api_key",
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
        quota: "remote_api",
      },
      {
        id: "opencode-go",
        autoSetup: "needs_quick_setup",
        authentication: "state_only",
        quota: "remote_api",
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
    expect(QUOTA_PROVIDER_RUNTIME_IDS.firmware).toEqual(["firmware", "firmware-ai"]);
    expect(QUOTA_PROVIDER_RUNTIME_IDS.chutes).toEqual(["chutes", "chutes-ai"]);
    expect(QUOTA_PROVIDER_RUNTIME_IDS["google-antigravity"]).toEqual([
      "google-antigravity",
      "google",
      "antigravity",
    ]);
    expect(QUOTA_PROVIDER_RUNTIME_IDS.zai).toEqual(["zai", "glm", "zai-coding-plan"]);
    expect(QUOTA_PROVIDER_RUNTIME_IDS.nanogpt).toEqual(["nanogpt", "nano-gpt"]);
    expect(QUOTA_PROVIDER_RUNTIME_IDS["minimax-coding-plan"]).toEqual([
      "minimax-coding-plan",
      "minimax",
    ]);
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
    expect(getQuotaProviderRuntimeIds("zai")).toEqual(["zai", "glm", "zai-coding-plan"]);
    expect(getQuotaProviderRuntimeIds("minimax")).toEqual(["minimax-coding-plan", "minimax"]);
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
    });
    expect(getQuotaProviderShape("not-a-provider")).toBeUndefined();
  });

  it("returns display labels for known providers", () => {
    expect(getQuotaProviderDisplayLabel("anthropic")).toBe("Anthropic");
    expect(getQuotaProviderDisplayLabel("google-antigravity")).toBe("Google");
    expect(getQuotaProviderDisplayLabel("cursor")).toBe("Cursor");
    expect(getQuotaProviderDisplayLabel("alibaba-coding-plan")).toBe("Alibaba Coding Plan");
    expect(getQuotaProviderDisplayLabel("zai")).toBe("Z.ai");
    expect(getQuotaProviderDisplayLabel("nanogpt")).toBe("NanoGPT");
    expect(getQuotaProviderDisplayLabel("nano-gpt")).toBe("NanoGPT");
    expect(getQuotaProviderDisplayLabel("minimax")).toBe("MiniMax Coding Plan");
    expect(getQuotaProviderDisplayLabel("something-else")).toBe("something-else");
  });
});
