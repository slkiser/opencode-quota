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

interface QuotaProviderShapeSource {
  lifecycle?: "deprecated";
  recommendedReplacementId?: string;
  autoSetup: QuotaProviderAutoSetup;
  authentication: QuotaProviderAuthentication;
  authFallbacks?: readonly QuotaProviderAuthFallback[];
  quota: QuotaProviderQuotaSource;
  quickSetupAnchor?: string;
  notes?: string;
}

interface QuotaProviderCatalogSourceEntry {
  label: string;
  labelAliases?: readonly string[];
  runtimeIds: readonly string[];
  synonyms: readonly string[];
  liveLocalUsage?: true;
  shape: QuotaProviderShapeSource;
}

const PROVIDER_CATALOG_SOURCE = {
  anthropic: {
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
  copilot: {
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
  openai: {
    label: "OpenAI",
    runtimeIds: ["openai", "chatgpt", "codex"],
    synonyms: [],
    shape: {
      autoSetup: "yes",
      authentication: "opencode_auth_oauth_token",
      quota: "remote_api",
    },
  },
  openrouter: {
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
  cursor: {
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
  "qwen-code": {
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
  "alibaba-coding-plan": {
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
  synthetic: {
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
  chutes: {
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
  "google-antigravity": {
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
  "google-gemini-cli": {
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
  "google-agy": {
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
  zai: {
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
  zhipu: {
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
  nanogpt: {
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
  "minimax-coding-plan": {
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
  "minimax-china-coding-plan": {
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
  "kimi-for-coding": {
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
  deepseek: {
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
  xai: {
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
  xiaomi: {
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
  "opencode-go": {
    label: "OpenCode Go",
    runtimeIds: ["opencode-go"],
    synonyms: ["opencode-go-subscription"],
    shape: {
      autoSetup: "needs_quick_setup",
      authentication: "state_only",
      quota: "remote_api",
      quickSetupAnchor: "opencode-go",
      notes: "Scrapes the OpenCode Go dashboard; requires workspaceId and authCookie",
    },
  },
  opencode: {
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
  "ollama-cloud": {
    label: "Ollama Cloud",
    runtimeIds: ["ollama-cloud"],
    synonyms: [],
    shape: {
      autoSetup: "manual_env_config",
      authentication: "state_only",
      quota: "remote_api",
      notes:
        "Scrapes the Ollama Cloud settings page; requires __Secure-session cookie via OLLAMA_USAGE_COOKIE env or ollama-usage config",
    },
  },
  "quota-providers": {
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
} as const satisfies Record<string, QuotaProviderCatalogSourceEntry>;

export type CanonicalQuotaProviderId = keyof typeof PROVIDER_CATALOG_SOURCE;

export interface QuotaProviderShape {
  id: CanonicalQuotaProviderId;
  lifecycle?: "deprecated";
  recommendedReplacementId?: CanonicalQuotaProviderId;
  autoSetup: QuotaProviderAutoSetup;
  authentication: QuotaProviderAuthentication;
  authFallbacks?: QuotaProviderAuthFallback[];
  quota: QuotaProviderQuotaSource;
  quickSetupAnchor?: string;
  notes?: string;
}

export interface QuotaProviderCatalogEntry {
  label: string;
  labelAliases: readonly string[];
  runtimeIds: readonly string[];
  synonyms: readonly string[];
  shape: QuotaProviderShape;
}

export type QuotaProviderRuntimeIds = Readonly<Record<CanonicalQuotaProviderId, readonly string[]>>;

function catalogKeys(): CanonicalQuotaProviderId[] {
  return Object.keys(PROVIDER_CATALOG_SOURCE) as CanonicalQuotaProviderId[];
}

function isCanonicalQuotaProviderId(value: string): value is CanonicalQuotaProviderId {
  return value in PROVIDER_CATALOG_SOURCE;
}

function buildProviderShape(
  id: CanonicalQuotaProviderId,
  source: QuotaProviderCatalogSourceEntry,
): QuotaProviderShape {
  const { recommendedReplacementId, authFallbacks, ...shape } = source.shape;
  let replacementId: CanonicalQuotaProviderId | undefined;
  if (recommendedReplacementId) {
    if (!isCanonicalQuotaProviderId(recommendedReplacementId)) {
      throw new Error(`Unknown quota provider replacement: ${recommendedReplacementId}`);
    }
    replacementId = recommendedReplacementId;
  }

  return {
    id,
    ...shape,
    ...(replacementId ? { recommendedReplacementId: replacementId } : {}),
    ...(authFallbacks ? { authFallbacks: [...authFallbacks] } : {}),
  };
}

function completeCatalogRecord<T>(
  entries: Array<readonly [CanonicalQuotaProviderId, T]>,
): Record<CanonicalQuotaProviderId, T> {
  const record: Partial<Record<CanonicalQuotaProviderId, T>> = {};
  for (const [id, value] of entries) record[id] = value;
  return record as Record<CanonicalQuotaProviderId, T>;
}

export const QUOTA_PROVIDER_CATALOG: Readonly<
  Record<CanonicalQuotaProviderId, QuotaProviderCatalogEntry>
> = completeCatalogRecord(
  catalogKeys().map((id) => {
    const source = PROVIDER_CATALOG_SOURCE[id];
    return [
      id,
      {
        label: source.label,
        labelAliases: [...("labelAliases" in source ? source.labelAliases : [])],
        runtimeIds: [...source.runtimeIds],
        synonyms: [...source.synonyms],
        shape: buildProviderShape(id, source),
      },
    ] as const;
  }),
);

export const QUOTA_PROVIDER_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  catalogKeys().flatMap((id) => {
    const entry = QUOTA_PROVIDER_CATALOG[id];
    return [[id, entry.label], ...entry.labelAliases.map((alias) => [alias, entry.label])];
  }),
);

export const QUOTA_PROVIDER_ID_SYNONYMS: Readonly<Record<string, string>> = Object.fromEntries(
  catalogKeys().flatMap((id) =>
    QUOTA_PROVIDER_CATALOG[id].synonyms.map((synonym) => [synonym, id]),
  ),
);

export const QUOTA_PROVIDER_RUNTIME_IDS: QuotaProviderRuntimeIds = completeCatalogRecord(
  catalogKeys().map((id) => [id, QUOTA_PROVIDER_CATALOG[id].runtimeIds] as const),
);

export const QUOTA_PROVIDER_SHAPES: readonly QuotaProviderShape[] = catalogKeys().map(
  (id) => QUOTA_PROVIDER_CATALOG[id].shape,
);

const LIVE_LOCAL_USAGE_PROVIDER_ID_SET = new Set<string>(
  catalogKeys().filter((id) => {
    const source = PROVIDER_CATALOG_SOURCE[id];
    return "liveLocalUsage" in source && source.liveLocalUsage === true;
  }),
);

export function normalizeQuotaProviderId(id: string): string {
  const normalized = id.trim().toLowerCase();
  return QUOTA_PROVIDER_ID_SYNONYMS[normalized] ?? normalized;
}

export function getQuotaProviderShape(id: string): QuotaProviderShape | undefined {
  const normalized = normalizeQuotaProviderId(id);
  return isCanonicalQuotaProviderId(normalized)
    ? QUOTA_PROVIDER_CATALOG[normalized].shape
    : undefined;
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
