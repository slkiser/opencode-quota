import { createHash } from "node:crypto";
import type { QuotaProvider, QuotaProviderContext } from "../lib/entries.js";
import { loadCustomQuotaDefinitions } from "../lib/quota-provider-config.js";
import {
  createProviderApiKeyResolver,
  getGlobalOpencodeConfigCandidatePaths,
} from "../lib/api-key-resolver.js";
import { readAuthFile } from "../lib/opencode-auth.js";
import { fetchRemoteQuota } from "../lib/quota-providers-remote.js";
import { createResolvedAuthCachePolicy } from "./account-cache.js";
import { notAttemptedResult } from "./result-helpers.js";
async function select(id: string, ctx: QuotaProviderContext) {
  const definition = loadCustomQuotaDefinitions().definitions.find((item) => item.id === id);
  if (!definition) return null;
  const resolved = await createProviderApiKeyResolver<string>({
    envVars: definition.apiKeyEnv ? [{ name: definition.apiKeyEnv, source: "env" }] : [],
    providerKeys: [definition.providerId],
    allowedEnvVars: definition.apiKeyEnv ? [definition.apiKeyEnv] : [],
    getConfigCandidates: getGlobalOpencodeConfigCandidatePaths,
    configJsonSource: "opencode.json",
    configJsoncSource: "opencode.jsonc",
    auth: { readAuth: readAuthFile, authKeys: [definition.providerId], authSource: "auth.json" },
  }).resolve();
  if (!resolved) return null;
  const key = resolved.key;
  return {
    credential: key,
    qualifiers: [createHash("sha256").update(JSON.stringify(definition)).digest("hex")],
    fetch: () => fetchRemoteQuota(definition, key, ctx.config.requestTimeoutMs),
  };
}
/** Re-resolve definitions at selection time so removal cannot leave an old endpoint active. */
export function getCustomQuotaProviders(): QuotaProvider[] {
  return loadCustomQuotaDefinitions().definitions.map((def) => ({
    id: def.id,
    cachePolicy: createResolvedAuthCachePolicy(def.id, (ctx) => select(def.id, ctx)),
    isAvailable: async (ctx) => Boolean(await select(def.id, ctx)),
    matchesCurrentModel: (model) => {
      const current = loadCustomQuotaDefinitions().definitions.find((item) => item.id === def.id);
      if (!current || !model.startsWith(`${current.providerId}/`)) return false;
      return (
        !current.modelIds || current.modelIds.includes(model.slice(current.providerId.length + 1))
      );
    },
    async fetch(ctx) {
      const selected = await select(def.id, ctx);
      return selected ? selected.fetch() : notAttemptedResult();
    },
  }));
}
