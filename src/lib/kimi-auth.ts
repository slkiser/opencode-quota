import type { InvalidAwareAuthDiagnostics, InvalidAwareAuthResult } from "./api-key-resolver.js";
import {
  createProviderApiKeyResolver,
  getGlobalOpencodeConfigCandidatePaths,
} from "./api-key-resolver.js";
import { getAuthPaths, readAuthFileCached } from "./opencode-auth.js";
import type { AuthData } from "./types.js";

export const DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS = 5_000;
const ALLOWED_KIMI_ENV_VARS = ["KIMI_API_KEY", "KIMI_CODE_API_KEY"] as const;
const KIMI_ENV_VARS = [
  { name: "KIMI_API_KEY", source: "env:KIMI_API_KEY" },
  { name: "KIMI_CODE_API_KEY", source: "env:KIMI_CODE_API_KEY" },
] as const;

const KIMI_CODE_PLAN_GLOBAL_AUTH_KEYS = ["kimi-code-plan-global"] as const;
const KIMI_CODE_PLAN_GLOBAL_PROVIDER_KEYS = ["kimi-code-plan-global"] as const;
const KIMI_CODE_PLAN_CN_AUTH_KEYS = [
  "kimi-code-plan-cn",
  "kimi-for-coding",
  "kimi-code",
  "kimi",
] as const;
const KIMI_CODE_PLAN_CN_PROVIDER_KEYS = [
  "kimi-code-plan-cn",
  "kimi-for-coding",
  "kimi-code",
  "kimi",
] as const;

export type KimiKeySource =
  | "env:KIMI_API_KEY"
  | "env:KIMI_CODE_API_KEY"
  | "opencode.json"
  | "opencode.jsonc"
  | "auth.json";

export type ResolvedKimiAuth = InvalidAwareAuthResult;
export type KimiAuthDiagnostics = InvalidAwareAuthDiagnostics<KimiKeySource, "auth.json">;

export { getGlobalOpencodeConfigCandidatePaths as getOpencodeConfigCandidatePaths } from "./api-key-resolver.js";

function createKimiAuthResolver(params: {
  authKeys: readonly string[];
  providerKeys: readonly string[];
}) {
  return createProviderApiKeyResolver<KimiKeySource, "auth.json">({
    envVars: [...KIMI_ENV_VARS],
    providerKeys: params.providerKeys,
    allowedEnvVars: ALLOWED_KIMI_ENV_VARS,
    configJsonSource: "opencode.json",
    configJsoncSource: "opencode.jsonc",
    getConfigCandidates: getGlobalOpencodeConfigCandidatePaths,
    auth: {
      policy: "invalid-aware-api-key",
      authKeys: params.authKeys,
      authSource: "auth.json",
      displayName: "Kimi",
      defaultMaxAgeMs: DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS,
      readAuth: (maxAgeMs) => readAuthFileCached({ maxAgeMs }),
      getAuthPaths,
    },
  });
}

const kimiCodePlanGlobalAuthResolver = createKimiAuthResolver({
  authKeys: KIMI_CODE_PLAN_GLOBAL_AUTH_KEYS,
  providerKeys: KIMI_CODE_PLAN_GLOBAL_PROVIDER_KEYS,
});

const kimiCodePlanCnAuthResolver = createKimiAuthResolver({
  authKeys: KIMI_CODE_PLAN_CN_AUTH_KEYS,
  providerKeys: KIMI_CODE_PLAN_CN_PROVIDER_KEYS,
});

export function resolveKimiCodePlanGlobalAuth(auth: AuthData | null | undefined): ResolvedKimiAuth {
  return kimiCodePlanGlobalAuthResolver.parseAuth(auth);
}

export async function resolveKimiCodePlanGlobalAuthCached(params?: {
  maxAgeMs?: number;
}): Promise<ResolvedKimiAuth> {
  return kimiCodePlanGlobalAuthResolver.resolve(params);
}

export async function getKimiCodePlanGlobalAuthDiagnostics(params?: {
  maxAgeMs?: number;
}): Promise<KimiAuthDiagnostics> {
  return kimiCodePlanGlobalAuthResolver.diagnostics(params);
}

export function resolveKimiCodePlanCnAuth(auth: AuthData | null | undefined): ResolvedKimiAuth {
  return kimiCodePlanCnAuthResolver.parseAuth(auth);
}

export async function resolveKimiCodePlanCnAuthCached(params?: {
  maxAgeMs?: number;
}): Promise<ResolvedKimiAuth> {
  return kimiCodePlanCnAuthResolver.resolve(params);
}

export async function getKimiCodePlanCnAuthDiagnostics(params?: {
  maxAgeMs?: number;
}): Promise<KimiAuthDiagnostics> {
  return kimiCodePlanCnAuthResolver.diagnostics(params);
}
