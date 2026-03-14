export const QUOTA_PROVIDER_LABELS: Readonly<Record<string, string>> = {
  openai: "OpenAI",
  copilot: "Copilot",
  "google-antigravity": "Google",
  firmware: "Firmware",
  chutes: "Chutes",
  "qwen-code": "Qwen",
  "alibaba-coding-plan": "Alibaba Coding Plan",
  zai: "Z.ai",
};

export const QUOTA_PROVIDER_ID_SYNONYMS: Readonly<Record<string, string>> = {
  "github-copilot": "copilot",
  "copilot-chat": "copilot",
  "github-copilot-chat": "copilot",
  qwen: "qwen-code",
  alibaba: "alibaba-coding-plan",
};

export function normalizeQuotaProviderId(id: string): string {
  const normalized = id.trim().toLowerCase();
  return QUOTA_PROVIDER_ID_SYNONYMS[normalized] ?? normalized;
}

export function getQuotaProviderDisplayLabel(id: string): string {
  return QUOTA_PROVIDER_LABELS[id] ?? id;
}
