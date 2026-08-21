import {
  createProviderApiKeyResolver,
  getGlobalOpencodeConfigCandidatePaths,
} from "./api-key-resolver.js";
import { getCredentialDatabasePaths, readAuthFile } from "./opencode-auth.js";

export interface SyntheticApiKeyResult {
  key: string;
  source: SyntheticKeySource;
}

const ALLOWED_SYNTHETIC_ENV_VARS = ["SYNTHETIC_API_KEY"] as const;
const SYNTHETIC_PROVIDER_KEYS = ["synthetic"] as const;

export type SyntheticKeySource =
  | "env:SYNTHETIC_API_KEY"
  | "opencode.json"
  | "opencode.jsonc"
  | "opencode.db";

export { getGlobalOpencodeConfigCandidatePaths as getOpencodeConfigCandidatePaths } from "./api-key-resolver.js";

const syntheticApiKeyResolver = createProviderApiKeyResolver<SyntheticKeySource>({
  envVars: [{ name: "SYNTHETIC_API_KEY", source: "env:SYNTHETIC_API_KEY" }],
  providerKeys: SYNTHETIC_PROVIDER_KEYS,
  allowedEnvVars: ALLOWED_SYNTHETIC_ENV_VARS,
  configJsonSource: "opencode.json",
  configJsoncSource: "opencode.jsonc",
  getConfigCandidates: getGlobalOpencodeConfigCandidatePaths,
  auth: {
    readAuth: readAuthFile,
    getCredentialDatabasePaths,
    authSource: "opencode.db",
  },
});

export async function resolveSyntheticApiKey(): Promise<SyntheticApiKeyResult | null> {
  return syntheticApiKeyResolver.resolve();
}

export async function hasSyntheticApiKey(): Promise<boolean> {
  return syntheticApiKeyResolver.has();
}

export async function getSyntheticKeyDiagnostics(): Promise<{
  configured: boolean;
  source: SyntheticKeySource | null;
  checkedPaths: string[];
  credentialDatabasePaths: string[];
}> {
  return syntheticApiKeyResolver.diagnostics();
}
