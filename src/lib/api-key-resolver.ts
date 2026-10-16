/**
 * One API key resolver for every API-key vendor.
 *
 * Order (first wins): environment variables, then the trusted global
 * `opencode.json(c)` (`providers.<id>.settings.apiKey`, or the legacy
 * `provider.<id>.options.apiKey`, with `{env:NAME}` templates), then OpenCode's
 * stored logins. Each vendor's spec is its `apiKey` in `provider-registration.ts`.
 */

import { existsSync } from "fs";
import { sanitizeDisplayText } from "./display-sanitize.js";
import { resolveEnvTemplate } from "./env-template.js";
import { asRecord } from "./json-guards.js";
import {
  type CredentialRow,
  credentialRowAuthData,
  getCredentialDatabasePaths,
  readAuthFile,
  readAuthFileCached,
  readCredentialRows,
} from "./opencode-auth.js";
import {
  buildOpenCodeConfigCandidates,
  readOpenCodeConfigCandidate,
} from "./opencode-config-read.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";
import { QUOTA_PROVIDER_REGISTRATION_SOURCE } from "./provider-registration.js";

/** Where an API key may live for one vendor. */
export interface ApiKeySpec {
  /** Checked first, in order. Also the only names allowed in `{env:NAME}` config templates. */
  envVars: readonly string[];
  /** Provider ids read from the trusted global `opencode.json(c)`, in order. */
  providerKeys: readonly string[];
  /** OpenCode login integration ids, in order. Default: `providerKeys`. */
  authKeys?: readonly string[];
  /** Read key logins only: the same integration can also hold an OAuth sign-in. */
  keyLoginsOnly?: boolean;
}

/** An API-key vendor; a broken stored login (wrong type, empty key, unreadable) is an error. */
export interface ApiKeyLoginSpec extends ApiKeySpec {
  authKeys: readonly string[];
  /** Used in login errors, e.g. "Z.ai auth entry has invalid shape". */
  displayName: string;
  /** Replaces the "Unsupported <name> auth type" error (it would echo the stored type). */
  unsupportedTypeError?: string;
  /** A stored login that is not a usable API key is left out instead of shown as an error. */
  skipBrokenLogins?: boolean;
}

type ApiKeyVendorId = Extract<
  (typeof QUOTA_PROVIDER_REGISTRATION_SOURCE)[number],
  { apiKey: object }
>["id"];

/** Each API-key vendor's spec, from its `apiKey` in provider-registration.ts. */
export const API_KEY_VENDORS = Object.fromEntries<ApiKeyLoginSpec>(
  QUOTA_PROVIDER_REGISTRATION_SOURCE.flatMap((source) => {
    if (!("apiKey" in source)) return [];
    const { apiKey } = source;
    return [[source.id, { displayName: source.label, authKeys: apiKey.providerKeys, ...apiKey }]];
  }),
) as Readonly<Record<ApiKeyVendorId, ApiKeyLoginSpec>>;

/** How long a stored login read stays cached, unless the caller asks for another age. */
const API_KEY_LOGIN_CACHE_MAX_AGE_MS = 5_000;

export type ApiKeySource = `env:${string}` | "opencode.json" | "opencode.jsonc" | "opencode.db";

export interface ApiKeyResult {
  key: string;
  source: ApiKeySource;
}

type ApiKeyLoginResult =
  | { state: "none" }
  | { state: "configured"; apiKey: string }
  | { state: "invalid"; error: string };

type DiagnosticPaths = { checkedPaths: string[]; credentialDatabasePaths: string[] };

export type ApiKeyLoginDiagnostics =
  | ({ state: "none"; source: null } & DiagnosticPaths)
  | ({ state: "configured"; source: ApiKeySource } & DiagnosticPaths)
  | ({ state: "invalid"; source: "opencode.db"; error: string } & DiagnosticPaths);

/** A candidate config file path with its format */
interface ConfigCandidate {
  path: string;
  isJsonc: boolean;
}

/**
 * Trusted global-only `opencode.jsonc` / `opencode.json` paths. Provider secrets
 * are never read from repo-local config: the current workspace may be untrusted.
 */
export function getGlobalOpencodeConfigCandidatePaths(): ConfigCandidate[] {
  const { configDir } = getOpencodeRuntimeDirs();
  return buildOpenCodeConfigCandidates({
    directories: [configDir],
    formatOrder: ["jsonc", "json"],
  }).map((candidate) => ({ path: candidate.path, isJsonc: candidate.format === "jsonc" }));
}

/** The parsed config of one candidate; undefined when it is missing or does not parse. */
export async function readConfigCandidate(candidate: ConfigCandidate): Promise<unknown> {
  const result = await readOpenCodeConfigCandidate({
    path: candidate.path,
    format: candidate.isJsonc ? "jsonc" : "json",
  });
  return result.state === "parsed" ? result.value : undefined;
}

export function getFirstAuthEntryValue(auth: unknown, authKeys: readonly string[]): unknown {
  const root = asRecord(auth);
  if (!root) return undefined;
  const authKey = authKeys.find((key) => Object.hasOwn(root, key));
  return authKey === undefined ? undefined : root[authKey];
}

/**
 * Read one provider's settings the way OpenCode 2 normalizes its config.
 *
 * A native `providers.<id>` entry replaces the legacy `provider.<id>` entry,
 * whose `options` OpenCode 2 migrates into `settings`.
 */
export function getProviderConfigSettings(
  config: unknown,
  providerKey: string,
): Record<string, unknown> | null {
  const root = asRecord(config);
  const nativeProvider = asRecord(root?.providers)?.[providerKey];
  // Any object here, even a malformed array, replaces the legacy entry.
  if (typeof nativeProvider === "object" && nativeProvider !== null) {
    return asRecord((nativeProvider as Record<string, unknown>).settings);
  }
  return asRecord(asRecord(asRecord(root?.provider)?.[providerKey])?.options);
}

/**
 * Read one provider string setting from trusted user/global OpenCode config.
 * The first candidate (`opencode.jsonc`, then `opencode.json`) that sets it wins.
 */
export async function readGlobalProviderConfigString(
  providerKey: string,
  settingKey: string,
): Promise<string | undefined> {
  for (const candidate of getGlobalOpencodeConfigCandidatePaths()) {
    const value = getProviderConfigSettings(await readConfigCandidate(candidate), providerKey)?.[
      settingKey
    ];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function extractConfigApiKey(config: unknown, spec: ApiKeySpec): string | null {
  for (const providerKey of spec.providerKeys) {
    const apiKey = getProviderConfigSettings(config, providerKey)?.apiKey;
    if (typeof apiKey !== "string" || apiKey.trim().length === 0) continue;
    const resolved = resolveEnvTemplate(apiKey.trim(), spec.envVars);
    if (resolved) return resolved;
  }
  return null;
}

/** Environment variables, then the trusted global config. */
export async function resolveApiKeyFromEnvAndConfig(
  spec: ApiKeySpec,
): Promise<ApiKeyResult | null> {
  for (const name of spec.envVars) {
    const value = process.env[name]?.trim();
    if (value) return { key: value, source: `env:${name}` };
  }

  for (const candidate of getGlobalOpencodeConfigCandidatePaths()) {
    const config = await readConfigCandidate(candidate);
    if (config === undefined) continue;
    const key = extractConfigApiKey(config, spec);
    if (key) return { key, source: candidate.isJsonc ? "opencode.jsonc" : "opencode.json" };
  }

  return null;
}

/** Env vars that are set and trusted config files that exist (no values). */
export function getApiKeyCheckedPaths(spec: Pick<ApiKeySpec, "envVars">): string[] {
  return [
    ...spec.envVars.filter((name) => process.env[name] !== undefined).map((name) => `env:${name}`),
    ...getGlobalOpencodeConfigCandidatePaths()
      .map((candidate) => candidate.path)
      .filter((path) => existsSync(path)),
  ];
}

function loginReadOptions(spec: ApiKeySpec) {
  return {
    integrationIds: spec.authKeys ?? spec.providerKeys,
    ...(spec.keyLoginsOnly ? { methods: ["key" as const] } : {}),
  };
}

/** The first stored login among `authKeys` that is a usable API key; others are skipped. */
function extractStoredApiKey(auth: unknown, authKeys: readonly string[]): string | null {
  for (const authKey of authKeys) {
    const record = asRecord(getFirstAuthEntryValue(auth, [authKey]));
    const key = record?.key;
    if (record?.type === "api" && typeof key === "string" && key.trim().length > 0) {
      return key.trim();
    }
  }
  return null;
}

export async function resolveApiKey(spec: ApiKeySpec): Promise<ApiKeyResult | null> {
  const fromEnvOrConfig = await resolveApiKeyFromEnvAndConfig(spec);
  if (fromEnvOrConfig) return fromEnvOrConfig;

  const auth = await readAuthFile(loginReadOptions(spec));
  const key = extractStoredApiKey(auth, spec.authKeys ?? spec.providerKeys);
  return key ? { key, source: "opencode.db" } : null;
}

/** Read the vendor's stored logins (cached for 5 seconds). */
export async function readApiKeyLoginAuth(spec: ApiKeyLoginSpec): Promise<unknown> {
  return readAuthFileCached({
    maxAgeMs: API_KEY_LOGIN_CACHE_MAX_AGE_MS,
    ...loginReadOptions(spec),
  });
}

/** The first stored login among `authKeys` decides: a broken one is `invalid`, not skipped. */
export function parseApiKeyLogin(spec: ApiKeyLoginSpec, auth: unknown): ApiKeyLoginResult {
  const entry = getFirstAuthEntryValue(auth, spec.authKeys);
  if (entry === null || entry === undefined) return { state: "none" };
  if (typeof entry !== "object") {
    return { state: "invalid", error: `${spec.displayName} auth entry has invalid shape` };
  }

  const record = entry as Record<string, unknown>;
  if (typeof record.resolveError === "string") {
    return {
      state: "invalid",
      error: `OpenCode could not read this login: ${record.resolveError}`,
    };
  }
  if (typeof record.type !== "string") {
    return {
      state: "invalid",
      error: `${spec.displayName} auth entry present but type is missing or invalid`,
    };
  }
  if (record.type !== "api") {
    const sanitized = sanitizeDisplayText(record.type).replace(/\s+/g, " ").trim();
    return {
      state: "invalid",
      error:
        spec.unsupportedTypeError ??
        `Unsupported ${spec.displayName} auth type: "${(sanitized || "unknown").slice(0, 120)}"`,
    };
  }

  const apiKey = typeof record.key === "string" ? record.key.trim() : "";
  return apiKey
    ? { state: "configured", apiKey }
    : { state: "invalid", error: `${spec.displayName} auth entry present but key is empty` };
}

export async function resolveApiKeyLoginWithDiagnostics(
  spec: ApiKeyLoginSpec,
): Promise<{ auth: ApiKeyLoginResult; diagnostics: ApiKeyLoginDiagnostics }> {
  const fromEnvOrConfig = await resolveApiKeyFromEnvAndConfig(spec);
  const auth: ApiKeyLoginResult = fromEnvOrConfig
    ? { state: "configured", apiKey: fromEnvOrConfig.key }
    : parseApiKeyLogin(spec, await readApiKeyLoginAuth(spec));
  const paths = {
    checkedPaths: getApiKeyCheckedPaths(spec),
    credentialDatabasePaths: getCredentialDatabasePaths(),
  };
  if (auth.state === "none")
    return { auth, diagnostics: { state: "none", source: null, ...paths } };
  if (auth.state === "invalid") {
    return {
      auth,
      diagnostics: { state: "invalid", source: "opencode.db", error: auth.error, ...paths },
    };
  }
  return {
    auth,
    diagnostics: {
      state: "configured",
      source: fromEnvOrConfig?.source ?? "opencode.db",
      ...paths,
    },
  };
}

export async function resolveApiKeyLogin(spec: ApiKeyLoginSpec): Promise<ApiKeyLoginResult> {
  const fromEnvOrConfig = await resolveApiKeyFromEnvAndConfig(spec);
  if (fromEnvOrConfig) return { state: "configured", apiKey: fromEnvOrConfig.key };
  return parseApiKeyLogin(spec, await readApiKeyLoginAuth(spec));
}

export async function getApiKeyLoginDiagnostics(
  spec: ApiKeyLoginSpec,
): Promise<ApiKeyLoginDiagnostics> {
  return (await resolveApiKeyLoginWithDiagnostics(spec)).diagnostics;
}

export type KeyLogin = {
  row: CredentialRow;
  auth: Exclude<ApiKeyLoginResult, { state: "none" }>;
};

/**
 * Every key login of the vendor stored in OpenCode, in OpenCode's order, with what each one
 * holds. `selectRows` narrows the logins further, for example to drop alias duplicates.
 */
export async function readKeyLogins(
  spec: ApiKeyLoginSpec,
  options: { selectRows?: (rows: CredentialRow[]) => CredentialRow[] } = {},
): Promise<KeyLogin[]> {
  const vendorRows = (await readCredentialRows(spec.authKeys, { methods: ["key"] })).filter((row) =>
    spec.authKeys.includes(row.integrationId),
  );
  const rows = options.selectRows ? options.selectRows(vendorRows) : vendorRows;
  return rows.flatMap((row) => {
    const auth = parseApiKeyLogin(spec, credentialRowAuthData(row));
    if (auth.state === "none") return [];
    if (auth.state === "invalid" && spec.skipBrokenLogins) return [];
    return [{ row, auth }];
  });
}

/** The keys a vendor checks: the env or config key when one is set, else every stored login. */
export type VendorKeys = { envOrConfig: ApiKeyResult | null; logins: KeyLogin[] };

export async function readVendorKeys(spec: ApiKeyLoginSpec): Promise<VendorKeys> {
  const envOrConfig = await resolveApiKeyFromEnvAndConfig(spec);
  return { envOrConfig, logins: envOrConfig ? [] : await readKeyLogins(spec) };
}

export function hasVendorKey(keys: VendorKeys): boolean {
  return keys.envOrConfig !== null || keys.logins.length > 0;
}
