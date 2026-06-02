import { getAuthPaths, readAuthFile } from "./opencode-auth.js";
import {
  createProviderApiKeyResolver,
  getGlobalOpencodeConfigCandidatePaths,
} from "./api-key-resolver.js";

export interface LiteLLMApiKeyResult {
  key: string;
  source: LiteLLMKeySource;
}

const ALLOWED_LITELLM_ENV_VARS = ["LITELLM_API_KEY", "LITELLM_KEY"] as const;
const LITELLM_PROVIDER_KEYS = ["litellm"] as const;

export type LiteLLMKeySource =
  | "env:LITELLM_API_KEY"
  | "env:LITELLM_KEY"
  | "opencode.json"
  | "opencode.jsonc"
  | "auth.json";

export { getGlobalOpencodeConfigCandidatePaths as getOpencodeConfigCandidatePaths } from "./api-key-resolver.js";

const litellmApiKeyResolver = createProviderApiKeyResolver<LiteLLMKeySource>({
  envVars: [
    { name: "LITELLM_API_KEY", source: "env:LITELLM_API_KEY" },
    { name: "LITELLM_KEY", source: "env:LITELLM_KEY" },
  ],
  providerKeys: LITELLM_PROVIDER_KEYS,
  allowedEnvVars: ALLOWED_LITELLM_ENV_VARS,
  configJsonSource: "opencode.json",
  configJsoncSource: "opencode.jsonc",
  getConfigCandidates: getGlobalOpencodeConfigCandidatePaths,
  auth: {
    readAuth: readAuthFile,
    authSource: "auth.json",
  },
});

export async function resolveLiteLLMApiKey(): Promise<LiteLLMApiKeyResult | null> {
  return litellmApiKeyResolver.resolve();
}

export async function hasLiteLLMApiKey(): Promise<boolean> {
  return litellmApiKeyResolver.has();
}

export async function getLiteLLMKeyDiagnostics(): Promise<{
  configured: boolean;
  source: LiteLLMKeySource | null;
  checkedPaths: string[];
  authPaths: string[];
}> {
  return {
    ...(await litellmApiKeyResolver.diagnostics()),
    authPaths: getAuthPaths(),
  };
}
