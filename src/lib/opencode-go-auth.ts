import type { InvalidAwareAuthDiagnostics, InvalidAwareAuthResult } from "./api-key-resolver.js";
import {
  createProviderApiKeyResolver,
  getGlobalOpencodeConfigCandidatePaths,
} from "./api-key-resolver.js";
import { getCredentialDatabasePaths, readAuthFileCached } from "./opencode-auth.js";

export const DEFAULT_OPENCODE_GO_AUTH_CACHE_MAX_AGE_MS = 5_000;
// `opencode-go` is the provider id the OpenCode CLI writes via
// `opencode auth login -p opencode-go` (shown as "OpenCode Go api" in `opencode auth list`).
// `opencode` stays as a fallback alias for existing manual setups.
const OPENCODE_GO_AUTH_KEYS = ["opencode-go", "opencode"] as const;
const OPENCODE_GO_PROVIDER_KEYS = ["opencode-go", "opencode"] as const;
const ALLOWED_OPENCODE_GO_ENV_VARS = ["OPENCODE_API_KEY"] as const;

export type OpenCodeGoKeySource =
  | "env:OPENCODE_API_KEY"
  | "opencode.json"
  | "opencode.jsonc"
  | "opencode.db";

export type ResolvedOpenCodeGoAuth = InvalidAwareAuthResult;
export type OpenCodeGoAuthDiagnostics = InvalidAwareAuthDiagnostics<
  OpenCodeGoKeySource,
  "opencode.db"
>;

export { getGlobalOpencodeConfigCandidatePaths as getOpencodeConfigCandidatePaths } from "./api-key-resolver.js";

const openCodeGoAuthResolver = createProviderApiKeyResolver<OpenCodeGoKeySource, "opencode.db">({
  envVars: [{ name: "OPENCODE_API_KEY", source: "env:OPENCODE_API_KEY" }],
  providerKeys: OPENCODE_GO_PROVIDER_KEYS,
  allowedEnvVars: ALLOWED_OPENCODE_GO_ENV_VARS,
  configJsonSource: "opencode.json",
  configJsoncSource: "opencode.jsonc",
  getConfigCandidates: getGlobalOpencodeConfigCandidatePaths,
  auth: {
    policy: "invalid-aware-api-key",
    authKeys: OPENCODE_GO_AUTH_KEYS,
    authSource: "opencode.db",
    displayName: "OpenCode Go",
    defaultMaxAgeMs: DEFAULT_OPENCODE_GO_AUTH_CACHE_MAX_AGE_MS,
    unsupportedTypeError: "OpenCode Go auth entry has unsupported type",
    readAuth: (maxAgeMs) => readAuthFileCached({ maxAgeMs }),
    getCredentialDatabasePaths,
  },
});

export function resolveOpenCodeGoAuth(auth: unknown): ResolvedOpenCodeGoAuth {
  return openCodeGoAuthResolver.parseAuth(auth);
}

export async function resolveOpenCodeGoAuthCached(params?: {
  maxAgeMs?: number;
}): Promise<ResolvedOpenCodeGoAuth> {
  return openCodeGoAuthResolver.resolve(params);
}

export async function getOpenCodeGoAuthDiagnostics(params?: {
  maxAgeMs?: number;
}): Promise<OpenCodeGoAuthDiagnostics> {
  return openCodeGoAuthResolver.diagnostics(params);
}
