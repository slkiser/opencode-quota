export type CanonicalQuotaProviderId =
  | "anthropic"
  | "copilot"
  | "openai"
  | "cursor"
  | "qwen-code"
  | "alibaba-coding-plan"
  | "synthetic"
  | "chutes"
  | "google-antigravity"
  | "google-gemini-cli"
  | "google-agy"
  | "zai"
  | "zhipu"
  | "nanogpt"
  | "minimax-coding-plan"
  | "minimax-china-coding-plan"
  | "kimi-for-coding"
  | "deepseek"
  | "xai"
  | "opencode-go"
  | "opencode"
  | "ollama-cloud"
  | "quota-providers";

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

export interface QuotaProviderShape {
  id: CanonicalQuotaProviderId;
  autoSetup: QuotaProviderAutoSetup;
  authentication: QuotaProviderAuthentication;
  authFallbacks?: QuotaProviderAuthFallback[];
  quota: QuotaProviderQuotaSource;
  quickSetupAnchor?: string;
  notes?: string;
}

export type QuotaProviderRuntimeIds = Readonly<Record<CanonicalQuotaProviderId, readonly string[]>>;

export const QUOTA_PROVIDER_LABELS: Readonly<Record<string, string>> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  copilot: "Copilot",
  "google-antigravity": "Google",
  "google-gemini-cli": "Gemini CLI",
  "google-agy": "Google AGY",
  synthetic: "Synthetic",
  chutes: "Chutes",
  cursor: "Cursor",
  "qwen-code": "Qwen",
  "alibaba-coding-plan": "Alibaba Coding Plan",
  zai: "Z.ai",
  zhipu: "Zhipu",
  nanogpt: "NanoGPT",
  "minimax-coding-plan": "MiniMax Coding Plan",
  "minimax-china-coding-plan": "MiniMax Coding Plan (CN)",
  "minimax-cn-coding-plan": "MiniMax Coding Plan (CN)",
  "kimi-for-coding": "Kimi Code",
  "kimi-code": "Kimi Code",
  deepseek: "DeepSeek",
  xai: "xAI",
  "opencode-go": "OpenCode Go",
  opencode: "OpenCode Zen",
  "ollama-cloud": "Ollama Cloud",
  "quota-providers": "Quota providers",
};

export const QUOTA_PROVIDER_ID_SYNONYMS: Readonly<Record<string, string>> = {
  "github-copilot": "copilot",
  "copilot-chat": "copilot",
  "github-copilot-chat": "copilot",
  "cursor-acp": "cursor",
  "open-cursor": "cursor",
  "@rama_nigg/open-cursor": "cursor",
  claude: "anthropic",
  "claude-code": "anthropic",
  qwen: "qwen-code",
  alibaba: "alibaba-coding-plan",
  "nano-gpt": "nanogpt",
  minimax: "minimax-coding-plan",
  "minimax-cn": "minimax-china-coding-plan",
  "minimax-china": "minimax-china-coding-plan",
  "minimax-cn-coding-plan": "minimax-china-coding-plan",
  kimi: "kimi-for-coding",
  "kimi-for-code": "kimi-for-coding",
  "kimi-code": "kimi-for-coding",
  "deep-seek": "deepseek",
  grok: "xai",
  "x-ai": "xai",
  "opencode-go-subscription": "opencode-go",
  "opencode-zen": "opencode",
  "gemini-cli": "google-gemini-cli",
  "google-gemini": "google-gemini-cli",
  "opencode-gemini-auth": "google-gemini-cli",
  gemini: "google-gemini-cli",
  "opencode-agy-auth": "google-agy",
  "google-agy-auth": "google-agy",
  "glm-coding-plan": "zhipu",
  "zhipu-coding-plan": "zhipu",
  "zhipuai-coding-plan": "zhipu",
};

export const QUOTA_PROVIDER_RUNTIME_IDS: QuotaProviderRuntimeIds = {
  anthropic: ["anthropic"],
  copilot: ["copilot", "github-copilot", "copilot-chat", "github-copilot-chat"],
  openai: ["openai", "chatgpt", "codex"],
  cursor: ["cursor", "cursor-acp"],
  "qwen-code": ["qwen-code"],
  "alibaba-coding-plan": ["alibaba-coding-plan"],
  synthetic: ["synthetic"],
  chutes: ["chutes", "chutes-ai"],
  "google-antigravity": ["google-antigravity", "google", "antigravity"],
  "google-gemini-cli": [
    "google-gemini-cli",
    "gemini-cli",
    "gemini",
    "opencode-gemini-auth",
    "google",
  ],
  "google-agy": ["google-agy", "opencode-agy-auth", "google-agy-auth"],
  zai: ["zai", "glm", "zai-coding-plan"],
  zhipu: ["zhipu", "glm-coding-plan", "zhipu-coding-plan", "zhipuai-coding-plan"],
  nanogpt: ["nanogpt", "nano-gpt"],
  "minimax-coding-plan": ["minimax-coding-plan", "minimax"],
  "minimax-china-coding-plan": [
    "minimax-china-coding-plan",
    "minimax-cn-coding-plan",
    "minimax-cn",
    "minimax-china",
  ],
  "kimi-for-coding": ["kimi-for-coding", "kimi", "kimi-code"],
  deepseek: ["deepseek"],
  xai: ["xai", "grok"],
  "opencode-go": ["opencode-go"],
  opencode: ["opencode", "opencode-zen"],
  "ollama-cloud": ["ollama-cloud"],
  "quota-providers": [],
};

const LIVE_LOCAL_USAGE_PROVIDER_ID_SET = new Set<string>([
  "qwen-code",
  "alibaba-coding-plan",
  "cursor",
]);

export const QUOTA_PROVIDER_SHAPES: readonly QuotaProviderShape[] = [
  {
    id: "anthropic",
    autoSetup: "needs_quick_setup",
    authentication: "local_cli_auth",
    quota: "local_cli_report",
    quickSetupAnchor: "anthropic-claude",
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
    quickSetupAnchor: "cursor",
    notes: "companion runtime/plugin integration plus local usage accounting",
  },
  {
    id: "qwen-code",
    autoSetup: "needs_quick_setup",
    authentication: "companion_auth_oauth_token",
    quota: "local_estimation",
    quickSetupAnchor: "qwen-code",
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
    id: "google-antigravity",
    autoSetup: "needs_quick_setup",
    authentication: "companion_auth_oauth_token",
    quota: "remote_api",
    quickSetupAnchor: "google-antigravity",
  },
  {
    id: "google-gemini-cli",
    autoSetup: "needs_quick_setup",
    authentication: "companion_auth_oauth_token",
    quota: "remote_api",
    quickSetupAnchor: "gemini-cli",
  },
  {
    id: "google-agy",
    autoSetup: "needs_quick_setup",
    authentication: "companion_auth_oauth_token",
    quota: "remote_api",
    quickSetupAnchor: "google-agy-quick-setup",
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
    id: "xai",
    autoSetup: "yes",
    authentication: "opencode_auth_oauth_token",
    quota: "remote_api",
    notes: "SuperGrok OAuth via OpenCode /connect; shared weekly credit meter",
  },
  {
    id: "opencode-go",
    autoSetup: "needs_quick_setup",
    authentication: "state_only",
    quota: "remote_api",
    quickSetupAnchor: "opencode-go",
    notes: "Scrapes the OpenCode Go dashboard; requires workspaceId and authCookie",
  },
  {
    id: "opencode",
    autoSetup: "needs_quick_setup",
    authentication: "state_only",
    quota: "remote_api",
    quickSetupAnchor: "opencode-zen",
    notes: "Scrapes the OpenCode Zen billing page; requires workspaceId and authCookie",
  },
  {
    id: "ollama-cloud",
    autoSetup: "manual_env_config",
    authentication: "state_only",
    quota: "remote_api",
    notes:
      "Scrapes the Ollama Cloud settings page; requires __Secure-session cookie via OLLAMA_USAGE_COOKIE env or ollama-usage config",
  },
  {
    id: "quota-providers",
    autoSetup: "manual_env_config",
    authentication: "external_api_key",
    authFallbacks: ["env_api_key", "global_opencode_config"],
    quota: "remote_api",
    notes: "Aggregates exact user-configured accounting sources",
  },
];

const QUOTA_PROVIDER_SHAPES_BY_ID: Readonly<
  Partial<Record<CanonicalQuotaProviderId, QuotaProviderShape>>
> = Object.fromEntries(QUOTA_PROVIDER_SHAPES.map((shape) => [shape.id, shape]));

export function normalizeQuotaProviderId(id: string): string {
  const normalized = id.trim().toLowerCase();
  return QUOTA_PROVIDER_ID_SYNONYMS[normalized] ?? normalized;
}

export function getQuotaProviderShape(id: string): QuotaProviderShape | undefined {
  const normalized = normalizeQuotaProviderId(id) as CanonicalQuotaProviderId;
  return QUOTA_PROVIDER_SHAPES_BY_ID[normalized];
}

export function getQuotaProviderDisplayLabel(id: string): string {
  const normalized = normalizeQuotaProviderId(id);
  return QUOTA_PROVIDER_LABELS[normalized] ?? id;
}

export function getQuotaProviderRuntimeIds(id: string): readonly string[] {
  const shape = getQuotaProviderShape(id);
  if (!shape) {
    return [];
  }

  return [...new Set(QUOTA_PROVIDER_RUNTIME_IDS[shape.id])];
}

export function isLiveLocalUsageProviderId(id: string): boolean {
  return LIVE_LOCAL_USAGE_PROVIDER_ID_SET.has(normalizeQuotaProviderId(id));
}
