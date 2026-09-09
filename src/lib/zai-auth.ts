import type { InvalidAwareAuthDiagnostics, InvalidAwareAuthResult } from "./api-key-resolver.js";
import {
  createProviderApiKeyResolver,
  getGlobalOpencodeConfigCandidatePaths,
} from "./api-key-resolver.js";
import { getCredentialDatabasePaths, readAuthFileCached } from "./opencode-auth.js";
import type { AuthData } from "./types.js";

export const DEFAULT_ZAI_AUTH_CACHE_MAX_AGE_MS = 5_000;
const ZAI_AUTH_KEYS = ["zai-coding-plan"] as const;
const ZAI_PROVIDER_KEYS = ["zai", "zai-coding-plan", "glm"] as const;
const ALLOWED_ZAI_ENV_VARS = ["ZAI_API_KEY", "ZAI_CODING_PLAN_API_KEY"] as const;

export type ZaiKeySource =
  | "env:ZAI_API_KEY"
  | "env:ZAI_CODING_PLAN_API_KEY"
  | "opencode.json"
  | "opencode.jsonc"
  | "opencode.db";

export type ResolvedZaiAuth = InvalidAwareAuthResult;
export type ZaiAuthDiagnostics = InvalidAwareAuthDiagnostics<ZaiKeySource, "opencode.db">;

export { getGlobalOpencodeConfigCandidatePaths as getOpencodeConfigCandidatePaths } from "./api-key-resolver.js";

const zaiAuthResolver = createProviderApiKeyResolver<ZaiKeySource, "opencode.db">({
  envVars: [
    { name: "ZAI_API_KEY", source: "env:ZAI_API_KEY" },
    { name: "ZAI_CODING_PLAN_API_KEY", source: "env:ZAI_CODING_PLAN_API_KEY" },
  ],
  providerKeys: ZAI_PROVIDER_KEYS,
  allowedEnvVars: ALLOWED_ZAI_ENV_VARS,
  configJsonSource: "opencode.json",
  configJsoncSource: "opencode.jsonc",
  getConfigCandidates: getGlobalOpencodeConfigCandidatePaths,
  auth: {
    policy: "invalid-aware-api-key",
    authKeys: ZAI_AUTH_KEYS,
    authSource: "opencode.db",
    displayName: "Z.ai",
    defaultMaxAgeMs: DEFAULT_ZAI_AUTH_CACHE_MAX_AGE_MS,
    readAuth: (maxAgeMs) => readAuthFileCached({ maxAgeMs }),
    getCredentialDatabasePaths,
  },
});

export function resolveZaiAuth(auth: AuthData | null | undefined): ResolvedZaiAuth {
  return zaiAuthResolver.parseAuth(auth);
}

export async function resolveZaiAuthCached(params?: {
  maxAgeMs?: number;
}): Promise<ResolvedZaiAuth> {
  return zaiAuthResolver.resolve(params);
}

export async function getZaiAuthDiagnostics(params?: {
  maxAgeMs?: number;
}): Promise<ZaiAuthDiagnostics> {
  return zaiAuthResolver.diagnostics(params);
}
