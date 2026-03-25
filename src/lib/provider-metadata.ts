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
};

export function normalizeQuotaProviderId(id: string): string {
  const normalized = id.trim().toLowerCase();
  return QUOTA_PROVIDER_ID_SYNONYMS[normalized] ?? normalized;
}

export function getQuotaProviderDisplayLabel(id: string): string {
  return QUOTA_PROVIDER_LABELS[id] ?? id;
}
