/**
 * A faked provider's answer on the row contract, for tests that replace a whole provider,
 * and the snapshot rows and providers that the views and the store hand on.
 * Type-only imports, so a test's module mocks stay in charge of what loads.
 */
import type { ProviderSnapshot, QuotaRow, QuotaWindow } from "../../src/core/types.js";
import type { ProviderFetchResult, ProviderRow } from "../../src/providers/contract.js";

/** A remote, provider-reported quota row with the percent left. */
export function percentRow(
  key: string,
  label: string,
  percentRemaining: number,
  extra: Partial<ProviderRow> & { window?: QuotaWindow } = {},
): ProviderRow {
  return {
    key,
    label,
    type: "quota",
    method: "remote_api",
    authority: "provider_reported",
    prominence: "primary",
    percentRemaining,
    ...extra,
  };
}

/** A remote, provider-reported row that shows a text, for example "$42". */
export function textRow(key: string, label: string, text: string): ProviderRow {
  return {
    key,
    label,
    type: "usage",
    method: "remote_api",
    authority: "provider_reported",
    prominence: "primary",
    text,
  };
}

/** One account of an answer: its display name, rows and error messages. */
export type FakeAccount = { name: string; login?: string; rows?: ProviderRow[]; errors?: string[] };

/** An answer from a provider that could ask: each account with its rows and errors. */
export function answer(...accounts: FakeAccount[]): ProviderFetchResult {
  return {
    attempted: true,
    accounts: accounts.map((account) => ({
      name: account.name,
      ...(account.login ? { login: account.login } : {}),
      rows: account.rows ?? [],
      errors: (account.errors ?? []).map((message) => ({ message })),
    })),
    debug: [],
  };
}

/** The answer of a provider that is not set up. */
export const NOT_SET_UP: ProviderFetchResult = { attempted: false, accounts: [], debug: [] };

/** A remote, provider-reported snapshot row; `id` is "<providerId>.<key>", the label is the key. */
export function quotaRow(id: string, fields: Partial<QuotaRow> = {}): QuotaRow {
  const [providerId = "", key = ""] = id.split(".");
  return {
    id,
    providerId,
    label: key,
    type: "quota",
    method: "remote_api",
    authority: "provider_reported",
    prominence: "primary",
    ...fields,
  };
}

/** A provider's part of a snapshot that is not refreshing. */
export function providerSnapshot(
  providerId: string,
  label: string,
  rows: QuotaRow[],
  extra: Partial<ProviderSnapshot> = {},
): ProviderSnapshot {
  return { providerId, label, rows, refreshing: false, debug: [], ...extra };
}
