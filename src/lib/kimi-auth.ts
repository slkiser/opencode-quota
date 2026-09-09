import type { InvalidAwareAuthDiagnostics, InvalidAwareAuthResult } from "./api-key-resolver.js";
import {
  createProviderApiKeyResolver,
  getGlobalOpencodeConfigCandidatePaths,
} from "./api-key-resolver.js";
import { getCredentialDatabasePaths, readAuthFileCached } from "./opencode-auth.js";
import type { AuthData } from "./types.js";

export const DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS = 5_000;
const KIMI_AUTH_KEYS = ["kimi-for-coding", "kimi-code", "kimi"] as const;
const KIMI_PROVIDER_KEYS = ["kimi-for-coding", "kimi-code", "kimi"] as const;
const ALLOWED_KIMI_ENV_VARS = ["KIMI_API_KEY", "KIMI_CODE_API_KEY"] as const;

export type KimiKeySource =
  | "env:KIMI_API_KEY"
  | "env:KIMI_CODE_API_KEY"
  | "opencode.json"
  | "opencode.jsonc"
  | "opencode.db";

export type ResolvedKimiAuth = InvalidAwareAuthResult;
export type KimiAuthDiagnostics = InvalidAwareAuthDiagnostics<KimiKeySource, "opencode.db">;

export { getGlobalOpencodeConfigCandidatePaths as getOpencodeConfigCandidatePaths } from "./api-key-resolver.js";

const kimiAuthResolver = createProviderApiKeyResolver<KimiKeySource, "opencode.db">({
  envVars: [
    { name: "KIMI_API_KEY", source: "env:KIMI_API_KEY" },
    { name: "KIMI_CODE_API_KEY", source: "env:KIMI_CODE_API_KEY" },
  ],
  providerKeys: KIMI_PROVIDER_KEYS,
  allowedEnvVars: ALLOWED_KIMI_ENV_VARS,
  configJsonSource: "opencode.json",
  configJsoncSource: "opencode.jsonc",
  getConfigCandidates: getGlobalOpencodeConfigCandidatePaths,
  auth: {
    policy: "invalid-aware-api-key",
    authKeys: KIMI_AUTH_KEYS,
    authSource: "opencode.db",
    displayName: "Kimi",
    defaultMaxAgeMs: DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS,
    readAuth: (maxAgeMs) => readAuthFileCached({ maxAgeMs }),
    getCredentialDatabasePaths,
  },
});

export function resolveKimiAuth(auth: AuthData | null | undefined): ResolvedKimiAuth {
  return kimiAuthResolver.parseAuth(auth);
}

export async function resolveKimiAuthCached(params?: {
  maxAgeMs?: number;
}): Promise<ResolvedKimiAuth> {
  return kimiAuthResolver.resolve(params);
}

export async function getKimiAuthDiagnostics(params?: {
  maxAgeMs?: number;
}): Promise<KimiAuthDiagnostics> {
  return kimiAuthResolver.diagnostics(params);
}
