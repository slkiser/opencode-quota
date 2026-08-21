import {
  createProviderApiKeyResolver,
  getGlobalOpencodeConfigCandidatePaths,
} from "./api-key-resolver.js";
import { getCredentialDatabasePaths, readAuthFile } from "./opencode-auth.js";

export interface NanoGptApiKeyResult {
  key: string;
  source: NanoGptKeySource;
}

const ALLOWED_NANOGPT_ENV_VARS = ["NANOGPT_API_KEY", "NANO_GPT_API_KEY"] as const;
const NANOGPT_PROVIDER_KEYS = ["nanogpt", "nano-gpt"] as const;

export type NanoGptKeySource =
  | "env:NANOGPT_API_KEY"
  | "env:NANO_GPT_API_KEY"
  | "opencode.json"
  | "opencode.jsonc"
  | "opencode.db";

export { getGlobalOpencodeConfigCandidatePaths as getOpencodeConfigCandidatePaths } from "./api-key-resolver.js";

const nanoGptApiKeyResolver = createProviderApiKeyResolver<NanoGptKeySource>({
  envVars: [
    { name: "NANOGPT_API_KEY", source: "env:NANOGPT_API_KEY" },
    { name: "NANO_GPT_API_KEY", source: "env:NANO_GPT_API_KEY" },
  ],
  providerKeys: NANOGPT_PROVIDER_KEYS,
  allowedEnvVars: ALLOWED_NANOGPT_ENV_VARS,
  configJsonSource: "opencode.json",
  configJsoncSource: "opencode.jsonc",
  getConfigCandidates: getGlobalOpencodeConfigCandidatePaths,
  auth: {
    readAuth: readAuthFile,
    getCredentialDatabasePaths,
    authSource: "opencode.db",
  },
});

export async function resolveNanoGptApiKey(): Promise<NanoGptApiKeyResult | null> {
  return nanoGptApiKeyResolver.resolve();
}

export async function hasNanoGptApiKey(): Promise<boolean> {
  return nanoGptApiKeyResolver.has();
}

export async function getNanoGptKeyDiagnostics(): Promise<{
  configured: boolean;
  source: NanoGptKeySource | null;
  checkedPaths: string[];
  credentialDatabasePaths: string[];
}> {
  return nanoGptApiKeyResolver.diagnostics();
}
