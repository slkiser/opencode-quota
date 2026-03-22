/**
 * NanoGPT API key configuration resolver
 *
 * Resolution priority (first wins):
 * 1. Environment variable: NANOGPT_API_KEY
 * 2. User/global opencode.json/opencode.jsonc: provider.nanogpt*.options.apiKey
 *    (supports nanogpt, nanogpt-custom, nano-gpt provider ids)
 * 3. auth.json: "nano-gpt".key
 */

import { resolveEnvTemplate } from "./env-template.js";
import { readAuthFile } from "./opencode-auth.js";
import {
  resolveApiKey,
  getApiKeyDiagnostics,
  getGlobalOpencodeConfigCandidatePaths,
} from "./api-key-resolver.js";

/** Result of NanoGPT API key resolution */
export interface NanoGptApiKeyResult {
  key: string;
  source: NanoGptKeySource;
}

const ALLOWED_NANOGPT_ENV_VARS = ["NANOGPT_API_KEY"] as const;

/** Source of the resolved API key */
export type NanoGptKeySource =
  | "env:NANOGPT_API_KEY"
  | "opencode.json"
  | "opencode.jsonc"
  | "auth.json";

/**
 * Extract NanoGPT API key from trusted opencode config object
 *
 * Looks for: provider.nanogpt.options.apiKey, provider["nanogpt-custom"].options.apiKey,
 * or provider["nano-gpt"].options.apiKey
 */
function extractNanoGptKeyFromConfig(config: unknown): string | null {
  if (!config || typeof config !== "object") return null;

  const root = config as Record<string, unknown>;
  const provider = root.provider;
  if (!provider || typeof provider !== "object") return null;

  const providerObj = provider as Record<string, unknown>;

  // Check multiple possible provider id variants
  const candidateKeys = ["nanogpt", "nanogpt-custom", "nano-gpt"];

  for (const key of candidateKeys) {
    const providerConfig = providerObj[key];
    if (!providerConfig || typeof providerConfig !== "object") continue;

    const options = (providerConfig as Record<string, unknown>).options;
    if (!options || typeof options !== "object") continue;

    const apiKey = (options as Record<string, unknown>).apiKey;
    if (typeof apiKey === "string" && apiKey.trim().length > 0) {
      return resolveEnvTemplate(apiKey.trim(), ALLOWED_NANOGPT_ENV_VARS);
    }
  }

  return null;
}

/**
 * Extract NanoGPT API key from auth.json
 */
function extractNanoGptKeyFromAuth(auth: unknown): string | null {
  if (!auth || typeof auth !== "object") return null;
  const entry = (auth as Record<string, unknown>)["nano-gpt"];
  if (
    entry &&
    typeof entry === "object" &&
    (entry as { type?: string }).type === "api" &&
    typeof (entry as { key?: string }).key === "string" &&
    (entry as { key?: string }).key!.trim().length > 0
  ) {
    return (entry as { key: string }).key.trim();
  }
  return null;
}

// Re-export for consumers that need path info
export { getGlobalOpencodeConfigCandidatePaths as getOpencodeConfigCandidatePaths } from "./api-key-resolver.js";

/**
 * Resolve NanoGPT API key from all available sources.
 *
 * Priority (first wins):
 * 1. Environment variable: NANOGPT_API_KEY
 * 2. User/global opencode.json/opencode.jsonc: provider.nanogpt*.options.apiKey
 * 3. auth.json: "nano-gpt".key
 *
 * @returns API key and source, or null if not found
 */
export async function resolveNanoGptApiKey(): Promise<NanoGptApiKeyResult | null> {
  return resolveApiKey<NanoGptKeySource>(
    {
      envVars: [{ name: "NANOGPT_API_KEY", source: "env:NANOGPT_API_KEY" }],
      extractFromConfig: extractNanoGptKeyFromConfig,
      configJsonSource: "opencode.json",
      configJsoncSource: "opencode.jsonc",
      extractFromAuth: extractNanoGptKeyFromAuth,
      authSource: "auth.json",
      getConfigCandidates: getGlobalOpencodeConfigCandidatePaths,
    },
    readAuthFile,
  );
}

/**
 * Check if a NanoGPT API key is configured
 */
export async function hasNanoGptApiKey(): Promise<boolean> {
  const result = await resolveNanoGptApiKey();
  return result !== null;
}

/**
 * Get diagnostic info about NanoGPT API key configuration
 */
export async function getNanoGptKeyDiagnostics(): Promise<{
  configured: boolean;
  source: NanoGptKeySource | null;
  checkedPaths: string[];
}> {
  return getApiKeyDiagnostics<NanoGptKeySource>({
    envVarNames: ["NANOGPT_API_KEY"],
    resolve: resolveNanoGptApiKey,
    getConfigCandidates: getGlobalOpencodeConfigCandidatePaths,
  });
}
