import { homedir } from "os";
import { join } from "path";

export type ApiKeyContractResult = { key: string; source: string } | null;
export type InvalidAwareContractResult =
  | { state: "none" }
  | { state: "configured"; apiKey: string }
  | { state: "invalid"; error: string };

export interface SimpleApiKeyContractModule {
  resolve: () => Promise<ApiKeyContractResult>;
  has: () => Promise<boolean>;
  diagnostics: () => Promise<{
    configured: boolean;
    source: string | null;
    checkedPaths: string[];
    credentialDatabasePaths: string[];
  }>;
  getConfigCandidates: () => Array<{ path: string; isJsonc: boolean }>;
}

export interface InvalidAwareApiKeyContractModule {
  parseAuth: (auth: any) => InvalidAwareContractResult;
  resolve: (params?: { maxAgeMs?: number }) => Promise<InvalidAwareContractResult>;
  diagnostics: (params?: { maxAgeMs?: number }) => Promise<{
    state: "none" | "configured" | "invalid";
    source: string | null;
    checkedPaths: string[];
    credentialDatabasePaths: string[];
    error?: string;
  }>;
  getConfigCandidates: () => Array<{ path: string; isJsonc: boolean }>;
}

export interface ProviderApiKeyContractDescriptor<Module> {
  name: string;
  envVars: readonly string[];
  providerKeys: readonly string[];
  authKeys: readonly string[];
  load: () => Promise<Module>;
}

export function configWithApiKey(providerKey: string, apiKey: string): string {
  return JSON.stringify({ provider: { [providerKey]: { options: { apiKey } } } });
}

export function configWithProviders(
  providers: Record<string, { options: { apiKey: string } }>,
): string {
  return JSON.stringify({ provider: providers });
}

export function authWithEntry(authKey: string, entry: unknown): Record<string, unknown> {
  return { [authKey]: entry };
}

export function expectedTrustedConfigCandidates(): Array<{ path: string; isJsonc: boolean }> {
  const directory = join(homedir(), ".config", "opencode");
  return [
    { path: join(directory, "opencode.jsonc"), isJsonc: true },
    { path: join(directory, "opencode.json"), isJsonc: false },
  ];
}

export function resetContractEnv(
  originalEnv: NodeJS.ProcessEnv,
  descriptors: ReadonlyArray<ProviderApiKeyContractDescriptor<unknown>>,
): void {
  process.env = { ...originalEnv };
  for (const descriptor of descriptors) {
    for (const envVar of descriptor.envVars) delete process.env[envVar];
  }
  for (const envVar of [
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "NOT_ALLOWED",
  ]) {
    delete process.env[envVar];
  }
}
