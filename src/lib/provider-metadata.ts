export type CanonicalQuotaProviderId =
  | "anthropic"
  | "copilot"
  | "openai"
  | "cursor"
  | "qwen-code"
  | "alibaba-coding-plan"
  | "synthetic"
  | "chutes"
  | "crof"
  | "google-antigravity"
  | "google-gemini-cli"
  | "zai"
  | "zhipu"
  | "nanogpt"
  | "minimax-coding-plan"
  | "minimax-china-coding-plan"
  | "kimi-for-coding"
  | "deepseek"
  | "opencode-go";

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
  synthetic: "Synthetic",
  chutes: "Chutes",
  crof: "Crof",
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
  "opencode-go": "OpenCode Go",
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
  "opencode-go-subscription": "opencode-go",
  "gemini-cli": "google-gemini-cli",
  "google-gemini": "google-gemini-cli",
  "opencode-gemini-auth": "google-gemini-cli",
  gemini: "google-gemini-cli",
  "glm-coding-plan": "zhipu",
  "zhipu-coding-plan": "zhipu",
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
  crof: ["crof"],
  "google-antigravity": ["google-antigravity", "google", "antigravity"],
  "google-gemini-cli": [
    "google-gemini-cli",
    "gemini-cli",
    "gemini",
    "opencode-gemini-auth",
    "google",
  ],
  zai: ["zai", "glm", "zai-coding-plan"],
  zhipu: ["zhipu", "glm-coding-plan", "zhipu-coding-plan"],
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
  "opencode-go": ["opencode-go"],
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
