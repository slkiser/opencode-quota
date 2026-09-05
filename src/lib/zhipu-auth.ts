import type { InvalidAwareAuthDiagnostics, InvalidAwareAuthResult } from "./api-key-resolver.js";
import {
  createProviderApiKeyResolver,
  getGlobalOpencodeConfigCandidatePaths,
} from "./api-key-resolver.js";
import { getCredentialDatabasePaths, readAuthFileCached } from "./opencode-auth.js";
import type { AuthData } from "./types.js";

export const DEFAULT_ZHIPU_AUTH_CACHE_MAX_AGE_MS = 5_000;
const ZHIPU_AUTH_KEYS = ["zhipu-coding-plan", "zhipuai-coding-plan"] as const;
const ZHIPU_PROVIDER_KEYS = [
  "zhipu",
  "zhipu-coding-plan",
  "zhipuai-coding-plan",
  "glm-coding-plan",
] as const;
const ALLOWED_ZHIPU_ENV_VARS = ["ZHIPU_API_KEY", "ZHIPU_CODING_PLAN_API_KEY"] as const;

export type ZhipuKeySource =
  | "env:ZHIPU_API_KEY"
  | "env:ZHIPU_CODING_PLAN_API_KEY"
  | "opencode.json"
  | "opencode.jsonc"
  | "opencode.db";

export type ResolvedZhipuAuth = InvalidAwareAuthResult;
export type ZhipuAuthDiagnostics = InvalidAwareAuthDiagnostics<ZhipuKeySource, "opencode.db">;

export { getGlobalOpencodeConfigCandidatePaths as getOpencodeConfigCandidatePaths } from "./api-key-resolver.js";

const zhipuAuthResolver = createProviderApiKeyResolver<ZhipuKeySource, "opencode.db">({
  envVars: [
    { name: "ZHIPU_API_KEY", source: "env:ZHIPU_API_KEY" },
    { name: "ZHIPU_CODING_PLAN_API_KEY", source: "env:ZHIPU_CODING_PLAN_API_KEY" },
  ],
  providerKeys: ZHIPU_PROVIDER_KEYS,
  allowedEnvVars: ALLOWED_ZHIPU_ENV_VARS,
  configJsonSource: "opencode.json",
  configJsoncSource: "opencode.jsonc",
  getConfigCandidates: getGlobalOpencodeConfigCandidatePaths,
  auth: {
    policy: "invalid-aware-api-key",
    authKeys: ZHIPU_AUTH_KEYS,
    authSource: "opencode.db",
    displayName: "Zhipu",
    defaultMaxAgeMs: DEFAULT_ZHIPU_AUTH_CACHE_MAX_AGE_MS,
    readAuth: (maxAgeMs) => readAuthFileCached({ maxAgeMs }),
    getCredentialDatabasePaths,
  },
});

export function resolveZhipuAuth(auth: AuthData | null | undefined): ResolvedZhipuAuth {
  return zhipuAuthResolver.parseAuth(auth);
}

export async function resolveZhipuAuthCached(params?: {
  maxAgeMs?: number;
}): Promise<ResolvedZhipuAuth> {
  return zhipuAuthResolver.resolve(params);
}

export async function getZhipuAuthDiagnostics(params?: {
  maxAgeMs?: number;
}): Promise<ZhipuAuthDiagnostics> {
  return zhipuAuthResolver.diagnostics(params);
}
