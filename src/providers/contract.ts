/**
 * The row contract providers return: per account, its rows (keyed like `five_hour`) and its
 * errors, plus debug details for /quota_status. `core/rows.ts` turns a result into v6 rows by
 * adding each row's id, provider and account.
 */

import type { DebugDetail, QuotaRow, QuotaWindow } from "../core/types.js";
import { type CredentialRow, formatCredentialDisplayNames } from "../lib/opencode-auth.js";

/** One row as a provider reports it; `key` is the part of the row id after the provider id. */
export type ProviderRow = Omit<QuotaRow, "id" | "providerId" | "account"> & { key: string };

export type FetchError = { message: string };

/**
 * One account's rows and errors. `name` is its display name, for example
 * "[Claude Work] (active)" or "Copilot (pro)": the rows take their account from it, and it
 * labels the errors in debug details. `login` is the OpenCode login the rows came from.
 */
export type AccountResult = {
  name: string;
  login?: string;
  rows: ProviderRow[];
  errors: FetchError[];
};

/** `attempted` is false when the provider had nothing to query (it is not set up). */
export type ProviderFetchResult = {
  attempted: boolean;
  accounts: AccountResult[];
  debug: DebugDetail[];
};

/** A row key part from provider text: lower case, `_` for anything else ("Claude/GPT" → "claude_gpt"). */
export function keySlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
}

/** The common windows: row key, default label and window. */
export const FIVE_HOUR = { key: "five_hour", label: "5h", window: "five_hour" } as const;
export const WEEKLY = { key: "weekly", label: "Weekly", window: "week" } as const;
export const MONTHLY = { key: "monthly", label: "Monthly", window: "month" } as const;

/** A remote, provider-reported quota row with the percent left: most providers' row. */
export function quotaRow(fields: {
  key: string;
  label: string;
  window?: QuotaWindow;
  percentRemaining: number;
  resetsAt?: string;
  windowStartedAt?: string;
}): ProviderRow {
  return {
    key: fields.key,
    label: fields.label,
    type: "quota",
    method: "remote_api",
    authority: "provider_reported",
    prominence: "primary",
    ...(fields.window ? { window: fields.window } : {}),
    percentRemaining: fields.percentRemaining,
    // An empty reset time means the provider gave none.
    ...(fields.resetsAt ? { resetsAt: fields.resetsAt } : {}),
    ...(fields.windowStartedAt ? { windowStartedAt: fields.windowStartedAt } : {}),
  };
}

/** One window of a provider reply: the percent left, when it resets, and when it started. */
type WindowValue = {
  percentRemaining: number;
  resetTimeIso?: string;
  fixedWindow?: { startedAtIso: string };
};

/** A quota row for each window the provider reported, in the given order. */
export function windowRows(
  windows: ReadonlyArray<{
    slot: { key: string; label: string; window: QuotaWindow };
    value: WindowValue | undefined;
  }>,
): ProviderRow[] {
  return windows.flatMap(({ slot, value }) =>
    value
      ? [
          quotaRow({
            ...slot,
            percentRemaining: value.percentRemaining,
            resetsAt: value.resetTimeIso,
            windowStartedAt: value.fixedWindow?.startedAtIso,
          }),
        ]
      : [],
  );
}

/** An account with one error and no rows. */
export function failedAccount(name: string, message: string): AccountResult {
  return { name, rows: [], errors: [{ message }] };
}

/** What one login gave: its rows and errors, or null when it had nothing to query. */
type LoginFetch = {
  rows: ProviderRow[];
  errors: FetchError[];
  /** The name of a login without an alias of its own, for example "Copilot (pro)". */
  fallbackName?: string;
} | null;

/**
 * Fetches every OpenCode login of a provider at once and names each account the way OpenCode
 * lists the logins ("[Claude Work] (active)"). A login that gave nothing has no account but
 * still counts when unnamed logins are numbered.
 */
export async function fetchEachLogin<Login extends { row: CredentialRow }>(params: {
  providerName: string;
  logins: readonly Login[];
  fetchLogin: (login: Login) => Promise<LoginFetch>;
  /** Number unnamed logins ("[OpenAI 2]") instead of naming them after the fallback. */
  numberUnnamed?: (row: CredentialRow) => boolean;
}): Promise<AccountResult[]> {
  const fetched = await Promise.all(params.logins.map((login) => params.fetchLogin(login)));
  const names = formatCredentialDisplayNames(
    params.providerName,
    params.logins.map(({ row }, index) => ({
      row,
      fallbackName: fetched[index]?.fallbackName ?? params.providerName,
      numberUnnamed: params.numberUnnamed?.(row) ?? false,
    })),
  );
  return params.logins.flatMap(({ row }, index) => {
    const result = fetched[index];
    if (!result) return [];
    return [
      {
        name: names[index] ?? params.providerName,
        login: row.id,
        rows: result.rows,
        errors: result.errors,
      },
    ];
  });
}

/** A stored key login OpenCode could not use: what `readKeyLogins` gives for a broken one. */
type BrokenKeyLogin = { state: "invalid"; error: string };

/**
 * Fetches each stored key login of an API-key vendor (see `readKeyLogins`). A broken login is
 * an account with its error; `brokenFirst` lists those before the fetched ones.
 */
export async function fetchKeyLogins<Auth extends { state: string }>(params: {
  providerName: string;
  logins: ReadonlyArray<{ row: CredentialRow; auth: Auth }>;
  brokenFirst: boolean;
  fetchLogin: (login: {
    row: CredentialRow;
    auth: Exclude<Auth, BrokenKeyLogin>;
  }) => Promise<LoginFetch>;
}): Promise<AccountResult[]> {
  const accounts = await fetchEachLogin({
    providerName: params.providerName,
    logins: params.logins,
    async fetchLogin({ row, auth }) {
      if (auth.state === "invalid") {
        return { rows: [], errors: [{ message: (auth as unknown as BrokenKeyLogin).error }] };
      }
      return params.fetchLogin({ row, auth: auth as Exclude<Auth, BrokenKeyLogin> });
    },
  });
  if (!params.brokenFirst) return accounts;
  const broken = new Set(
    params.logins.filter(({ auth }) => auth.state === "invalid").map(({ row }) => row.id),
  );
  return [
    ...accounts.filter((account) => broken.has(account.login ?? "")),
    ...accounts.filter((account) => !broken.has(account.login ?? "")),
  ];
}
