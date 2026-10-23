import { PROVIDER_ROW_KEYS as QUOTA_PROVIDER_ROW_KEYS } from "../../src/lib/provider-metadata.js";

/** The production row key ledger, by any provider id. */
export const PROVIDER_ROW_KEYS: Readonly<Record<string, readonly string[]>> =
  QUOTA_PROVIDER_ROW_KEYS;

/** True when `key` is one of the provider's ledger keys. */
export function isLedgerRowKey(providerId: string, key: string): boolean {
  return (PROVIDER_ROW_KEYS[providerId] ?? []).some((pattern) =>
    new RegExp(`^${pattern.replace(/\./g, "\\.").replace(/\*/g, "[A-Za-z0-9_-]+")}$`).test(key),
  );
}
