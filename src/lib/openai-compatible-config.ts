/**
 * Per-gateway auth + base-URL resolution for the generic OpenAI-compatible
 * gateway provider.
 *
 * A gateway is identified by the OpenCode provider id it is registered as
 * (e.g. "apigee"). The API key is resolved with the shared resolver from the
 * same trusted sources every other provider uses — env, trusted user/global
 * OpenCode config (provider.<id>.options.apiKey), and auth.json. The base URL
 * is taken from an explicit override or read from the same provider's
 * options.baseURL, so a gateway already configured for chat needs no extra
 * setup.
 */

import { readAuthFile } from "./opencode-auth.js";
import {
  createProviderApiKeyResolver,
  getGlobalOpencodeConfigCandidatePaths,
} from "./api-key-resolver.js";
import { getEffectiveConfigRoot } from "./config-file-utils.js";
import { loadConfiguredOpenCodeConfig } from "./opencode-config-providers.js";

export type GatewayKeySource = "env" | "opencode.json" | "opencode.jsonc" | "auth.json";

export interface GatewayApiKeyResult {
  key: string;
  source: GatewayKeySource;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Conventional env var for a gateway id: "my-gateway" -> "MY_GATEWAY_API_KEY". */
export function gatewayEnvVarName(providerId: string): string {
  const slug = providerId
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${slug}_API_KEY`;
}

function createGatewayApiKeyResolver(providerId: string) {
  const envName = gatewayEnvVarName(providerId);
  return createProviderApiKeyResolver<GatewayKeySource>({
    envVars: [{ name: envName, source: "env" }],
    providerKeys: [providerId],
    allowedEnvVars: [envName],
    configJsonSource: "opencode.json",
    configJsoncSource: "opencode.jsonc",
    getConfigCandidates: getGlobalOpencodeConfigCandidatePaths,
    auth: {
      readAuth: readAuthFile,
      authSource: "auth.json",
    },
  });
}

export async function resolveGatewayApiKey(providerId: string): Promise<GatewayApiKeyResult | null> {
  if (!providerId.trim()) return null;
  return createGatewayApiKeyResolver(providerId).resolve();
}

export async function hasGatewayApiKey(providerId: string): Promise<boolean> {
  if (!providerId.trim()) return false;
  return createGatewayApiKeyResolver(providerId).has();
}

/** Key-resolution diagnostics for /quota_status (which sources were checked). */
export async function getGatewayKeyDiagnostics(providerId: string): Promise<{
  configured: boolean;
  source: GatewayKeySource | null;
  checkedPaths: string[];
}> {
  if (!providerId.trim()) {
    return { configured: false, source: null, checkedPaths: [] };
  }
  return createGatewayApiKeyResolver(providerId).diagnostics();
}

/**
 * Resolve a gateway's base URL: an explicit override wins, else read
 * provider.<id>.options.baseURL from the merged OpenCode config (best-effort).
 */
export async function resolveGatewayBaseURL(
  providerId: string,
  override?: string,
): Promise<string | null> {
  if (typeof override === "string" && override.trim()) {
    return override.trim();
  }
  try {
    const config = await loadConfiguredOpenCodeConfig({
      configRootDir: getEffectiveConfigRoot(process.cwd()),
    });
    const provider = isRecord(config) ? config.provider : undefined;
    const entry = isRecord(provider) ? provider[providerId] : undefined;
    const options = isRecord(entry) ? entry.options : undefined;
    const baseURL = isRecord(options) ? options.baseURL : undefined;
    return typeof baseURL === "string" && baseURL.trim() ? baseURL.trim() : null;
  } catch {
    return null;
  }
}
