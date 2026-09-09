import {
  createProviderApiKeyResolver,
  getGlobalOpencodeConfigCandidatePaths,
} from "./api-key-resolver.js";
import { getCredentialDatabasePaths, readAuthFile } from "./opencode-auth.js";

export interface ChutesApiKeyResult {
  key: string;
  source: ChutesKeySource;
}

const ALLOWED_CHUTES_ENV_VARS = ["CHUTES_API_KEY"] as const;
const CHUTES_PROVIDER_KEYS = ["chutes"] as const;

export type ChutesKeySource =
  | "env:CHUTES_API_KEY"
  | "opencode.json"
  | "opencode.jsonc"
  | "opencode.db";

export { getGlobalOpencodeConfigCandidatePaths as getOpencodeConfigCandidatePaths } from "./api-key-resolver.js";

const chutesApiKeyResolver = createProviderApiKeyResolver<ChutesKeySource>({
  envVars: [{ name: "CHUTES_API_KEY", source: "env:CHUTES_API_KEY" }],
  providerKeys: CHUTES_PROVIDER_KEYS,
  allowedEnvVars: ALLOWED_CHUTES_ENV_VARS,
  configJsonSource: "opencode.json",
  configJsoncSource: "opencode.jsonc",
  getConfigCandidates: getGlobalOpencodeConfigCandidatePaths,
  auth: {
    readAuth: readAuthFile,
    getCredentialDatabasePaths,
    authSource: "opencode.db",
  },
});

export async function resolveChutesApiKey(): Promise<ChutesApiKeyResult | null> {
  return chutesApiKeyResolver.resolve();
}

export async function hasChutesApiKey(): Promise<boolean> {
  return chutesApiKeyResolver.has();
}

export async function getChutesKeyDiagnostics(): Promise<{
  configured: boolean;
  source: ChutesKeySource | null;
  checkedPaths: string[];
  credentialDatabasePaths: string[];
}> {
  return chutesApiKeyResolver.diagnostics();
}
