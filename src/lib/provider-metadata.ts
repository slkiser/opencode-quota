export type CanonicalQuotaProviderId =
  | "anthropic"
  | "copilot"
  | "openai"
  | "cursor"
  | "qwen-code"
  | "alibaba-coding-plan"
  | "firmware"
  | "chutes"
  | "google-antigravity"
  | "zai"
  | "nanogpt"
  | "minimax-coding-plan"
  | "opencode-go";

export type QuotaProviderAutoSetup = "yes" | "usually" | "needs_quick_setup";

export type QuotaProviderAuthentication =
  | "opencode_auth_oauth_token"
  | "opencode_auth_api_key"
  | "companion_auth_oauth_token"
  | "local_cli_auth"
  | "github_oauth_or_pat"
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
  notes?: string;
}

export type QuotaProviderRuntimeIds = Readonly<Record<CanonicalQuotaProviderId, readonly string[]>>;

export const QUOTA_PROVIDER_LABELS: Readonly<Record<string, string>> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  copilot: "Copilot",
  "google-antigravity": "Google",
  firmware: "Firmware",
  chutes: "Chutes",
  cursor: "Cursor",
  "qwen-code": "Qwen",
  "alibaba-coding-plan": "Alibaba Coding Plan",
  zai: "Z.ai",
  nanogpt: "NanoGPT",
  "minimax-coding-plan": "MiniMax Coding Plan",
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
  "opencode-go-subscription": "opencode-go",
};

export const QUOTA_PROVIDER_RUNTIME_IDS: QuotaProviderRuntimeIds = {
  anthropic: ["anthropic"],
  copilot: ["copilot", "github-copilot", "copilot-chat", "github-copilot-chat"],
  openai: ["openai", "chatgpt", "codex"],
  cursor: ["cursor", "cursor-acp"],
  "qwen-code": ["qwen-code"],
  "alibaba-coding-plan": ["alibaba-coding-plan"],
  firmware: ["firmware", "firmware-ai"],
  chutes: ["chutes", "chutes-ai"],
  "google-antigravity": ["google-antigravity", "google", "antigravity"],
  zai: ["zai", "glm", "zai-coding-plan"],
  nanogpt: ["nanogpt", "nano-gpt"],
  "minimax-coding-plan": ["minimax-coding-plan", "minimax"],
  "opencode-go": ["opencode-go"],
};

export const QUOTA_PROVIDER_SHAPES: readonly QuotaProviderShape[] = [
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
