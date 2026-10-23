/**
 * OpenCode login reader
 *
 * Reads OpenCode 2 logins through the bound credential source. The server
 * plugin binds its integration API (`ctx.integration`) in `setup`; the terminal
 * command binds the read-only database reader in `opencode-auth-sqlite.ts`
 * while one report runs; the TUI binds nothing, so a read there finds no login.
 * Every read names the integration ids it needs, so OpenCode resolves (and may
 * refresh) only those logins.
 */

import type { Plugin } from "@opencode/plugin";

import { safeErrorText } from "../core/redact.js";
import { getOpenCodeDbPath } from "./opencode-db-path.js";

type RowCacheEntry = {
  timestamp: number;
  value: CredentialRow[];
  inFlight?: Promise<CredentialRow[]>;
};

export type CredentialRow = {
  id: string;
  integrationId: string;
  label: string;
  /**
   * Whether OpenCode uses this login. The integration source marks, per
   * integration id, the connection `connection.active(integrationId)` reports;
   * the database reader marks the database's active row.
   */
  active: boolean;
  value: Record<string, unknown>;
  /**
   * Why OpenCode could not return this login (for example a failed token
   * refresh), as `<category>: <scrubbed detail>`. A failed row keeps its id,
   * label and position, but its `value` is only `{ type: "api" | "oauth" | "external" }`;
   * consumers show `resolveError` as a per-account error.
   */
  resolveError?: string;
};

/**
 * The OpenCode 2 connection methods a read can ask for: a stored API key or an OAuth
 * sign-in. OpenCode's third method, `external` (an AWS profile, Azure CLI or gcloud
 * login), keeps its secrets outside OpenCode, so no read asks for it.
 */
export type CredentialMethod = "key" | "oauth";

type ReadCredentialRowsOptions = {
  /** Keep only connections using one of these methods; checked before OpenCode resolves them. */
  methods?: readonly CredentialMethod[];
  /** Read only the active connection of each integration id. */
  firstOnly?: boolean;
};

type CredentialReadRequest = ReadCredentialRowsOptions & {
  integrationIds: readonly string[];
};

export type CredentialSourceKind = "opencode-integration-api" | "sqlite";

/**
 * Where logins come from. The two production sources: `ctx.integration` in the
 * server plugin, and the terminal command's read-only reader of OpenCode's database.
 */
export type CredentialSource = {
  kind: CredentialSourceKind;
  readRows(request: CredentialReadRequest): Promise<CredentialRow[]>;
};

/** The parts of the server plugin's `ctx.integration` the reader uses. */
type CredentialIntegration = Pick<Plugin.Context["integration"], "list" | "connection">;

type Connection = NonNullable<Awaited<ReturnType<CredentialIntegration["connection"]["active"]>>>;
type CredentialConnection = Extract<Connection, { type: "credential" }>;
type CredentialValue = NonNullable<
  Awaited<ReturnType<CredentialIntegration["connection"]["resolve"]>>
>;

type CredentialFailureCategory = "refresh_failed" | "resolve_empty" | "active_failed";

type CredentialFailure = {
  at: number;
  category: CredentialFailureCategory;
  detail: string;
  integrationId: string;
  label: string;
};

export type CredentialSourceDiagnostics = (
  | { state: "bound"; kind: CredentialSourceKind }
  | { state: "unbound" }
) & {
  lastListError?: { at: number; detail: string };
  failures: Array<CredentialFailure & { connectionId: string }>;
};

/** A failed login is resolved again at most this often. */
const FAILED_LOGIN_RETRY_MS = 60_000;

/** Bound sources; reads use the last one. */
const credentialSources: Array<{ source: CredentialSource }> = [];
let unboundWarningShown = false;
/**
 * Failed logins, keyed by connection id (by integration id for a failed
 * `active()`, which has no connection). An entry lives until that login reads
 * again, a credential event arrives, or `notifyCredentialsChanged` runs.
 */
const credentialFailures = new Map<string, CredentialFailure>();
/** One `resolve()` at a time per connection id. */
const pendingResolves = new Map<string, Promise<ResolveOutcome>>();
let lastListError: { at: number; detail: string } | undefined;

/**
 * Connection labels OpenCode assigns when the user never named the connection:
 * `default` for a new connection, and `OAuth` / `API key` for credentials
 * imported from the legacy auth.json. They say nothing about the account, so
 * they must not appear in headers like `[OpenAI OAuth]`.
 */
const GENERIC_CREDENTIAL_LABELS: ReadonlySet<string> = new Set(["default", "oauth", "api key"]);

export function formatCredentialDisplayNames(
  providerName: string,
  credentials: ReadonlyArray<{
    row: CredentialRow;
    fallbackName: string;
    numberUnnamed?: boolean;
  }>,
): string[] {
  const aliases = credentials.map(({ row }) => {
    const alias = row.label.trim();
    return !alias ||
      GENERIC_CREDENTIAL_LABELS.has(alias.toLowerCase()) ||
      alias.toLowerCase() === providerName.toLowerCase()
      ? ""
      : alias;
  });
  // Only opted-in providers reserve explicit aliases before generating numbers.
  // A user-named "2" must not collide with the second unnamed account.
  const occupiedAliases = credentials.some(({ numberUnnamed }) => numberUnnamed)
    ? new Set(aliases.filter(Boolean))
    : undefined;
  const counts = new Map<string, number>();
  return credentials.map(({ row, fallbackName, numberUnnamed = false }, index) => {
    const fallbackCategory = fallbackName
      .trim()
      .replace(new RegExp(`^${providerName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*`, "iu"), "")
      .trim()
      .replace(/^\((.*)\)$/u, "$1")
      .trim();
    const aliasKey = aliases[index];
    const shouldNumber = Boolean(aliasKey) || numberUnnamed;
    let duplicate = shouldNumber ? (counts.get(aliasKey) ?? 0) + 1 : 1;
    let numberedAlias = duplicate === 1 ? aliasKey : `${aliasKey} ${duplicate}`.trim();
    while (duplicate > 1 && occupiedAliases?.has(numberedAlias)) {
      duplicate += 1;
      numberedAlias = `${aliasKey} ${duplicate}`.trim();
    }
    if (shouldNumber) {
      counts.set(aliasKey, duplicate);
      occupiedAliases?.add(numberedAlias);
    }
    const base = `[${providerName}${numberedAlias ? ` ${numberedAlias}` : ""}]`;
    const category = fallbackCategory ? ` (${fallbackCategory})` : "";
    // Only a provider with several logins marks the one OpenCode uses.
    const active = credentials.length > 1 && row.active;
    return `${base}${category}${active ? " (active)" : ""}`;
  });
}

/** Cached active logins keyed by the sorted integration id list and the method filter. */
const rowCache = new Map<string, RowCacheEntry>();
/** Changes when the cache is dropped, so a read started before that does not refill it. */
let rowCacheGeneration = 0;

/**
 * The database OpenCode keeps its logins in: the one resolved path, or none
 * when `OPENCODE_DB` is `:memory:`. Inside OpenCode it is for diagnostics only
 * (logins are read through OpenCode); the terminal command reads its logins
 * from this file.
 */
export function getCredentialDatabasePaths(): string[] {
  const path = getOpenCodeDbPath();
  return path === ":memory:" ? [] : [path];
}

/**
 * Makes `source` the one reads use until the returned function unbinds it.
 * Unbinding removes only this binding; the last binding still bound wins.
 */
export function bindCredentialSource(source: CredentialSource): () => void {
  const binding = { source };
  credentialSources.push(binding);
  return () => {
    const index = credentialSources.indexOf(binding);
    if (index !== -1) credentialSources.splice(index, 1);
  };
}

/** Drops cached logins, failed-login entries and the last `list()` error. */
export function notifyCredentialsChanged(): void {
  credentialFailures.clear();
  rowCache.clear();
  rowCacheGeneration += 1;
  lastListError = undefined;
}

export function getCredentialSourceDiagnostics(): CredentialSourceDiagnostics {
  const source = credentialSources.at(-1)?.source;
  return {
    ...(source ? { state: "bound" as const, kind: source.kind } : { state: "unbound" as const }),
    ...(lastListError ? { lastListError: { ...lastListError } } : {}),
    failures: Array.from(credentialFailures, ([connectionId, failure]) => ({
      integrationId: failure.integrationId,
      connectionId,
      label: failure.label,
      category: failure.category,
      detail: failure.detail,
      at: failure.at,
    })),
  };
}

type ConnectionSlot =
  | { integrationId: string; connection: CredentialConnection }
  | { integrationId: string; activeFailure: CredentialFailure };

type ResolveOutcome = { value: CredentialValue } | { failure: CredentialFailure };

/** The active connection of one integration id; works for ids OpenCode has not registered. */
async function activeConnectionSlots(
  integration: CredentialIntegration,
  integrationId: string,
): Promise<ConnectionSlot[]> {
  try {
    const connection = await integration.connection.active(integrationId);
    credentialFailures.delete(integrationId);
    // An env connection means no stored login; providers apply their own env rules.
    return connection?.type === "credential" ? [{ integrationId, connection }] : [];
  } catch (error) {
    const activeFailure: CredentialFailure = {
      at: Date.now(),
      category: "active_failed",
      detail: safeErrorText(error),
      integrationId,
      label: "",
    };
    credentialFailures.set(integrationId, activeFailure);
    return [{ integrationId, activeFailure }];
  }
}

/**
 * The stored connection `active()` reports for a listed id, without recording
 * anything: a failed lookup or an active env connection only leaves every
 * listed row inactive, instead of marking another row or failing the read.
 */
async function activeListedConnection(
  integration: CredentialIntegration,
  integrationId: string,
): Promise<CredentialConnection | undefined> {
  try {
    const connection = await integration.connection.active(integrationId);
    return connection?.type === "credential" ? connection : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every connection of the requested ids: all of them for ids `list()` shows
 * (registered integrations), the active one for any other id. Per id,
 * `activeConnections` holds the stored connection `active()` reports: for an
 * unlisted id its one row itself; for a listed id a separate lookup, where a
 * failed lookup or an active env connection marks none of its rows.
 */
async function listedConnectionSlots(
  integration: CredentialIntegration,
  integrationIds: readonly string[],
): Promise<{ slots: ConnectionSlot[]; activeConnections: Map<string, CredentialConnection> }> {
  let listed: Map<string, readonly Connection[]> | undefined;
  try {
    const { data } = await integration.list();
    listed = new Map(data.map((info) => [info.id, info.connections]));
    lastListError = undefined;
  } catch (error) {
    // One malformed login anywhere makes list() fail; each id's active login still reads.
    lastListError = { at: Date.now(), detail: safeErrorText(error) };
  }

  const slots: ConnectionSlot[] = [];
  const activeConnections = new Map<string, CredentialConnection>();
  for (const integrationId of integrationIds) {
    const connections = listed?.get(integrationId);
    if (connections === undefined) {
      for (const slot of await activeConnectionSlots(integration, integrationId)) {
        slots.push(slot);
        if ("connection" in slot) activeConnections.set(integrationId, slot.connection);
      }
      continue;
    }
    const credentials = connections.filter(
      (connection): connection is CredentialConnection => connection.type === "credential",
    );
    if (credentials.length === 0) continue;
    for (const connection of credentials) slots.push({ integrationId, connection });
    const active = await activeListedConnection(integration, integrationId);
    if (active) activeConnections.set(integrationId, active);
  }
  return { slots, activeConnections };
}

function recordResolveFailure(
  connection: CredentialConnection,
  failure: Omit<CredentialFailure, "at" | "label">,
): ResolveOutcome {
  const recorded: CredentialFailure = { ...failure, at: Date.now(), label: connection.label };
  credentialFailures.set(connection.id, recorded);
  return { failure: recorded };
}

/**
 * Resolves one connection (OpenCode may refresh its token). A login that failed
 * less than a minute ago is not resolved again; concurrent reads share one call.
 */
function resolveCredentialConnection(
  integration: CredentialIntegration,
  integrationId: string,
  connection: CredentialConnection,
): Promise<ResolveOutcome> {
  const failure = credentialFailures.get(connection.id);
  if (failure && Date.now() - failure.at < FAILED_LOGIN_RETRY_MS) {
    return Promise.resolve({ failure });
  }
  const pending = pendingResolves.get(connection.id);
  if (pending) return pending;

  const outcome = (async (): Promise<ResolveOutcome> => {
    try {
      const value = await integration.connection.resolve(connection);
      if (value === undefined) {
        return recordResolveFailure(connection, {
          category: "resolve_empty",
          detail: "OpenCode returned no login",
          integrationId,
        });
      }
      credentialFailures.delete(connection.id);
      return { value };
    } catch (error) {
      return recordResolveFailure(connection, {
        category: "refresh_failed",
        detail: safeErrorText(error),
        integrationId,
      });
    }
  })().finally(() => {
    pendingResolves.delete(connection.id);
  });
  pendingResolves.set(connection.id, outcome);
  return outcome;
}

/** The value resolvers read: metadata fields on top (kept under `metadata` too), `key` as `api`. */
function credentialRowValue(value: CredentialValue): Record<string, unknown> {
  const flattened: Record<string, unknown> = { ...value.metadata, ...value };
  if (flattened.type === "key") flattened.type = "api";
  return flattened;
}

async function credentialRowForSlot(
  integration: CredentialIntegration,
  slot: ConnectionSlot,
  methods: readonly CredentialMethod[] | undefined,
): Promise<CredentialRow> {
  if ("activeFailure" in slot) {
    const failure = slot.activeFailure;
    return {
      id: slot.integrationId,
      integrationId: slot.integrationId,
      label: "",
      active: false,
      // A failed active() has no connection, so its method is unknown: a key-only read
      // gets a key-shaped failure, every other read an OAuth-shaped one.
      value: { type: methods && !methods.includes("oauth") ? "api" : "oauth" },
      resolveError: `${failure.category}: ${failure.detail}`,
    };
  }

  const { connection } = slot;
  const outcome = await resolveCredentialConnection(integration, slot.integrationId, connection);
  const row = {
    id: connection.id,
    integrationId: slot.integrationId,
    label: connection.label,
    active: false,
  };
  return "value" in outcome
    ? { ...row, value: credentialRowValue(outcome.value) }
    : {
        ...row,
        value: { type: connection.method === "key" ? "api" : connection.method },
        resolveError: `${outcome.failure.category}: ${outcome.failure.detail}`,
      };
}

/**
 * Resolves the wanted slots into rows and marks the active login: with
 * `activeConnections`, the row holding the connection `active()` reported for
 * its integration id (a failed lookup or an active env connection marks none
 * of that id's rows); without it, the first row of the first requested id that
 * has rows, since a firstOnly read returns one active connection per id.
 */
async function credentialRowsForSlots(
  integration: CredentialIntegration,
  slots: readonly ConnectionSlot[],
  methods: readonly CredentialMethod[] | undefined,
  activeConnections?: ReadonlyMap<string, CredentialConnection>,
): Promise<CredentialRow[]> {
  const wanted = slots.filter(
    (slot) =>
      !methods ||
      !("connection" in slot) ||
      (slot.connection.method !== "external" && methods.includes(slot.connection.method)),
  );
  return Promise.all(
    wanted.map(async (slot, index) => {
      const row = await credentialRowForSlot(integration, slot, methods);
      const active = activeConnections
        ? "connection" in slot &&
          slot.connection.id === activeConnections.get(slot.integrationId)?.id
        : index === 0;
      return { ...row, active };
    }),
  );
}

/** The credential source backed by the server plugin's `ctx.integration`. */
export function createIntegrationCredentialSource(
  integration: CredentialIntegration,
): CredentialSource {
  return {
    kind: "opencode-integration-api",
    async readRows(request) {
      if (request.firstOnly) {
        const slots: ConnectionSlot[] = [];
        for (const integrationId of request.integrationIds) {
          slots.push(...(await activeConnectionSlots(integration, integrationId)));
        }
        return credentialRowsForSlots(integration, slots, request.methods);
      }

      const { slots, activeConnections } = await listedConnectionSlots(
        integration,
        request.integrationIds,
      );
      return credentialRowsForSlots(integration, slots, request.methods, activeConnections);
    },
  };
}

/**
 * The first row of each integration id, in order. Rows come active first, so these are the
 * logins OpenCode uses.
 */
export function activeCredentialRows(rows: readonly CredentialRow[]): CredentialRow[] {
  const active = new Map<string, CredentialRow>();
  for (const row of rows) if (!active.has(row.integrationId)) active.set(row.integrationId, row);
  return [...active.values()];
}

/**
 * An OAuth sign-in read from its credential row. `failed`: OpenCode could not return it (see
 * `CredentialRow.resolveError`). Otherwise its tokens (trimmed; none when blank or not text),
 * its expiry (a finite number), and every field as stored, for the fields one vendor knows.
 */
export type OAuthLogin =
  | { state: "failed"; error: string }
  | {
      state: "signed-in";
      accessToken?: string;
      refreshToken?: string;
      expiresAt?: number;
      fields: Readonly<Record<string, unknown>>;
    };

function trimmedText(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

/** The OAuth sign-in a row holds; null for a row of another method. */
export function readOAuthLogin(row: CredentialRow): OAuthLogin | null {
  const { value } = row;
  if (value.type !== "oauth") return null;
  if (row.resolveError !== undefined) return { state: "failed", error: row.resolveError };
  const accessToken = trimmedText(value.access);
  const refreshToken = trimmedText(value.refresh);
  const expiresAt =
    typeof value.expires === "number" && Number.isFinite(value.expires) ? value.expires : undefined;
  return {
    state: "signed-in",
    ...(accessToken ? { accessToken } : {}),
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    fields: value,
  };
}

/**
 * Credential rows of the requested integration ids from the last bound source.
 * Row order depends on the source: the integration API returns request-id
 * order, then OpenCode's connection order (active first, then newest); the
 * database reader returns database order. With no bound source (the TUI) there
 * are none.
 */
export async function readCredentialRows(
  integrationIds: readonly string[],
  options: ReadCredentialRowsOptions = {},
): Promise<CredentialRow[]> {
  const source = credentialSources.at(-1)?.source;
  if (!source) {
    if (!unboundWarningShown) {
      unboundWarningShown = true;
      console.warn("[opencode-quota] credential source is not bound");
    }
    return [];
  }
  return source.readRows({ integrationIds, ...options });
}

/** JSON-like text of `value` with object keys sorted, so key order does not matter. */
function canonicalCredentialValueKey(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalCredentialValueKey(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalCredentialValueKey(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/**
 * Collapse credential rows that represent the same upstream connection.
 *
 * Rows holding identical credential values are the same connection (e.g. the
 * same workspace key stored under the `opencode-go` integration and its legacy
 * `opencode` alias), and rows under `primaryIntegrationId` take precedence over
 * alias rows so a real credential for another integration that shares the key
 * is not reported as an additional connection. A failed row holds only
 * `{ type }`, so its connection id keeps each failed login a row of its own.
 * Input order is preserved otherwise.
 */
export function selectConnectionCredentialRows(
  rows: readonly CredentialRow[],
  primaryIntegrationId: string,
): CredentialRow[] {
  const primaryRows = rows.filter((row) => row.integrationId === primaryIntegrationId);
  const candidates = primaryRows.length > 0 ? primaryRows : [...rows];
  const seen = new Set<string>();
  const selected: CredentialRow[] = [];
  for (const row of candidates) {
    const key =
      row.resolveError === undefined
        ? canonicalCredentialValueKey(row.value)
        : canonicalCredentialValueKey({ failedConnectionId: row.id, value: row.value });
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(row);
  }
  return selected;
}

/**
 * The active login of each requested integration id (a `firstOnly` read), cached for
 * `maxAgeMs`: per-question hooks read often, and login changes still show quickly.
 */
export async function readActiveCredentialRowsCached(params: {
  maxAgeMs: number;
  integrationIds: readonly string[];
  methods?: readonly CredentialMethod[];
}): Promise<CredentialRow[]> {
  const maxAgeMs = Math.max(0, params.maxAgeMs);
  const cacheKey = `${[...params.integrationIds].sort().join(",")}|${
    params.methods ? [...params.methods].sort().join(",") : "any"
  }`;
  const cached = rowCache.get(cacheKey);
  const now = Date.now();

  if (cached && now - cached.timestamp <= maxAgeMs) {
    return cached.value;
  }

  if (cached?.inFlight) {
    return cached.inFlight;
  }

  const generation = rowCacheGeneration;
  const inFlight = (async () => {
    const value = await readCredentialRows(params.integrationIds, {
      methods: params.methods,
      firstOnly: true,
    });
    // A login change during the read may make this value stale: return it, but do not cache it.
    if (generation === rowCacheGeneration) {
      rowCache.set(cacheKey, { timestamp: Date.now(), value });
    }
    return value;
  })();

  rowCache.set(cacheKey, {
    timestamp: cached?.timestamp ?? 0,
    value: cached?.value ?? [],
    inFlight,
  });

  try {
    return await inFlight;
  } finally {
    const entry = rowCache.get(cacheKey);
    if (entry?.inFlight === inFlight) {
      entry.inFlight = undefined;
    }
  }
}

/** Test helper to clear cached logins between test cases. */
export function clearCredentialRowCacheForTests(): void {
  rowCache.clear();
  rowCacheGeneration += 1;
}
