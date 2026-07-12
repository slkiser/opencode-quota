export const VALID_CUSTOM_SOURCE_INPUTS = [
  {
    id: "openrouter-primary",
    providerId: "openrouter",
    label: "OpenRouter Primary",
    url: "https://openrouter.ai/api/v1/key",
    preset: "openrouter-key-v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    modelIds: ["openrouter/anthropic/claude-sonnet-4", "openrouter/openai/gpt-5"],
  },
  {
    id: "internal-accounting",
    providerId: "internal_gateway",
    url: "http://gateway.internal/accounting",
    preset: "accounting-v1",
  },
] as const;

export const VALID_CUSTOM_SOURCES = [
  {
    ...VALID_CUSTOM_SOURCE_INPUTS[0],
    modelIds: [...VALID_CUSTOM_SOURCE_INPUTS[0].modelIds],
  },
  {
    ...VALID_CUSTOM_SOURCE_INPUTS[1],
    label: "internal-accounting",
  },
] as const;

export function customSource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "source-one",
    providerId: "provider-one",
    label: "Source One",
    url: "https://provider.example/accounting",
    preset: "accounting-v1",
    ...overrides,
  };
}
