/**
 * What every surface knows about each built-in provider, in display order: its names, the
 * OpenCode ids that count as it, its row keys and where its API key lives. No fetch code, so
 * the TUI may import it. The provider itself is `src/providers/<vendor>.ts`, bound to its id in
 * `src/providers/registry.ts`; the compiler checks that every id here has one.
 */

import type { ApiKeyLoginSpec } from "./api-key-resolver.js";

export interface QuotaProviderRegistrationSourceEntry {
  id: string;
  label: string;
  labelAliases?: readonly string[];
  runtimeIds: readonly string[];
  synonyms: readonly string[];
  liveLocalUsage?: true;
  /** Brand words at the start of its account names ("Claude Work" → "Work"). Default: its label. */
  groupBrands?: readonly string[];
  /**
   * The v6 row keys it may emit (`${id}.${key}` is the row id that hide, rename and order
   * settings use). `*` stands for one segment taken from provider data, such as a model, a
   * window family or a currency. Changing a key breaks users' settings.
   */
  rowKeys: readonly string[];
  /**
   * Where its API key may live (see `API_KEY_VENDORS`). `displayName` defaults to its label,
   * `authKeys` to its `providerKeys`.
   */
  apiKey?: Omit<ApiKeyLoginSpec, "displayName" | "authKeys"> &
    Partial<Pick<ApiKeyLoginSpec, "displayName" | "authKeys">>;
}

export const QUOTA_PROVIDER_REGISTRATION_SOURCE = [
  {
    id: "anthropic",
    label: "Anthropic",
    runtimeIds: ["anthropic", "claude-code"],
    synonyms: ["claude", "claude-code"],
    groupBrands: ["Claude"],
    rowKeys: ["five_hour", "weekly", "weekly_fable", "extra_usage"],
  },
  {
    id: "copilot",
    label: "Copilot",
    runtimeIds: ["copilot", "github-copilot", "copilot-chat", "github-copilot-chat"],
    synonyms: ["github-copilot", "copilot-chat", "github-copilot-chat"],
    rowKeys: ["allowance", "additional_budget"],
  },
  {
    id: "openai",
    label: "OpenAI",
    runtimeIds: ["openai", "chatgpt", "codex"],
    synonyms: [],
    // `status`: an OpenAI login without a ChatGPT plan ("unavailable for API key").
    rowKeys: ["five_hour", "weekly", "monthly", "code_review", "status"],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    runtimeIds: ["openrouter"],
    synonyms: [],
    rowKeys: ["key"],
  },
  {
    id: "cursor",
    label: "Cursor",
    runtimeIds: ["cursor", "cursor-acp"],
    synonyms: ["cursor-acp", "open-cursor", "@rama_nigg/open-cursor"],
    liveLocalUsage: true,
    rowKeys: ["api", "auto_composer"],
  },
  {
    id: "alibaba-coding-plan",
    label: "Alibaba Coding Plan",
    // OpenCode reaches Alibaba's models under the bare ids, so those belong to the Coding Plan.
    runtimeIds: ["alibaba-coding-plan", "alibaba-coding-plan-cn", "alibaba", "alibaba-cn"],
    synonyms: ["alibaba", "alibaba-coding-plan-cn"],
    rowKeys: ["five_hour", "weekly", "monthly"],
  },
  {
    id: "alibaba-token-plan",
    label: "Alibaba Token Plan",
    // One account, two spellings: the CLI's endpoint comes from its own config, so nothing here can
    // tell a "CN" sign-in from any other.
    runtimeIds: ["alibaba-token-plan", "alibaba-token-plan-cn"],
    synonyms: ["alibaba-token-plan-cn"],
    rowKeys: ["personal", "team.*"],
  },
  {
    id: "google-gemini-cli",
    label: "Gemini CLI",
    runtimeIds: ["google-gemini-cli", "gemini-cli", "gemini", "opencode-gemini-auth", "google"],
    synonyms: ["gemini-cli", "google-gemini", "opencode-gemini-auth", "gemini"],
    rowKeys: ["pro", "flash", "flash_lite", "model.*"],
  },
  {
    id: "google-agy",
    label: "Google AGY",
    runtimeIds: ["google-agy", "opencode-agy-auth", "google-agy-auth"],
    synonyms: ["opencode-agy-auth", "google-agy-auth"],
    groupBrands: ["Google AGY", "AGY"],
    rowKeys: [
      "gemini.weekly",
      "gemini.five_hour",
      "claude_gpt.weekly",
      "claude_gpt.five_hour",
      "*.weekly",
      "*.five_hour",
    ],
  },
  {
    id: "zai",
    label: "Z.ai",
    runtimeIds: ["zai", "glm", "zai-coding-plan"],
    synonyms: [],
    rowKeys: ["five_hour", "weekly", "mcp"],
    apiKey: {
      envVars: ["ZAI_API_KEY", "ZAI_CODING_PLAN_API_KEY"],
      providerKeys: ["zai", "zai-coding-plan", "glm"],
      authKeys: ["zai-coding-plan"],
    },
  },
  {
    id: "zhipu",
    label: "Zhipu",
    runtimeIds: ["zhipu", "glm-coding-plan", "zhipu-coding-plan", "zhipuai-coding-plan"],
    synonyms: ["glm-coding-plan", "zhipu-coding-plan", "zhipuai-coding-plan"],
    rowKeys: ["five_hour", "weekly", "mcp"],
    apiKey: {
      envVars: ["ZHIPU_API_KEY", "ZHIPU_CODING_PLAN_API_KEY"],
      providerKeys: ["zhipu", "zhipu-coding-plan", "zhipuai-coding-plan", "glm-coding-plan"],
      authKeys: ["zhipu-coding-plan", "zhipuai-coding-plan"],
    },
  },
  {
    id: "minimax-coding-plan",
    label: "MiniMax Token Plan",
    runtimeIds: ["minimax-coding-plan", "minimax"],
    synonyms: ["minimax"],
    rowKeys: ["five_hour", "weekly"],
    apiKey: {
      displayName: "MiniMax",
      envVars: ["MINIMAX_CODING_PLAN_API_KEY", "MINIMAX_API_KEY"],
      providerKeys: ["minimax-coding-plan", "minimax"],
      authKeys: ["minimax-coding-plan"],
    },
  },
  {
    id: "minimax-china-coding-plan",
    label: "MiniMax Token Plan (CN)",
    labelAliases: ["minimax-cn-coding-plan"],
    runtimeIds: [
      "minimax-china-coding-plan",
      "minimax-cn-coding-plan",
      "minimax-cn",
      "minimax-china",
    ],
    synonyms: ["minimax-cn", "minimax-china", "minimax-cn-coding-plan"],
    groupBrands: ["MiniMax Token Plan (CN)", "MiniMax Token Plan"],
    rowKeys: ["five_hour", "weekly"],
    apiKey: {
      displayName: "MiniMax",
      envVars: ["MINIMAX_CHINA_CODING_PLAN_API_KEY"],
      providerKeys: [
        "minimax-china-coding-plan",
        "minimax-cn-coding-plan",
        "minimax-cn",
        "minimax-china",
      ],
      authKeys: ["minimax-china-coding-plan", "minimax-cn-coding-plan"],
    },
  },
  {
    id: "kimi-code-plan-global",
    label: "Kimi Code",
    runtimeIds: ["kimi-code-plan-global"],
    synonyms: [],
    rowKeys: ["weekly", "limit.*"],
    apiKey: {
      displayName: "Kimi",
      envVars: ["KIMI_GLOBAL_API_KEY"],
      providerKeys: ["kimi-code-plan-global"],
    },
  },
  {
    id: "kimi-code-plan-cn",
    label: "Kimi Code (CN)",
    labelAliases: ["kimi-code"],
    runtimeIds: ["kimi-code-plan-cn", "kimi-for-coding", "kimi", "kimi-code"],
    synonyms: ["kimi", "kimi-for-code", "kimi-code", "kimi-for-coding"],
    groupBrands: ["Kimi Code (CN)", "Kimi Code"],
    rowKeys: ["weekly", "limit.*"],
    // Each region has its own key; the legacy ids (`kimi`, `kimi-code`, ...) belong to CN.
    apiKey: {
      displayName: "Kimi",
      envVars: ["KIMI_CN_API_KEY", "KIMI_API_KEY", "KIMI_CODE_API_KEY"],
      providerKeys: ["kimi-code-plan-cn", "kimi-for-coding", "kimi-code", "kimi"],
    },
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    runtimeIds: ["deepseek"],
    synonyms: ["deep-seek"],
    rowKeys: ["total_balance.*", "granted_balance.*", "topped_up_balance.*", "available"],
    apiKey: {
      envVars: ["DEEPSEEK_API_KEY"],
      providerKeys: ["deepseek"],
      skipBrokenLogins: true,
    },
  },
  {
    id: "xai",
    label: "xAI",
    runtimeIds: ["xai"],
    synonyms: [],
    rowKeys: ["credits"],
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
    rowKeys: ["monthly_tokens", "total_balance", "cash_balance", "gift_balance"],
  },
  {
    id: "opencode-go",
    label: "OpenCode Go",
    runtimeIds: ["opencode-go"],
    synonyms: ["opencode-go-subscription"],
    rowKeys: ["five_hour", "weekly", "monthly"],
    // `opencode-go` is what `opencode auth login opencode-go` writes; `opencode` stays as a
    // fallback alias for older manual setups. Key logins only: the active `opencode` login is
    // usually the OpenCode Console sign-in, and resolving it could refresh its token for nothing.
    apiKey: {
      envVars: ["OPENCODE_API_KEY"],
      providerKeys: ["opencode-go", "opencode"],
      keyLoginsOnly: true,
      unsupportedTypeError: "OpenCode Go auth entry has unsupported type",
    },
  },
  {
    id: "opencode",
    label: "OpenCode Zen",
    runtimeIds: ["opencode", "opencode-zen"],
    synonyms: ["opencode-zen"],
    rowKeys: ["monthly", "balance", "auto_reload"],
  },
  {
    id: "ollama-cloud",
    label: "Ollama Cloud",
    runtimeIds: ["ollama-cloud"],
    synonyms: [],
    rowKeys: ["session", "weekly", "monthly", "purchased"],
    apiKey: {
      envVars: ["OLLAMA_API_KEY"],
      providerKeys: ["ollama-cloud"],
      skipBrokenLogins: true,
    },
  },
  {
    id: "quota-providers",
    label: "Custom providers",
    runtimeIds: [],
    synonyms: [],
    rowKeys: ["custom.*.*"],
  },
] as const satisfies readonly QuotaProviderRegistrationSourceEntry[];

export type CanonicalQuotaProviderId = (typeof QUOTA_PROVIDER_REGISTRATION_SOURCE)[number]["id"];
