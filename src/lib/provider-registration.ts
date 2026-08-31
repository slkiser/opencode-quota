export type QuotaProviderAutoSetup = "yes" | "usually" | "manual_env_config" | "needs_quick_setup";

export type QuotaProviderAuthentication =
  | "opencode_auth_oauth_token"
  | "opencode_auth_api_key"
  | "companion_auth_oauth_token"
  | "local_cli_auth"
  | "github_oauth_or_pat"
  | "external_api_key"
  | "state_only";

export type QuotaProviderAuthFallback = "env_api_key" | "global_opencode_config";

export type QuotaProviderQuotaSource =
  | "remote_api"
  | "local_estimation"
  | "local_runtime_accounting"
  | "local_cli_report";

export interface QuotaProviderShapeSource {
  lifecycle?: "deprecated";
  recommendedReplacementId?: string;
  autoSetup: QuotaProviderAutoSetup;
  authentication: QuotaProviderAuthentication;
  authFallbacks?: readonly QuotaProviderAuthFallback[];
  quota: QuotaProviderQuotaSource;
  quickSetupAnchor?: string;
  notes?: string;
}

export interface QuotaProviderRegistrationSourceEntry {
  id: string;
  label: string;
  labelAliases?: readonly string[];
  runtimeIds: readonly string[];
  synonyms: readonly string[];
  liveLocalUsage?: true;
  shape: QuotaProviderShapeSource;
}

export const QUOTA_PROVIDER_REGISTRATION_SOURCE = [
  {
    id: "anthropic",
    label: "Anthropic",
    runtimeIds: ["anthropic"],
    synonyms: ["claude", "claude-code"],
    shape: {
      autoSetup: "needs_quick_setup",
      authentication: "local_cli_auth",
      quota: "local_cli_report",
      quickSetupAnchor: "anthropic-claude",
    },
  },
  {
    id: "copilot",
    label: "Copilot",
    runtimeIds: ["copilot", "github-copilot", "copilot-chat", "github-copilot-chat"],
    synonyms: ["github-copilot", "copilot-chat", "github-copilot-chat"],
    shape: {
      autoSetup: "usually",
      authentication: "github_oauth_or_pat",
      quota: "remote_api",
      notes: "OAuth for personal flow; PAT for managed billing",
    },
  },
  {
    id: "openai",
    label: "OpenAI",
    runtimeIds: ["openai", "chatgpt", "codex"],
    synonyms: [],
    shape: {
      autoSetup: "yes",
      authentication: "opencode_auth_oauth_token",
      quota: "remote_api",
    },
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    runtimeIds: ["openrouter"],
    synonyms: [],
    shape: {
      autoSetup: "yes",
      authentication: "opencode_auth_api_key",
      authFallbacks: ["env_api_key", "global_opencode_config"],
      quota: "remote_api",
    },
  },
  {
    id: "kilo",
    label: "Kilo Gateway",
    runtimeIds: ["kilo"],
    synonyms: [],
    shape: {
      autoSetup: "usually",
      authentication: "opencode_auth_api_key",
      authFallbacks: ["env_api_key", "global_opencode_config"],
      quota: "remote_api",
      notes:
        "Queries Kilo Pass state first, then falls back to the documented personal Gateway balance when no active subscription exists",
    },
  },
  {
    id: "cursor",
    label: "Cursor",
    runtimeIds: ["cursor", "cursor-acp"],
    synonyms: ["cursor-acp", "open-cursor", "@rama_nigg/open-cursor"],
    liveLocalUsage: true,
    shape: {
      autoSetup: "needs_quick_setup",
      authentication: "companion_auth_oauth_token",
      quota: "local_runtime_accounting",
      quickSetupAnchor: "cursor",
      notes: "companion runtime/plugin integration plus local usage accounting",
    },
  },
  {
    id: "qwen-code",
    label: "Qwen",
    runtimeIds: ["qwen-code"],
    synonyms: ["qwen"],
    liveLocalUsage: true,
    shape: {
      autoSetup: "needs_quick_setup",
      authentication: "companion_auth_oauth_token",
      quota: "local_estimation",
      quickSetupAnchor: "qwen-code",
    },
  },
  {
    id: "alibaba-coding-plan",
    label: "Alibaba Coding Plan",
    runtimeIds: ["alibaba-coding-plan"],
    synonyms: ["alibaba"],
    liveLocalUsage: true,
    shape: {
      autoSetup: "yes",
      authentication: "opencode_auth_api_key",
      authFallbacks: ["env_api_key", "global_opencode_config"],
      quota: "local_estimation",
    },
  },
  {
    id: "synthetic",
    label: "Synthetic",
    runtimeIds: ["synthetic"],
    synonyms: [],
    shape: {
      autoSetup: "yes",
      authentication: "opencode_auth_api_key",
      authFallbacks: ["env_api_key", "global_opencode_config"],
      quota: "remote_api",
    },
  },
  {
    id: "chutes",
    label: "Chutes",
    runtimeIds: ["chutes", "chutes-ai"],
    synonyms: [],
    shape: {
      autoSetup: "usually",
      authentication: "opencode_auth_api_key",
      authFallbacks: ["env_api_key", "global_opencode_config"],
      quota: "remote_api",
    },
  },
  {
    id: "google-antigravity",
    label: "Google",
    runtimeIds: ["google-antigravity", "google", "antigravity"],
    synonyms: [],
    shape: {
      autoSetup: "needs_quick_setup",
      authentication: "companion_auth_oauth_token",
      quota: "remote_api",
      quickSetupAnchor: "google-antigravity",
    },
  },
  {
    id: "google-gemini-cli",
    label: "Gemini CLI",
    runtimeIds: ["google-gemini-cli", "gemini-cli", "gemini", "opencode-gemini-auth", "google"],
    synonyms: ["gemini-cli", "google-gemini", "opencode-gemini-auth", "gemini"],
    shape: {
      lifecycle: "deprecated",
      recommendedReplacementId: "google-agy",
      autoSetup: "needs_quick_setup",
      authentication: "companion_auth_oauth_token",
      quota: "remote_api",
      quickSetupAnchor: "gemini-cli",
    },
  },
  {
    id: "google-agy",
    label: "Google AGY",
    runtimeIds: ["google-agy", "opencode-agy-auth", "google-agy-auth"],
    synonyms: ["opencode-agy-auth", "google-agy-auth"],
    shape: {
      autoSetup: "needs_quick_setup",
      authentication: "companion_auth_oauth_token",
      quota: "remote_api",
      quickSetupAnchor: "google-agy-quick-setup",
    },
  },
  {
    id: "zai",
    label: "Z.ai",
    runtimeIds: ["zai", "glm", "zai-coding-plan"],
    synonyms: [],
    shape: {
      autoSetup: "yes",
      authentication: "opencode_auth_api_key",
      authFallbacks: ["env_api_key", "global_opencode_config"],
      quota: "remote_api",
    },
  },
  {
    id: "zhipu",
    label: "Zhipu",
    runtimeIds: ["zhipu", "glm-coding-plan", "zhipu-coding-plan", "zhipuai-coding-plan"],
    synonyms: ["glm-coding-plan", "zhipu-coding-plan", "zhipuai-coding-plan"],
    shape: {
      autoSetup: "yes",
      authentication: "opencode_auth_api_key",
      authFallbacks: ["env_api_key", "global_opencode_config"],
      quota: "remote_api",
    },
  },
  {
    id: "nanogpt",
    label: "NanoGPT",
    runtimeIds: ["nanogpt", "nano-gpt"],
    synonyms: ["nano-gpt"],
    shape: {
      autoSetup: "usually",
      authentication: "opencode_auth_api_key",
      authFallbacks: ["env_api_key", "global_opencode_config"],
      quota: "remote_api",
    },
  },
  {
    id: "minimax-coding-plan",
    label: "MiniMax Coding Plan",
    runtimeIds: ["minimax-coding-plan", "minimax"],
    synonyms: ["minimax"],
    shape: {
      autoSetup: "yes",
      authentication: "opencode_auth_api_key",
      authFallbacks: ["env_api_key", "global_opencode_config"],
      quota: "remote_api",
    },
  },
  {
    id: "minimax-china-coding-plan",
    label: "MiniMax Coding Plan (CN)",
    labelAliases: ["minimax-cn-coding-plan"],
    runtimeIds: [
      "minimax-china-coding-plan",
      "minimax-cn-coding-plan",
      "minimax-cn",
      "minimax-china",
    ],
    synonyms: ["minimax-cn", "minimax-china", "minimax-cn-coding-plan"],
    shape: {
      autoSetup: "yes",
      authentication: "opencode_auth_api_key",
      authFallbacks: ["env_api_key", "global_opencode_config"],
      quota: "remote_api",
    },
  },
  {
    id: "kimi-for-coding",
    label: "Kimi Code",
    labelAliases: ["kimi-code"],
    runtimeIds: ["kimi-for-coding", "kimi", "kimi-code"],
    synonyms: ["kimi", "kimi-for-code", "kimi-code"],
    shape: {
      autoSetup: "yes",
      authentication: "opencode_auth_api_key",
      authFallbacks: ["env_api_key", "global_opencode_config"],
      quota: "remote_api",
    },
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    runtimeIds: ["deepseek"],
    synonyms: ["deep-seek"],
    shape: {
      autoSetup: "yes",
      authentication: "opencode_auth_api_key",
      authFallbacks: ["env_api_key", "global_opencode_config"],
      quota: "remote_api",
    },
  },
  {
    id: "xai",
    label: "xAI",
    runtimeIds: ["xai"],
    synonyms: [],
    shape: {
      autoSetup: "yes",
      authentication: "opencode_auth_oauth_token",
      quota: "remote_api",
      notes: "SuperGrok OAuth via OpenCode /connect; shared weekly credit meter",
    },
  },
  {
    id: "xiaomi",
    label: "Xiaomi MiMo",
    runtimeIds: [
      "xiaomi",
      "xiaomi-token-plan-cn",
      "xiaomi-token-plan-ams",
      "xiaomi-token-plan-sgp",
    ],
    synonyms: ["xiaomi-token-plan-cn", "xiaomi-token-plan-ams", "xiaomi-token-plan-sgp"],
    shape: {
      autoSetup: "needs_quick_setup",
      authentication: "state_only",
      quota: "remote_api",
      quickSetupAnchor: "xiaomi-mimo",
      notes: "Reads the Xiaomi MiMo dashboard with a filtered trusted cookie",
    },
  },
  {
    id: "opencode-go",
    label: "OpenCode Go",
    runtimeIds: ["opencode-go"],
    synonyms: ["opencode-go-subscription"],
    shape: {
      autoSetup: "yes",
      authentication: "opencode_auth_api_key",
      authFallbacks: ["env_api_key", "global_opencode_config"],
      quota: "remote_api",
      notes: "Reads the official OpenCode Go usage API through standard Go API-key sources",
    },
  },
  {
    id: "opencode",
    label: "OpenCode Zen",
    runtimeIds: ["opencode", "opencode-zen"],
    synonyms: ["opencode-zen"],
    shape: {
      autoSetup: "needs_quick_setup",
      authentication: "state_only",
      quota: "remote_api",
      quickSetupAnchor: "opencode-zen",
      notes: "Scrapes the OpenCode Zen billing page; requires workspaceId and authCookie",
    },
  },
  {
    id: "ollama-cloud",
    label: "Ollama Cloud",
    runtimeIds: ["ollama-cloud"],
    synonyms: [],
    shape: {
      autoSetup: "usually",
      authentication: "opencode_auth_api_key",
      authFallbacks: ["env_api_key", "global_opencode_config"],
      quota: "remote_api",
      notes: "Queries the Ollama Cloud usage API; reports session and weekly usage fractions",
    },
  },
  {
    id: "quota-providers",
    label: "Quota providers",
    runtimeIds: [],
    synonyms: [],
    shape: {
      autoSetup: "manual_env_config",
      authentication: "external_api_key",
      authFallbacks: ["env_api_key", "global_opencode_config"],
      quota: "remote_api",
      notes: "Aggregates exact user-configured accounting sources",
    },
  },
] as const satisfies readonly QuotaProviderRegistrationSourceEntry[];

export type CanonicalQuotaProviderId = (typeof QUOTA_PROVIDER_REGISTRATION_SOURCE)[number]["id"];
