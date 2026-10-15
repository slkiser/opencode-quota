import { getAuthPaths, readAuthFile } from "./opencode-auth.js";
import {
  createProviderApiKeyResolver,
  getGlobalOpencodeConfigCandidatePaths,
} from "./api-key-resolver.js";

export interface KiloApiKeyResult {
  key: string;
  source: KiloKeySource;
}

const ALLOWED_KILO_ENV_VARS = ["KILO_API_KEY"] as const;
const KILO_PROVIDER_KEYS = ["kilo"] as const;

export type KiloKeySource = "env:KILO_API_KEY" | "opencode.json" | "opencode.jsonc" | "auth.json";

export { getGlobalOpencodeConfigCandidatePaths as getOpencodeConfigCandidatePaths } from "./api-key-resolver.js";

const kiloApiKeyResolver = createProviderApiKeyResolver<KiloKeySource>({
  envVars: [{ name: "KILO_API_KEY", source: "env:KILO_API_KEY" }],
  providerKeys: KILO_PROVIDER_KEYS,
  allowedEnvVars: ALLOWED_KILO_ENV_VARS,
  configJsonSource: "opencode.json",
  configJsoncSource: "opencode.jsonc",
  getConfigCandidates: getGlobalOpencodeConfigCandidatePaths,
  auth: {
    readAuth: readAuthFile,
    authSource: "auth.json",
  },
});

export async function resolveKiloApiKey(): Promise<KiloApiKeyResult | null> {
  return kiloApiKeyResolver.resolve();
}

export async function hasKiloApiKey(): Promise<boolean> {
  return kiloApiKeyResolver.has();
}

export async function getKiloKeyDiagnostics(): Promise<{
  configured: boolean;
  source: KiloKeySource | null;
  checkedPaths: string[];
  authPaths: string[];
}> {
  return {
    ...(await kiloApiKeyResolver.diagnostics()),
    authPaths: getAuthPaths(),
  };
}
