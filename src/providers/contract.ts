/**
 * The row contract providers return: per account, its rows (keyed like `five_hour`) and its
 * errors, plus debug details for /quota_status. `core/rows.ts` turns a result into v6 rows by
 * adding each row's id, provider and account.
 */

import type { ErrorFacts } from "../core/errors.js";
import type { Amount, DebugDetail, QuotaRow, QuotaWindow } from "../core/types.js";
import { type CredentialRow, formatCredentialDisplayNames } from "../lib/opencode-auth.js";

/** One row as a provider reports it; `key` is the part of the row id after the provider id. */
export type ProviderRow = Omit<QuotaRow, "id" | "providerId" | "account"> & { key: string };

/** One error: its words, and the facts of the request that failed when it gave them. */
export type FetchError = { message: string; facts?: ErrorFacts };

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

/** `attempted` is false when the provider had nothing to query (it is not set up). `empty` is an
 * answer that there is nothing to show: it clears the last rows without an error. */
export type ProviderFetchResult = {
  attempted: boolean;
  accounts: AccountResult[];
  debug: DebugDetail[];
  empty?: true;
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

/** One quota row, the way a provider reports a window: the percent left, the counts when it has
 * them, when it resets and when it started. */
function windowRow(fields: {
  key: string;
  label: string;
  window?: QuotaWindow;
  method: ProviderRow["method"];
  percentRemaining: number;
  used?: Amount;
  limit?: Amount;
  resetsAt?: string;
  windowStartedAt?: string;
}): ProviderRow {
  return {
    key: fields.key,
    label: fields.label,
    type: "quota",
    method: fields.method,
    authority: "provider_reported",
    prominence: "primary",
    ...(fields.window ? { window: fields.window } : {}),
    percentRemaining: fields.percentRemaining,
    ...(fields.used !== undefined ? { used: fields.used } : {}),
    ...(fields.limit !== undefined ? { limit: fields.limit } : {}),
    // An empty reset time means the provider gave none.
    ...(fields.resetsAt ? { resetsAt: fields.resetsAt } : {}),
    ...(fields.windowStartedAt ? { windowStartedAt: fields.windowStartedAt } : {}),
  };
}

/** A remote, provider-reported quota row with the percent left: most providers' row. */
export function quotaRow(fields: {
  key: string;
  label: string;
  window?: QuotaWindow;
  percentRemaining: number;
  resetsAt?: string;
  windowStartedAt?: string;
}): ProviderRow {
  return windowRow({ ...fields, method: "remote_api" });
}

/** One window of a provider reply: the percent left, the counts when it has them, when it resets
 * and when it started. */
export type WindowValue = {
  percentRemaining: number;
  resetTimeIso?: string;
  fixedWindow?: { startedAtIso: string };
  /** The counts a window reports besides the percent, such as the requests a Coding Plan window used. */
  used?: Amount;
  limit?: Amount;
};

/** One window's slot: the row key it takes, the label it shows and the window it is. */
export type Slot = { key: string; label: string; window: QuotaWindow };

/** One window of a provider reply: the slot that names it and the value it reported. */
export type WindowRow = {
  slot: Slot;
  value: WindowValue | undefined;
};

/** A quota row for each window the provider reported, in the given order. A window the provider
 * reports no quota for has no row: there is nothing to show for it. */
export function windowRows(
  windows: readonly WindowRow[],
  method: ProviderRow["method"] = "remote_api",
): ProviderRow[] {
  const rows: ProviderRow[] = [];
  for (const { slot, value } of windows) {
    if (!value) continue;
    rows.push(
      windowRow({
        key: slot.key,
        label: slot.label,
        window: slot.window,
        method,
        percentRemaining: value.percentRemaining,
        ...(value.used !== undefined ? { used: value.used } : {}),
        ...(value.limit !== undefined ? { limit: value.limit } : {}),
        ...(value.resetTimeIso !== undefined ? { resetsAt: value.resetTimeIso } : {}),
        ...(value.fixedWindow ? { windowStartedAt: value.fixedWindow.startedAtIso } : {}),
      }),
    );
  }
  return rows;
}

/** An account with one error and no rows. */
export function failedAccount(name: string, message: string, facts?: ErrorFacts): AccountResult {
  return { name, rows: [], errors: [fetchError(message, facts)] };
}

/** An error with its request's facts, when there are some. */
export function fetchError(message: string, facts?: ErrorFacts): FetchError {
  return facts ? { message, facts } : { message };
}

/** What one login gave: its rows and errors, or null when it had nothing to query. */
export type LoginFetch = {
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
