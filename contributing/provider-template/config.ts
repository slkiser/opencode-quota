/**
 * Template target: src/lib/<provider>-config.ts
 *
 * Purpose: resolve an API key/token from trusted sources for a provider whose
 * README setup wording is "Existing OpenCode auth, global config, or env".
 *
 * Copy this file, then replace every example placeholder with the real provider
 * name, ids, env vars, and config keys.
 */

import {
  getApiKeyDiagnostics,
  getGlobalOpencodeConfigCandidatePaths,
  resolveProviderApiKey,
} from "./api-key-resolver.js";
import { readAuthFile } from "./opencode-auth.js";

const ENV_KEYS = ["EXAMPLE_PROVIDER_API_KEY"] as const;
const PROVIDER_KEYS = ["example-provider", "exampleProvider"] as const;

export type ExampleProviderKeySource =
  | "env:EXAMPLE_PROVIDER_API_KEY"
  | "opencode.json"
  | "opencode.jsonc"
  | "opencode.db";

export interface ExampleProviderApiKeyResult {
  key: string;
  source: ExampleProviderKeySource;
}

export async function resolveExampleProviderApiKey(): Promise<ExampleProviderApiKeyResult | null> {
  return resolveProviderApiKey<ExampleProviderKeySource>({
    envVars: [{ name: "EXAMPLE_PROVIDER_API_KEY", source: "env:EXAMPLE_PROVIDER_API_KEY" }],
    providerKeys: PROVIDER_KEYS,
    allowedEnvVars: ENV_KEYS,
    configJsonSource: "opencode.json",
    configJsoncSource: "opencode.jsonc",
    getConfigCandidates: getGlobalOpencodeConfigCandidatePaths,
    auth: {
      readAuth: readAuthFile,
      authSource: "opencode.db",
    },
  });
}

export async function hasExampleProviderApiKey(): Promise<boolean> {
  return (await resolveExampleProviderApiKey()) !== null;
}

export async function getExampleProviderKeyDiagnostics(): Promise<{
  configured: boolean;
  source: ExampleProviderKeySource | null;
  checkedPaths: string[];
}> {
  return getApiKeyDiagnostics<ExampleProviderKeySource>({
    envVarNames: ["EXAMPLE_PROVIDER_API_KEY"],
    resolve: resolveExampleProviderApiKey,
    getConfigCandidates: getGlobalOpencodeConfigCandidatePaths,
  });
}
