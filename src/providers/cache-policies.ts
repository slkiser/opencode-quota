import {
  DEFAULT_ALIBABA_AUTH_CACHE_MAX_AGE_MS,
  resolveAlibabaCodingPlanAuthCached,
} from "../lib/alibaba-auth.js";
import { resolveAnthropicAuthIdentity } from "../lib/anthropic.js";
import { resolveChutesApiKey } from "../lib/chutes-config.js";
import { resolveCopilotAuthIdentity } from "../lib/copilot.js";
import { resolveDeepSeekApiKey } from "../lib/deepseek-auth.js";
import type { QuotaProviderCachePolicy } from "../lib/entries.js";
import { resolveGoogleAntigravityAuthIdentity } from "../lib/google.js";
import { resolveGoogleAgyAuthIdentity } from "../lib/google-agy.js";
import { resolveGeminiCliAuthIdentity } from "../lib/google-gemini-cli.js";
import { resolveKiloApiKey } from "../lib/kilo-config.js";
import { DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS, resolveKimiAuthCached } from "../lib/kimi-auth.js";
import {
  DEFAULT_MIMO_CONFIG_CACHE_MAX_AGE_MS,
  resolveMimoConfigCached,
} from "../lib/mimo-config.js";
import {
  DEFAULT_MINIMAX_AUTH_CACHE_MAX_AGE_MS,
  resolveMiniMaxAuthCached,
  resolveMiniMaxChinaAuthCached,
} from "../lib/minimax-auth.js";
import { resolveNanoGptApiKey } from "../lib/nanogpt-config.js";
import { resolveOllamaCloudApiKey } from "../lib/ollama-cloud-config.js";
import { resolveOpenAIAuthIdentity } from "../lib/openai.js";
import {
  DEFAULT_OPENCODE_GO_AUTH_CACHE_MAX_AGE_MS,
  resolveOpenCodeGoAuthCached,
} from "../lib/opencode-go-auth.js";
import {
  DEFAULT_OPENCODE_ZEN_CONFIG_CACHE_MAX_AGE_MS,
  resolveOpenCodeZenConfigCached,
} from "../lib/opencode-zen-config.js";
import { resolveOpenRouterAuthIdentity } from "../lib/openrouter.js";
import type { CanonicalQuotaProviderId } from "../lib/provider-registration.js";
import type {
  QuotaProviderDefinition,
  RemoteApiQuotaProviderDefinition,
} from "../lib/quota-providers.js";
import { resolveQuotaProviderApiKey } from "../lib/quota-providers-remote.js";
import {
  composeResolvedAuthIdentities,
  deriveResolvedAuthIdentity,
  type ResolvedAuthIdentity,
} from "../lib/resolved-auth-identity.js";
import { resolveSyntheticApiKey } from "../lib/synthetic-config.js";
import { resolveXaiAuthIdentity } from "../lib/xai.js";
import { DEFAULT_ZAI_AUTH_CACHE_MAX_AGE_MS, resolveZaiAuthCached } from "../lib/zai-auth.js";
import { DEFAULT_ZHIPU_AUTH_CACHE_MAX_AGE_MS, resolveZhipuAuthCached } from "../lib/zhipu-auth.js";

const UNCACHED = { kind: "uncached" } as const satisfies QuotaProviderCachePolicy;

type ResolvedCredential = {
  credential: string;
  principalKind?: "stable-id" | "credential";
  qualifiers?: readonly string[];
};

function resolvedCredentialPolicy(
  providerId: CanonicalQuotaProviderId,
  resolve: () => Promise<ResolvedCredential | null>,
): QuotaProviderCachePolicy {
  return {
    kind: "resolved-auth",
    async resolveIdentity() {
      const resolved = await resolve();
      if (!resolved) return null;
      return deriveResolvedAuthIdentity({
        providerId,
        principal: {
          kind: resolved.principalKind ?? "credential",
          value: resolved.credential,
        },
        qualifiers: resolved.qualifiers,
      });
    },
  };
}

export async function resolveQuotaProviderDefinitionAuthIdentity(
  definition: QuotaProviderDefinition,
): Promise<ResolvedAuthIdentity | null> {
  if (definition.mode === "local-estimate") {
    return deriveResolvedAuthIdentity({
      providerId: `quota-providers:${definition.id}`,
      principal: { kind: "stable-id", value: "local-estimate" },
    });
  }

  const resolved = await resolveQuotaProviderApiKey(definition as RemoteApiQuotaProviderDefinition);
  return deriveResolvedAuthIdentity({
    providerId: `quota-providers:${definition.id}`,
    principal: resolved.key
      ? { kind: "credential", value: resolved.key }
      : { kind: "stable-id", value: "missing-credential" },
    qualifiers: [definition.providerId],
  });
}

const quotaProvidersCachePolicy: QuotaProviderCachePolicy = {
  kind: "resolved-auth",
  async resolveIdentity(_ctx, cacheContext) {
    const definitions = cacheContext.runtimeEligibleQuotaProviders;
    if (!definitions || definitions.length === 0) return null;

    const identities = await Promise.all(
      definitions.map(resolveQuotaProviderDefinitionAuthIdentity),
    );
    if (identities.some((identity) => identity === null)) return null;

    return composeResolvedAuthIdentities({
      providerId: "quota-providers",
      identities: identities as ResolvedAuthIdentity[],
    });
  },
};

export const PROVIDER_CACHE_POLICIES = {
  anthropic: {
    kind: "resolved-auth",
    resolveIdentity: (ctx) =>
      resolveAnthropicAuthIdentity({ binaryPath: ctx.config.anthropicBinaryPath }),
  },
  copilot: {
    kind: "resolved-auth",
    resolveIdentity: () => resolveCopilotAuthIdentity(),
  },
  openai: {
    kind: "resolved-auth",
    resolveIdentity: () => resolveOpenAIAuthIdentity(),
  },
  openrouter: {
    kind: "resolved-auth",
    resolveIdentity: () => resolveOpenRouterAuthIdentity(),
  },
  kilo: resolvedCredentialPolicy("kilo", async () => {
    const resolved = await resolveKiloApiKey();
    return resolved ? { credential: resolved.key } : null;
  }),
  cursor: UNCACHED,
  "qwen-code": UNCACHED,
  "alibaba-coding-plan": resolvedCredentialPolicy("alibaba-coding-plan", async () => {
    const resolved = await resolveAlibabaCodingPlanAuthCached({
      maxAgeMs: DEFAULT_ALIBABA_AUTH_CACHE_MAX_AGE_MS,
    });
    return resolved.state === "configured"
      ? { credential: resolved.apiKey, qualifiers: [resolved.tier] }
      : null;
  }),
  synthetic: resolvedCredentialPolicy("synthetic", async () => {
    const resolved = await resolveSyntheticApiKey();
    return resolved ? { credential: resolved.key } : null;
  }),
  chutes: resolvedCredentialPolicy("chutes", async () => {
    const resolved = await resolveChutesApiKey();
    return resolved ? { credential: resolved.key } : null;
  }),
  "google-antigravity": {
    kind: "resolved-auth",
    resolveIdentity: () => resolveGoogleAntigravityAuthIdentity(),
  },
  "google-gemini-cli": {
    kind: "resolved-auth",
    resolveIdentity: (ctx) => resolveGeminiCliAuthIdentity(ctx.client),
  },
  "google-agy": {
    kind: "resolved-auth",
    resolveIdentity: (ctx) => resolveGoogleAgyAuthIdentity(ctx.client),
  },
  zai: resolvedCredentialPolicy("zai", async () => {
    const resolved = await resolveZaiAuthCached({ maxAgeMs: DEFAULT_ZAI_AUTH_CACHE_MAX_AGE_MS });
    return resolved.state === "configured" ? { credential: resolved.apiKey } : null;
  }),
  zhipu: resolvedCredentialPolicy("zhipu", async () => {
    const resolved = await resolveZhipuAuthCached({
      maxAgeMs: DEFAULT_ZHIPU_AUTH_CACHE_MAX_AGE_MS,
    });
    return resolved.state === "configured" ? { credential: resolved.apiKey } : null;
  }),
  nanogpt: resolvedCredentialPolicy("nanogpt", async () => {
    const resolved = await resolveNanoGptApiKey();
    return resolved ? { credential: resolved.key } : null;
  }),
  "minimax-coding-plan": resolvedCredentialPolicy("minimax-coding-plan", async () => {
    const resolved = await resolveMiniMaxAuthCached({
      maxAgeMs: DEFAULT_MINIMAX_AUTH_CACHE_MAX_AGE_MS,
    });
    return resolved.state === "configured"
      ? { credential: resolved.apiKey, qualifiers: [resolved.endpoint] }
      : null;
  }),
  "minimax-china-coding-plan": resolvedCredentialPolicy("minimax-china-coding-plan", async () => {
    const resolved = await resolveMiniMaxChinaAuthCached({
      maxAgeMs: DEFAULT_MINIMAX_AUTH_CACHE_MAX_AGE_MS,
    });
    return resolved.state === "configured"
      ? { credential: resolved.apiKey, qualifiers: [resolved.endpoint] }
      : null;
  }),
  "kimi-for-coding": resolvedCredentialPolicy("kimi-for-coding", async () => {
    const resolved = await resolveKimiAuthCached({ maxAgeMs: DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS });
    return resolved.state === "configured" ? { credential: resolved.apiKey } : null;
  }),
  deepseek: resolvedCredentialPolicy("deepseek", async () => {
    const resolved = await resolveDeepSeekApiKey();
    return resolved ? { credential: resolved.key } : null;
  }),
  xai: {
    kind: "resolved-auth",
    resolveIdentity: () => resolveXaiAuthIdentity(),
  },
  xiaomi: resolvedCredentialPolicy("xiaomi", async () => {
    const resolved = await resolveMimoConfigCached({
      maxAgeMs: DEFAULT_MIMO_CONFIG_CACHE_MAX_AGE_MS,
    });
    return resolved.state === "configured" ? { credential: resolved.config.cookie } : null;
  }),
  "opencode-go": resolvedCredentialPolicy("opencode-go", async () => {
    const resolved = await resolveOpenCodeGoAuthCached({
      maxAgeMs: DEFAULT_OPENCODE_GO_AUTH_CACHE_MAX_AGE_MS,
    });
    return resolved.state === "configured" ? { credential: resolved.apiKey } : null;
  }),
  opencode: resolvedCredentialPolicy("opencode", async () => {
    const resolved = await resolveOpenCodeZenConfigCached({
      maxAgeMs: DEFAULT_OPENCODE_ZEN_CONFIG_CACHE_MAX_AGE_MS,
    });
    return resolved.state === "configured"
      ? {
          credential: resolved.config.workspaceId,
          principalKind: "stable-id",
        }
      : null;
  }),
  "ollama-cloud": resolvedCredentialPolicy("ollama-cloud", async () => {
    const resolved = await resolveOllamaCloudApiKey();
    return resolved ? { credential: resolved.key } : null;
  }),
  "quota-providers": quotaProvidersCachePolicy,
} satisfies Record<CanonicalQuotaProviderId, QuotaProviderCachePolicy>;
