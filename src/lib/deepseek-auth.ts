import { getAuthPaths, readAuthFile } from "./opencode-auth.js";
import {
  createProviderApiKeyResolver,
  getGlobalOpencodeConfigCandidatePaths,
} from "./api-key-resolver.js";

export interface DeepSeekApiKeyResult {
  key: string;
  source: DeepSeekKeySource;
}

const ALLOWED_DEEPSEEK_ENV_VARS = ["DEEPSEEK_API_KEY"] as const;
const DEEPSEEK_PROVIDER_KEYS = ["deepseek"] as const;

export type DeepSeekKeySource =
  | "env:DEEPSEEK_API_KEY"
  | "opencode.json"
  | "opencode.jsonc"
  | "auth.json";

export { getGlobalOpencodeConfigCandidatePaths as getOpencodeConfigCandidatePaths } from "./api-key-resolver.js";

const deepseekApiKeyResolver = createProviderApiKeyResolver<DeepSeekKeySource>({
  envVars: [
    { name: "DEEPSEEK_API_KEY", source: "env:DEEPSEEK_API_KEY" },
  ],
  providerKeys: DEEPSEEK_PROVIDER_KEYS,
  allowedEnvVars: ALLOWED_DEEPSEEK_ENV_VARS,
  configJsonSource: "opencode.json",
  configJsoncSource: "opencode.jsonc",
  getConfigCandidates: getGlobalOpencodeConfigCandidatePaths,
  auth: {
    readAuth: readAuthFile,
    authSource: "auth.json",
  },
});

export async function resolveDeepSeekApiKey(): Promise<DeepSeekApiKeyResult | null> {
  return deepseekApiKeyResolver.resolve();
}

export async function hasDeepSeekApiKey(): Promise<boolean> {
  return deepseekApiKeyResolver.has();
}

export async function getDeepSeekKeyDiagnostics(): Promise<{
  configured: boolean;
  source: DeepSeekKeySource | null;
  checkedPaths: string[];
  authPaths: string[];
}> {
  return {
    ...(await deepseekApiKeyResolver.diagnostics()),
    authPaths: getAuthPaths(),
  };
}
