import {
  createProviderApiKeyResolver,
  getGlobalOpencodeConfigCandidatePaths,
} from "./api-key-resolver.js";
import { getCredentialDatabasePaths, readAuthFile } from "./opencode-auth.js";

export interface OllamaCloudApiKeyResult {
  key: string;
  source: OllamaCloudKeySource;
}

export type OllamaCloudKeySource =
  | "env:OLLAMA_API_KEY"
  | "opencode.json"
  | "opencode.jsonc"
  | "opencode.db";

export { getGlobalOpencodeConfigCandidatePaths as getOpencodeConfigCandidatePaths } from "./api-key-resolver.js";

const ollamaCloudApiKeyResolver = createProviderApiKeyResolver<OllamaCloudKeySource>({
  envVars: [{ name: "OLLAMA_API_KEY", source: "env:OLLAMA_API_KEY" }],
  providerKeys: ["ollama-cloud"],
  allowedEnvVars: ["OLLAMA_API_KEY"],
  configJsonSource: "opencode.json",
  configJsoncSource: "opencode.jsonc",
  getConfigCandidates: getGlobalOpencodeConfigCandidatePaths,
  auth: {
    readAuth: readAuthFile,
    getCredentialDatabasePaths,
    authSource: "opencode.db",
  },
});

export async function resolveOllamaCloudApiKey(): Promise<OllamaCloudApiKeyResult | null> {
  return ollamaCloudApiKeyResolver.resolve();
}

export async function hasOllamaCloudApiKey(): Promise<boolean> {
  return ollamaCloudApiKeyResolver.has();
}

export async function getOllamaCloudKeyDiagnostics(): Promise<{
  configured: boolean;
  source: OllamaCloudKeySource | null;
  checkedPaths: string[];
  credentialDatabasePaths: string[];
}> {
  return ollamaCloudApiKeyResolver.diagnostics();
}
