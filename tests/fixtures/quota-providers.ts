export const VALID_QUOTA_PROVIDER_INPUTS = [
  {
    id: "openrouter-primary",
    providerId: "openrouter",
    label: "OpenRouter Primary",
    mode: "remote-api",
    url: "https://openrouter.ai/api/v1/key",
    format: "openrouter-key-v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    modelIds: ["anthropic/claude-sonnet-4", "openai/gpt-5"],
  },
  {
    id: "internal-accounting",
    mode: "remote-api",
    url: "https://gateway.internal/accounting",
    format: "quota-v1",
  },
] as const;

export const VALID_QUOTA_PROVIDERS = [
  {
    ...VALID_QUOTA_PROVIDER_INPUTS[0],
    modelIds: [...VALID_QUOTA_PROVIDER_INPUTS[0].modelIds],
  },
  {
    ...VALID_QUOTA_PROVIDER_INPUTS[1],
    providerId: "internal-accounting",
    label: "internal-accounting",
  },
] as const;

export function quotaProvider(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "provider-one",
    label: "Provider One",
    mode: "remote-api",
    url: "https://provider.example/accounting",
    format: "quota-v1",
    ...overrides,
  };
}

export function localQuotaProvider(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "local-provider",
    label: "Local Provider",
    mode: "local-estimate",
    windows: [
      {
        id: "daily",
        type: "utc-day",
        requestLimit: 1000,
      },
    ],
    ...overrides,
  };
}
