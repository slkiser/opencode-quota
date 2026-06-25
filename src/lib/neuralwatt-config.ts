import { readAuthFile } from "./opencode-auth.js";
import {
  getApiKeyDiagnostics,
  getGlobalOpencodeConfigCandidatePaths,
  resolveProviderApiKey,
} from "./api-key-resolver.js";

const ENV_KEYS = ["NEURALWATT_API_KEY"] as const;
const PROVIDER_KEYS = ["neuralwatt"] as const;

export type NeuralwattKeySource =
  | "env:NEURALWATT_API_KEY"
  | "opencode.json"
  | "opencode.jsonc"
  | "auth.json";

export interface NeuralwattApiKeyResult {
  key: string;
  source: NeuralwattKeySource;
}

export async function resolveNeuralwattApiKey(): Promise<NeuralwattApiKeyResult | null> {
  return resolveProviderApiKey<NeuralwattKeySource>({
    envVars: [{ name: "NEURALWATT_API_KEY", source: "env:NEURALWATT_API_KEY" }],
    providerKeys: PROVIDER_KEYS,
    allowedEnvVars: ENV_KEYS,
    configJsonSource: "opencode.json",
    configJsoncSource: "opencode.jsonc",
    getConfigCandidates: getGlobalOpencodeConfigCandidatePaths,
    auth: {
      readAuth: readAuthFile,
      authSource: "auth.json",
    },
  });
}

export async function hasNeuralwattApiKey(): Promise<boolean> {
  return (await resolveNeuralwattApiKey()) !== null;
}

export async function getNeuralwattKeyDiagnostics(): Promise<{
  configured: boolean;
  source: NeuralwattKeySource | null;
  checkedPaths: string[];
}> {
  return getApiKeyDiagnostics<NeuralwattKeySource>({
    envVarNames: ["NEURALWATT_API_KEY"],
    resolve: resolveNeuralwattApiKey,
    getConfigCandidates: getGlobalOpencodeConfigCandidatePaths,
  });
}
