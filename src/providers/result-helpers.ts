import type { DebugDetail } from "../core/types.js";
import {
  type ApiKeySpec,
  getApiKeyCheckedPaths,
  type VendorKeys,
} from "../lib/api-key-resolver.js";
import { sanitizeDisplayText } from "../lib/display-sanitize.js";
import { getCredentialDatabasePaths } from "../lib/opencode-auth.js";

export function statusDetailsFromRecord(
  values: Readonly<Record<string, string | undefined>>,
): DebugDetail[] {
  return Object.entries(values).flatMap(([key, value]) =>
    value === undefined ? [] : [{ key, value }],
  );
}

export function configStatusDetails(diagnostics: {
  state: string;
  source: string | null;
  checkedPaths: readonly string[];
}): DebugDetail[] {
  return statusDetailsFromRecord({
    config_state: diagnostics.state,
    config_source: diagnostics.source ?? "(none)",
    config_checked_paths: diagnostics.checkedPaths.join(" | ") || "(none)",
  });
}

export function simpleApiKeyStatusDetails(diagnostics: {
  configured: boolean;
  source: string | null;
  checkedPaths: readonly string[];
  credentialDatabasePaths: readonly string[];
}): DebugDetail[] {
  return statusDetailsFromRecord({
    api_key_configured: diagnostics.configured ? "true" : "false",
    api_key_source: diagnostics.source ?? "(none)",
    api_key_checked_paths: diagnostics.checkedPaths.join(" | ") || "(none)",
    api_key_credential_database_paths: diagnostics.credentialDatabasePaths.join(" | ") || "(none)",
  });
}

type KeyState =
  | { state: "none"; source: null }
  | { state: "configured"; source: string }
  | { state: "invalid"; source: "opencode.db"; error: string };

/** The key the vendor uses first: the env or config key, else its first stored login. */
export function vendorKeyState(keys: VendorKeys): KeyState {
  if (keys.envOrConfig) return { state: "configured", source: keys.envOrConfig.source };
  const first = keys.logins[0]?.auth;
  if (first?.state === "configured") return { state: "configured", source: "opencode.db" };
  const error = first?.error ?? keys.broken;
  return error === null || error === undefined
    ? { state: "none", source: null }
    : { state: "invalid", source: "opencode.db", error };
}

/** Where a vendor's API key was looked for, and what its first key holds. */
export function vendorKeyDetails(
  spec: ApiKeySpec,
  keys: VendorKeys,
  directory: string,
): DebugDetail[] {
  const key = vendorKeyState(keys);
  return statusDetailsFromRecord({
    auth_state: key.state,
    api_key_configured: key.state === "configured" ? "true" : "false",
    api_key_source: key.source ?? "(none)",
    api_key_checked_paths: getApiKeyCheckedPaths(spec, directory).join(" | ") || "(none)",
    api_key_credential_database_paths: getCredentialDatabasePaths().join(" | ") || "(none)",
    auth_error: key.state === "invalid" ? sanitizeDisplayText(key.error) : undefined,
  });
}

export function apiKeyStatusDetails(diagnostics: {
  state: string;
  source: string | null;
  checkedPaths: readonly string[];
  credentialDatabasePaths: readonly string[];
  error?: string;
}): DebugDetail[] {
  return statusDetailsFromRecord({
    auth_state: diagnostics.state,
    api_key_configured: diagnostics.state === "configured" ? "true" : "false",
    api_key_source: diagnostics.source ?? "(none)",
    api_key_checked_paths: diagnostics.checkedPaths.join(" | ") || "(none)",
    api_key_credential_database_paths: diagnostics.credentialDatabasePaths.join(" | ") || "(none)",
    auth_error: diagnostics.error ? sanitizeDisplayText(diagnostics.error) : undefined,
  });
}
