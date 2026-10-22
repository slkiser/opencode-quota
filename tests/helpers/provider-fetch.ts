/**
 * The world of a provider fetch test: temp OpenCode folders (never this machine's real ones),
 * API keys in the environment, logins in a temp `opencode.db`, and fake HTTP. Call
 * `useProviderWorld()` once per test file.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, vi } from "vite-plus/test";

import { rowsFromProviderResult } from "../../src/core/rows.js";
import type { Amount, QuotaRow } from "../../src/core/types.js";
import { API_KEY_VENDORS } from "../../src/lib/api-key-resolver.js";
import type { QuotaProvider } from "../../src/lib/entries.js";
import { createSqliteCredentialSource } from "../../src/lib/opencode-auth-sqlite.js";
import { bindCredentialSource, notifyCredentialsChanged } from "../../src/lib/opencode-auth.js";
import { type CredentialDatabaseRow, writeCredentialDatabase } from "./credential-database.js";
import { NO_PROJECT_DIRECTORY, useOpencodeFolders } from "./opencode-folders.js";
import { isLedgerRowKey } from "./provider-assertions.js";

/** Environment variables a vendor may read a key, cookie or folder from. */
const PROVIDER_ENV_NAMES = [
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_DB",
  "MIMO_USAGE_COOKIE",
  "OPENROUTER_API_KEY",
  // The Alibaba CLI reads these for the seat command; a test must not inherit a real one.
  "ALIBABA_CLOUD_ACCESS_KEY_ID",
  "ALIBABA_CLOUD_ACCESS_KEY_SECRET",
  ...Object.values(API_KEY_VENDORS).flatMap((spec) => spec.envVars),
];

export type ProviderWorld = {
  /** The temp folder that holds the OpenCode folders; a test may put other files here too. */
  readonly root: string;
  /** OpenCode's config folder (`opencode.json`, `opencode-quota/…`). */
  readonly configDir: string;
  /** Stores these logins in OpenCode's database, replacing any stored before. */
  storeLogins(rows: readonly CredentialDatabaseRow[]): void;
  /** Writes a file below the config folder. */
  writeConfigFile(relativePath: string, content: string): void;
  /** Writes a file below OpenCode's cache folder (its plugin packages); returns its path. */
  writeCacheFile(relativePath: string, content: string): string;
};

/** Temp OpenCode folders and a bound credential reader for each test; see the file header. */
export function useProviderWorld(): ProviderWorld {
  const folders = useOpencodeFolders();
  const originalEnv = process.env;
  let unbind = () => {};

  const world: ProviderWorld = {
    root: folders.root,
    configDir: folders.configDir,
    storeLogins(rows) {
      const databasePath = join(folders.dataDir, "opencode.db");
      rmSync(databasePath, { force: true });
      mkdirSync(dirname(databasePath), { recursive: true });
      writeCredentialDatabase(databasePath, rows);
      notifyCredentialsChanged();
    },
    writeConfigFile(relativePath, content) {
      const path = join(world.configDir, relativePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    },
    writeCacheFile(relativePath, content) {
      const path = join(folders.cacheDir, relativePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
      return path;
    },
  };

  beforeEach(() => {
    process.env = { ...originalEnv };
    for (const name of PROVIDER_ENV_NAMES) delete process.env[name];
    unbind = bindCredentialSource(createSqliteCredentialSource());
    notifyCredentialsChanged();
  });

  afterEach(() => {
    unbind();
    notifyCredentialsChanged();
    process.env = originalEnv;
  });

  return world;
}

/** One stored API-key login. */
export function keyLogin(
  id: string,
  integrationId: string,
  key: unknown,
  fields: Partial<CredentialDatabaseRow> = {},
): CredentialDatabaseRow {
  return { id, integrationId, active: null, updated: 1, value: { type: "api", key }, ...fields };
}

type FakeReply = Response | unknown;

/**
 * Answers every `fetch` with `reply(url, init)`: a Response as is, anything else as a JSON 200.
 * Returns the mock, so a test can check the URLs and headers it was called with.
 */
export function fakeHttp(
  reply: (url: string, init: RequestInit) => FakeReply | Promise<FakeReply>,
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const answer = await reply(String(input), init);
    return answer instanceof Response ? answer : new Response(JSON.stringify(answer));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The header a fake HTTP call was made with. */
export function requestHeader(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

/**
 * The provider's fetch, as the store gets it: rows with ids and accounts, the error, debug.
 * Fails the test when a row key is not one of the provider's `PROVIDER_ROW_KEYS`.
 */
export async function fetchRows(
  provider: Pick<QuotaProvider, "id" | "fetch">,
  config: Record<string, unknown> = {},
) {
  const result = await provider.fetch({
    locationDirectory: NO_PROJECT_DIRECTORY,
    config: { requestTimeoutMs: 5_000, enabledProviders: [], ...config },
  } as never);
  const fetched = rowsFromProviderResult(provider.id, result, Date.now());
  for (const row of fetched.rows) {
    expect(isLedgerRowKey(provider.id, row.id.slice(provider.id.length + 1)), row.id).toBe(true);
  }
  return fetched;
}

function amountText(amount: Amount | undefined): string | undefined {
  if (!amount) return undefined;
  const unit = amount.unit;
  const name =
    unit.kind === "currency" ? unit.code : unit.kind === "count" ? unit.unit : unit.symbol;
  return `${amount.decimal} ${name}`;
}

/** The value a row shows: its percent left, amount, flag or text, plus used/limit when given. */
function rowValue(row: QuotaRow): string | number | boolean | null {
  const value = row.percentRemaining ?? amountText(row.amount) ?? row.flag ?? row.text ?? null;
  const used = amountText(row.used);
  const limit = amountText(row.limit);
  return used || limit ? `${value} (${used ?? "?"} of ${limit ?? "?"})` : value;
}

/** Compact rows for tables: [id, account, label, window, value, resets at]. */
export function rowSummary(rows: readonly QuotaRow[]) {
  return rows.map((row) => [
    row.id,
    row.account ?? null,
    row.label,
    row.window ?? null,
    rowValue(row),
    row.resetsAt ?? null,
  ]);
}
