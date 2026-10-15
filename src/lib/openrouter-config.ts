import { getAuthPaths, readAuthFile } from "./opencode-auth.js";
import {
  createProviderApiKeyResolver,
  getGlobalOpencodeConfigCandidatePaths,
} from "./api-key-resolver.js";

export interface OpenRouterApiKeyResult {
  key: string;
  source: OpenRouterKeySource;
}

const ALLOWED_OPENROUTER_ENV_VARS = ["OPENROUTER_API_KEY"] as const;
const OPENROUTER_PROVIDER_KEYS = ["openrouter"] as const;

export type OpenRouterKeySource =
  | "env:OPENROUTER_API_KEY"
  | "opencode.json"
  | "opencode.jsonc"
  | "auth.json";

export { getGlobalOpencodeConfigCandidatePaths as getOpencodeConfigCandidatePaths } from "./api-key-resolver.js";

const openrouterApiKeyResolver = createProviderApiKeyResolver<OpenRouterKeySource>({
  envVars: [{ name: "OPENROUTER_API_KEY", source: "env:OPENROUTER_API_KEY" }],
  providerKeys: OPENROUTER_PROVIDER_KEYS,
  allowedEnvVars: ALLOWED_OPENROUTER_ENV_VARS,
  configJsonSource: "opencode.json",
  configJsoncSource: "opencode.jsonc",
  getConfigCandidates: getGlobalOpencodeConfigCandidatePaths,
  auth: {
    readAuth: readAuthFile,
    authSource: "auth.json",
  },
});

export async function resolveOpenRouterApiKey(): Promise<OpenRouterApiKeyResult | null> {
  return openrouterApiKeyResolver.resolve();
}

export async function hasOpenRouterApiKey(): Promise<boolean> {
  return openrouterApiKeyResolver.has();
}

export async function getOpenRouterKeyDiagnostics(): Promise<{
  configured: boolean;
  source: OpenRouterKeySource | null;
  checkedPaths: string[];
  authPaths: string[];
}> {
  return {
    ...(await openrouterApiKeyResolver.diagnostics()),
    authPaths: getAuthPaths(),
  };
}
