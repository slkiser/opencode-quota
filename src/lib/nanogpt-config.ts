/**
 * NanoGPT API key configuration resolver
 *
 * Resolution priority (first wins):
 * 1. Environment variable: NANOGPT_API_KEY
 * 2. opencode.json/opencode.jsonc: provider.nano-gpt.options.apiKey
 *    - Supports {env:VAR_NAME} syntax for environment variable references
 * 3. auth.json: nano-gpt.key (legacy/fallback)
 */

import { resolveEnvTemplate } from "./env-template.js";
import { readAuthFile } from "./opencode-auth.js";
import {
  resolveApiKey,
  getApiKeyDiagnostics,
  getOpencodeConfigCandidatePaths,
  type ApiKeyResult,
} from "./api-key-resolver.js";

/** Result of NanoGPT API key resolution */
export interface NanoGptApiKeyResult {
  key: string;
  source: NanoGptKeySource;
}

/** Source of the resolved API key */
export type NanoGptKeySource =
  | "env:NANOGPT_API_KEY"
  | "opencode.json"
  | "opencode.jsonc"
  | "auth.json";

/**
 * Extract NanoGPT API key from opencode config object
 *
 * Looks for: provider.nano-gpt.options.apiKey or provider.nanogpt.options.apiKey
 */
function extractNanoGptKeyFromConfig(config: unknown): string | null {
  if (!config || typeof config !== "object") return null;

  const root = config as Record<string, unknown>;
  const provider = root.provider;
  if (!provider || typeof provider !== "object") return null;

  const providerObj = provider as Record<string, unknown>;
  const nanoGpt = providerObj["nano-gpt"] ?? providerObj["nanogpt"];
  if (!nanoGpt || typeof nanoGpt !== "object") return null;

  const options = (nanoGpt as Record<string, unknown>).options;
  if (!options || typeof options !== "object") return null;

  const apiKey = (options as Record<string, unknown>).apiKey;
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) return null;

  return resolveEnvTemplate(apiKey.trim());
}

/**
 * Extract NanoGPT API key from auth.json
 */
function extractNanoGptKeyFromAuth(auth: unknown): string | null {
  if (!auth || typeof auth !== "object") return null;
  const authObj = auth as Record<string, unknown>;
  const nanoGpt = authObj["nano-gpt"] ?? authObj["nanogpt"];
  if (
    nanoGpt &&
    typeof nanoGpt === "object" &&
    (nanoGpt as { type?: string }).type === "api" &&
    typeof (nanoGpt as { key?: string }).key === "string" &&
    (nanoGpt as { key?: string }).key!.trim().length > 0
  ) {
    return (nanoGpt as { key: string }).key.trim();
  }
  return null;
}

export { getOpencodeConfigCandidatePaths } from "./api-key-resolver.js";

/**
 * Resolve NanoGPT API key from all available sources.
 *
 * Priority (first wins):
 * 1. Environment variable: NANOGPT_API_KEY
 * 2. opencode.json/opencode.jsonc: provider.nano-gpt.options.apiKey
 * 3. auth.json: nano-gpt.key
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
  });
}
