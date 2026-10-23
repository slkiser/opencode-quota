/**
 * Provider results as v6 rows. Every provider returns the row contract (`ProviderFetchResult`,
 * see `providers/contract.ts`); each row gets its id (`${providerId}.${key}`), its provider and
 * its account's account text.
 */

import { sanitizeSingleLineDisplaySnippet } from "../lib/display-sanitize.js";
import { getQuotaProviderGroupBrands } from "../lib/provider-metadata.js";
import { QUOTA_PROVIDERS_AGGREGATE_ID } from "../lib/quota-providers.js";
import type { ProviderFetchResult } from "../providers/contract.js";
import { errorKind, providerError } from "./errors.js";
import { publicDebugValue } from "./redact.js";
import type { ProviderFetch } from "./store.js";
import type { DebugDetail, QuotaRow } from "./types.js";
import { validateRows } from "./validate.js";

const DEBUG_VALUE_MAX_LENGTH = 300;

/** "(Pro)" → "Pro", ": Standard [code]" → "Standard". */
function unwrap(text: string): string {
  let result = text.trim().replace(/^:\s*/u, "");
  const parens = /^\((.*)\)$/u.exec(result);
  if (parens) result = parens[1] ?? "";
  const withoutCode = result.replace(/\s*\[[^\]]*\]$/u, "").trim();
  return withoutCode || result.trim();
}

function stripBrand(providerId: string, text: string): string {
  const brand = getQuotaProviderGroupBrands(providerId).find(
    (name) => text === name || text.startsWith(`${name} `) || text.startsWith(`${name}:`),
  );
  return brand ? text.slice(brand.length) : text;
}

/**
 * The account or plan in a legacy group: "OpenAI (Pro)" → "Pro", "[Claude Work] (active)" →
 * "Work", "[OpenAI Work] (Business)" → "Work (Business)". "(active)" is dropped: it moves
 * when the user switches logins, and the account must stay the same.
 */
export function accountFromGroup(
  providerId: string,
  group: string | undefined,
): string | undefined {
  if (!group) return undefined;
  const text = group.replace(/\s*\(active\)/gu, "").trim();
  if (providerId === QUOTA_PROVIDERS_AGGREGATE_ID) return text || undefined;
  const bracket = /^\[([^\]]*)\]\s*(.*)$/u.exec(text);
  const alias = unwrap(stripBrand(providerId, bracket ? (bracket[1] ?? "") : text));
  const category = bracket ? (bracket[2] ?? "").trim() : "";
  const account = alias && category ? `${alias} ${category}` : alias || unwrap(category);
  return account || undefined;
}

/** A candidate row and the login it came from ("" when the provider has one login). */
type Candidate = { row: Record<string, unknown>; login: string };

/**
 * Drops a row repeated for one login (same id and account). Logins that share an account text
 * keep it here; the store tells them apart, as it also sees logins that failed this time.
 */
function dropRepeatedRows(candidates: readonly Candidate[], debug: DebugDetail[]): Candidate[] {
  const seen = new Set<string>();
  return candidates.filter(({ row, login }) => {
    const slot = `${String(row.id)}\u001f${String(row.account ?? "")}\u001f${login}`;
    if (!seen.has(slot)) {
      seen.add(slot);
      return true;
    }
    debug.push({ key: "dropped_row", value: `${String(row.id)}: repeated row` });
    return false;
  });
}

/**
 * Debug details are kept for /quota_status, as a public issue may show them (see
 * `publicDetail`): hidden before they are cut, so a cut never leaves part of a hidden value.
 * A key is a name the adapter or this file chose, so it is only cleaned and shortened.
 */
function detail(key: string, value: string): DebugDetail {
  return {
    key: sanitizeSingleLineDisplaySnippet(key, 64),
    value: publicDebugValue(key, value, DEBUG_VALUE_MAX_LENGTH),
  };
}

/**
 * A provider result as v6 rows, the error to show and the debug details. Each row is checked on
 * its own, so it keeps its login. `rowLogins` holds the logins as the provider gave them; the
 * provider source keys them before the store gets them.
 */
export function rowsFromProviderResult(
  providerId: string,
  result: ProviderFetchResult,
  nowMs: number = Date.now(),
): ProviderFetch {
  const debug = result.debug.map((item) => detail(item.key, item.value));
  const candidates: Candidate[] = result.accounts.flatMap((account) => {
    const accountText = accountFromGroup(providerId, account.name);
    return account.rows.map(({ key, ...fields }) => ({
      row: {
        ...fields,
        id: `${providerId}.${key}`,
        providerId,
        ...(accountText ? { account: accountText } : {}),
      },
      login: account.login ?? "",
    }));
  });
  const rows: QuotaRow[] = [];
  const rowLogins: string[] = [];
  for (const { row, login } of dropRepeatedRows(candidates, debug)) {
    const checked = validateRows(providerId, [row]);
    debug.push(...checked.dropped);
    for (const clean of checked.rows) {
      rows.push(clean);
      rowLogins.push(login);
    }
  }
  const logins = rowLogins.some(Boolean) ? { rowLogins } : {};

  const errors = result.accounts.flatMap((account) =>
    account.errors.map((error) => ({
      account: account.name,
      message: error.message,
      // Read from the message alone, so a number or word in the account name is never its kind.
      error: providerError(error.message, error.facts, nowMs),
    })),
  );
  for (const error of errors) {
    debug.push(detail("error", `${error.account}: ${error.message}`));
    debug.push(detail("error_kind", errorKind(error.error)));
  }
  const [firstError] = errors;
  if (firstError) return { rows, ...logins, error: firstError.error, debug };
  if (!result.attempted && rows.length === 0) {
    return { rows: [], error: { code: "not_configured" }, debug };
  }
  return { rows, ...logins, debug };
}
