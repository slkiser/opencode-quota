/**
 * Synthetic API key configuration resolver
 *
 * Resolution priority (first wins):
 * 1. Environment variable: SYNTHETIC_API_KEY
 * 2. User/global opencode.json/opencode.jsonc: provider.synthetic.options.apiKey
 *    - Supports {env:SYNTHETIC_API_KEY} syntax for environment variable references
 * 3. auth.json: synthetic.key (legacy/fallback)
 */

import { readAuthFile } from "./opencode-auth.js";
import {
  extractAuthApiKeyEntry,
  extractProviderOptionsApiKey,
  getApiKeyDiagnostics,
  getGlobalOpencodeConfigCandidatePaths,
  resolveApiKey,
} from "./api-key-resolver.js";

/** Result of Synthetic API key resolution */
export interface SyntheticApiKeyResult {
  key: string;
  source: SyntheticKeySource;
}

const ALLOWED_SYNTHETIC_ENV_VARS = ["SYNTHETIC_API_KEY"] as const;
const SYNTHETIC_PROVIDER_KEYS = ["synthetic"] as const;

/** Source of the resolved API key */
export type SyntheticKeySource =
  | "env:SYNTHETIC_API_KEY"
  | "opencode.json"
  | "opencode.jsonc"
  | "auth.json";

// Re-export for consumers that need path info
export { getGlobalOpencodeConfigCandidatePaths as getOpencodeConfigCandidatePaths } from "./api-key-resolver.js";

/**
 * Resolve Synthetic API key from all available sources.
 *
 * Priority (first wins):
 * 1. Environment variable: SYNTHETIC_API_KEY
 * 2. User/global opencode.json/opencode.jsonc: provider.synthetic.options.apiKey
 * 3. auth.json: synthetic.key
 *
 * @returns API key and source, or null if not found
 */
export async function resolveSyntheticApiKey(): Promise<SyntheticApiKeyResult | null> {
  return resolveApiKey<SyntheticKeySource>(
    {
      envVars: [{ name: "SYNTHETIC_API_KEY", source: "env:SYNTHETIC_API_KEY" }],
      extractFromConfig: (config) =>
        extractProviderOptionsApiKey(config, {
          providerKeys: SYNTHETIC_PROVIDER_KEYS,
          allowedEnvVars: ALLOWED_SYNTHETIC_ENV_VARS,
        }),
      configJsonSource: "opencode.json",
      configJsoncSource: "opencode.jsonc",
      extractFromAuth: (auth) => extractAuthApiKeyEntry(auth, SYNTHETIC_PROVIDER_KEYS),
      authSource: "auth.json",
      getConfigCandidates: getGlobalOpencodeConfigCandidatePaths,
    },
    readAuthFile,
  );
}

/**
 * Check if a Synthetic API key is configured
 */
export async function hasSyntheticApiKey(): Promise<boolean> {
  const result = await resolveSyntheticApiKey();
  return result !== null;
}

/**
 * Get diagnostic info about Synthetic API key configuration
 */
export async function getSyntheticKeyDiagnostics(): Promise<{
  configured: boolean;
  source: SyntheticKeySource | null;
  checkedPaths: string[];
}> {
  return getApiKeyDiagnostics<SyntheticKeySource>({
    envVarNames: ["SYNTHETIC_API_KEY"],
    resolve: resolveSyntheticApiKey,
    getConfigCandidates: getGlobalOpencodeConfigCandidatePaths,
  });
}
