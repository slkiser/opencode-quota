import type { InvalidAwareAuthDiagnostics, InvalidAwareAuthResult } from "./api-key-resolver.js";
import {
  createProviderApiKeyResolver,
  getGlobalOpencodeConfigCandidatePaths,
} from "./api-key-resolver.js";
import type { KimiQuotaEndpointId } from "./kimi-endpoints.js";
import { getCredentialDatabasePaths, readAuthFileCached } from "./opencode-auth.js";
import type { AuthData } from "./types.js";

export const DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS = 5_000;

export type KimiKeySource =
  | "env:KIMI_GLOBAL_API_KEY"
  | "env:KIMI_CN_API_KEY"
  | "env:KIMI_API_KEY"
  | "env:KIMI_CODE_API_KEY"
  | "opencode.json"
  | "opencode.jsonc"
  | "opencode.db";

type BaseKimiAuthDiagnostics = InvalidAwareAuthDiagnostics<KimiKeySource, "opencode.db">;

export type ResolvedKimiAuth =
  | { state: "none" }
  | { state: "invalid"; error: string }
  | { state: "configured"; apiKey: string; endpoint: KimiQuotaEndpointId };

export type KimiAuthDiagnostics =
  | Exclude<BaseKimiAuthDiagnostics, { state: "configured" }>
  | (Extract<BaseKimiAuthDiagnostics, { state: "configured" }> & {
      endpoint: KimiQuotaEndpointId;
    });

export type ResolvedKimiAuthWithDiagnostics = {
  auth: ResolvedKimiAuth;
  diagnostics: KimiAuthDiagnostics;
};

export { getGlobalOpencodeConfigCandidatePaths as getOpencodeConfigCandidatePaths } from "./api-key-resolver.js";

type KimiAuthSpec = {
  endpoint: KimiQuotaEndpointId;
  authKeys: readonly string[];
  providerKeys: readonly string[];
  envVars: readonly { name: string; source: KimiKeySource }[];
  allowedEnvVars: readonly string[];
};

const KIMI_GLOBAL_AUTH_SPEC = {
  endpoint: "global",
  authKeys: ["kimi-code-plan-global"],
  providerKeys: ["kimi-code-plan-global"],
  envVars: [{ name: "KIMI_GLOBAL_API_KEY", source: "env:KIMI_GLOBAL_API_KEY" }],
  allowedEnvVars: ["KIMI_GLOBAL_API_KEY"],
} as const satisfies KimiAuthSpec;

const KIMI_CN_AUTH_SPEC = {
  endpoint: "cn",
  authKeys: ["kimi-code-plan-cn", "kimi-for-coding", "kimi-code", "kimi"],
  providerKeys: ["kimi-code-plan-cn", "kimi-for-coding", "kimi-code", "kimi"],
  envVars: [
    { name: "KIMI_CN_API_KEY", source: "env:KIMI_CN_API_KEY" },
    { name: "KIMI_API_KEY", source: "env:KIMI_API_KEY" },
    { name: "KIMI_CODE_API_KEY", source: "env:KIMI_CODE_API_KEY" },
  ],
  allowedEnvVars: ["KIMI_CN_API_KEY", "KIMI_API_KEY", "KIMI_CODE_API_KEY"],
} as const satisfies KimiAuthSpec;

function createKimiAuthResolver(spec: KimiAuthSpec) {
  return createProviderApiKeyResolver<KimiKeySource, "opencode.db">({
    envVars: [...spec.envVars],
    providerKeys: spec.providerKeys,
    allowedEnvVars: spec.allowedEnvVars,
    configJsonSource: "opencode.json",
    configJsoncSource: "opencode.jsonc",
    getConfigCandidates: getGlobalOpencodeConfigCandidatePaths,
    auth: {
      policy: "invalid-aware-api-key",
      authKeys: spec.authKeys,
      authSource: "opencode.db",
      displayName: "Kimi",
      defaultMaxAgeMs: DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS,
      readAuth: (maxAgeMs) => readAuthFileCached({ maxAgeMs }),
      getCredentialDatabasePaths,
    },
  });
}

const kimiGlobalAuthResolver = createKimiAuthResolver(KIMI_GLOBAL_AUTH_SPEC);
const kimiCnAuthResolver = createKimiAuthResolver(KIMI_CN_AUTH_SPEC);

function bindAuthToEndpoint(
  auth: InvalidAwareAuthResult,
  endpoint: KimiQuotaEndpointId,
): ResolvedKimiAuth {
  return auth.state === "configured" ? { ...auth, endpoint } : auth;
}

function bindDiagnosticsToEndpoint(
  diagnostics: BaseKimiAuthDiagnostics,
  endpoint: KimiQuotaEndpointId,
): KimiAuthDiagnostics {
  return diagnostics.state === "configured" ? { ...diagnostics, endpoint } : diagnostics;
}

export function resolveKimiGlobalAuth(auth: AuthData | null | undefined): ResolvedKimiAuth {
  return bindAuthToEndpoint(kimiGlobalAuthResolver.parseAuth(auth), KIMI_GLOBAL_AUTH_SPEC.endpoint);
}

export function resolveKimiCnAuth(auth: AuthData | null | undefined): ResolvedKimiAuth {
  return bindAuthToEndpoint(kimiCnAuthResolver.parseAuth(auth), KIMI_CN_AUTH_SPEC.endpoint);
}

export async function resolveKimiGlobalAuthCached(params?: {
  maxAgeMs?: number;
}): Promise<ResolvedKimiAuth> {
  return bindAuthToEndpoint(
    await kimiGlobalAuthResolver.resolve(params),
    KIMI_GLOBAL_AUTH_SPEC.endpoint,
  );
}

export async function resolveKimiCnAuthCached(params?: {
  maxAgeMs?: number;
}): Promise<ResolvedKimiAuth> {
  return bindAuthToEndpoint(await kimiCnAuthResolver.resolve(params), KIMI_CN_AUTH_SPEC.endpoint);
}

export async function resolveKimiGlobalAuthWithDiagnosticsCached(params?: {
  maxAgeMs?: number;
}): Promise<ResolvedKimiAuthWithDiagnostics> {
  const resolved = await kimiGlobalAuthResolver.resolveWithDiagnostics(params);
  return {
    auth: bindAuthToEndpoint(resolved.auth, KIMI_GLOBAL_AUTH_SPEC.endpoint),
    diagnostics: bindDiagnosticsToEndpoint(resolved.diagnostics, KIMI_GLOBAL_AUTH_SPEC.endpoint),
  };
}

export async function resolveKimiCnAuthWithDiagnosticsCached(params?: {
  maxAgeMs?: number;
}): Promise<ResolvedKimiAuthWithDiagnostics> {
  const resolved = await kimiCnAuthResolver.resolveWithDiagnostics(params);
  return {
    auth: bindAuthToEndpoint(resolved.auth, KIMI_CN_AUTH_SPEC.endpoint),
    diagnostics: bindDiagnosticsToEndpoint(resolved.diagnostics, KIMI_CN_AUTH_SPEC.endpoint),
  };
}

export async function getKimiGlobalAuthDiagnostics(params?: {
  maxAgeMs?: number;
}): Promise<KimiAuthDiagnostics> {
  return bindDiagnosticsToEndpoint(
    await kimiGlobalAuthResolver.diagnostics(params),
    KIMI_GLOBAL_AUTH_SPEC.endpoint,
  );
}

export async function getKimiCnAuthDiagnostics(params?: {
  maxAgeMs?: number;
}): Promise<KimiAuthDiagnostics> {
  return bindDiagnosticsToEndpoint(
    await kimiCnAuthResolver.diagnostics(params),
    KIMI_CN_AUTH_SPEC.endpoint,
  );
}
