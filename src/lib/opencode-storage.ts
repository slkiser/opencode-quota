import { existsSync } from "fs";

import { getOpenCodeDbPath } from "./opencode-db-path.js";
import { openOpenCodeSqliteReadOnly, type SqliteConn } from "./opencode-sqlite.js";

/**
 * Error thrown when a session is not found.
 *
 * OpenCode 2 stores sessions and messages in SQLite (`opencode.db`) under the
 * `session_v2` and `session_message` tables. This is thrown by
 * iterAssistantMessagesForSession when the database is missing/unreadable, the
 * session id is invalid, or the session row does not exist.
 */
export class SessionNotFoundError extends Error {
  constructor(
    public readonly sessionID: string,
    public readonly checkedPath: string,
  ) {
    super(`Session not found: ${sessionID}`);
    this.name = "SessionNotFoundError";
  }
}

interface OpenCodeTokenCache {
  read: number;
  write: number;
}

interface OpenCodeTokens {
  input: number;
  output: number;
  reasoning?: number;
  cache: OpenCodeTokenCache;
}

export interface OpenCodeMessage {
  id: string;
  sessionID: string;
  role: "user" | "assistant" | string;
  providerID?: string;
  modelID?: string;
  tokens?: OpenCodeTokens;
  cost?: number;
  time?: {
    created?: number;
    completed?: number;
  };
  agent?: string;
  mode?: string;
}

export interface OpenCodeSessionInfo {
  id: string;
  title?: string;
  parentID?: string;
  time?: {
    created?: number;
    updated?: number;
  };
}

type OpenCodeDbStats = {
  dbPath: string;
  sessionCount: number;
  messageCount: number;
  assistantMessageCount: number;
};

type ProjectedMessageRow = {
  id: string;
  session_id: string;
  time_created: number;
  role: unknown;
  provider_id: unknown;
  model_id: unknown;
  tokens_input: unknown;
  tokens_output: unknown;
  tokens_reasoning: unknown;
  tokens_cache_read: unknown;
  tokens_cache_write: unknown;
  cost: unknown;
  time_completed: unknown;
  agent: unknown;
  mode: unknown;
};

type SessionRow = {
  id: string;
  title: string | null;
  parent_id: string | null;
  time_created: number;
  time_updated: number;
};

function normalizeNumber(n: unknown): number | undefined {
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

function normalizeString(s: unknown): string | undefined {
  return typeof s === "string" ? s : undefined;
}

function mapRowToOpenCodeMessage(row: ProjectedMessageRow): OpenCodeMessage | null {
  if (!row || typeof row !== "object") return null;
  if (typeof row.id !== "string" || typeof row.session_id !== "string") return null;
  if (typeof row.time_created !== "number") return null;

  const input = normalizeNumber(row.tokens_input);
  const output = normalizeNumber(row.tokens_output);
  const reasoning = normalizeNumber(row.tokens_reasoning);
  const cacheRead = normalizeNumber(row.tokens_cache_read);
  const cacheWrite = normalizeNumber(row.tokens_cache_write);
  const hasTokens = [input, output, reasoning, cacheRead, cacheWrite].some(
    (value) => value !== undefined,
  );

  return {
    id: row.id,
    sessionID: row.session_id,
    role: normalizeString(row.role) ?? "unknown",
    providerID: normalizeString(row.provider_id),
    modelID: normalizeString(row.model_id),
    tokens: hasTokens
      ? {
          input: input ?? 0,
          output: output ?? 0,
          ...(reasoning === undefined ? {} : { reasoning }),
          cache: { read: cacheRead ?? 0, write: cacheWrite ?? 0 },
        }
      : undefined,
    cost: normalizeNumber(row.cost),
    time: {
      created: row.time_created,
      completed: normalizeNumber(row.time_completed),
    },
    agent: normalizeString(row.agent),
    mode: normalizeString(row.mode),
  };
}

function openDbOrNull(): {
  dbPath: string;
  open: () => ReturnType<typeof openOpenCodeSqliteReadOnly>;
} | null {
  const dbPath = getOpenCodeDbPath();
  if (dbPath === ":memory:" || !existsSync(dbPath)) return null;
  return {
    dbPath,
    open: () => openOpenCodeSqliteReadOnly(dbPath),
  };
}

function guardedJsonScalar(path: string, column = "data"): string {
  return `CASE WHEN json_valid(${column}) THEN json_extract(${column}, '${path}') END`;
}

const PROJECTED_MESSAGE_COLUMNS = [
  "id",
  "session_id",
  "time_created",
  "type AS role",
  `${guardedJsonScalar("$.model.providerID")} AS provider_id`,
  `${guardedJsonScalar("$.model.id")} AS model_id`,
  `${guardedJsonScalar("$.tokens.input")} AS tokens_input`,
  `${guardedJsonScalar("$.tokens.output")} AS tokens_output`,
  `${guardedJsonScalar("$.tokens.reasoning")} AS tokens_reasoning`,
  `${guardedJsonScalar("$.tokens.cache.read")} AS tokens_cache_read`,
  `${guardedJsonScalar("$.tokens.cache.write")} AS tokens_cache_write`,
  `${guardedJsonScalar("$.cost")} AS cost`,
  `${guardedJsonScalar("$.time.completed")} AS time_completed`,
  `${guardedJsonScalar("$.agent")} AS agent`,
].join(", ");

const ASSISTANT_FILTER = `type = 'assistant'`;

function buildMessageQuery(params: { sinceMs?: number; untilMs?: number }): {
  sql: string;
  args: unknown[];
} {
  const where: string[] = [];
  const args: unknown[] = [];

  if (typeof params.sinceMs === "number") {
    where.push(`time_created >= ?`);
    args.push(params.sinceMs);
  }

  if (typeof params.untilMs === "number") {
    where.push(`time_created <= ?`);
    args.push(params.untilMs);
  }

  where.push(ASSISTANT_FILTER);

  const sql =
    `SELECT ${PROJECTED_MESSAGE_COLUMNS} FROM "session_message"` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    ` ORDER BY time_created ASC, id ASC`;

  return { sql, args };
}

async function hasJsonExtract(conn: {
  get<T = unknown>(sql: string, params?: unknown[]): T | null;
}): Promise<boolean> {
  try {
    const row = conn.get<{ r: string }>(
      "SELECT json_extract('{\"role\":\"assistant\"}', '$.role') as r",
    );
    return row?.r === "assistant";
  } catch {
    return false;
  }
}

function mapAssistantMessages(rows: ProjectedMessageRow[]): OpenCodeMessage[] {
  const out: OpenCodeMessage[] = [];
  for (const row of rows) {
    const msg = mapRowToOpenCodeMessage(row);
    if (!msg) continue;
    if (String(msg.role).toLowerCase() !== "assistant") continue;
    out.push(msg);
  }
  return out;
}

function completedAt(message: OpenCodeMessage): number | null {
  const value = message.time?.completed;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : null;
}

function mapCompletedAssistantMessages(rows: ProjectedMessageRow[]): OpenCodeMessage[] {
  return mapAssistantMessages(rows).filter((message) => completedAt(message) !== null);
}

function buildCompletedAssistantQuery(params: {
  completedSinceMs?: number;
  completedUntilMs?: number;
}): { sql: string; args: unknown[] } {
  const completedScalar = guardedJsonScalar("$.time.completed");
  const completedExpression = `CAST(${completedScalar} AS REAL)`;
  const where = [
    ASSISTANT_FILTER,
    `CASE WHEN json_valid(data) THEN json_type(data, '$.time.completed') END IN ('integer', 'real')`,
    `${completedExpression} > 0`,
  ];
  const args: unknown[] = [];

  if (typeof params.completedSinceMs === "number") {
    where.push(`${completedExpression} >= ?`);
    args.push(params.completedSinceMs);
  }
  if (typeof params.completedUntilMs === "number") {
    where.push(`${completedExpression} <= ?`);
    args.push(params.completedUntilMs);
  }

  return {
    sql:
      `SELECT ${PROJECTED_MESSAGE_COLUMNS} FROM "session_message"` +
      ` WHERE ${where.join(" AND ")}` +
      ` ORDER BY ${completedExpression} ASC, id ASC`,
    args,
  };
}

function forkCopyFingerprint(message: OpenCodeMessage, completed: number): string {
  const tokens = message.tokens;
  return JSON.stringify([
    message.time?.created,
    completed,
    message.providerID,
    message.modelID,
    tokens?.input,
    tokens?.output,
    tokens?.reasoning,
    tokens?.cache.read,
    tokens?.cache.write,
    message.cost,
  ]);
}

/**
 * OpenCode copies a parent's finished messages into each fork with new ids but
 * identical times, model, tokens, and cost. Count each finished fingerprint as
 * many times as the session that has it most often, and drop the extra copies.
 * Unfinished rows are always kept.
 */
function dropForkCopies(messages: OpenCodeMessage[]): OpenCodeMessage[] {
  const countBySessionFingerprint = new Map<string, number>();
  const keptCountByFingerprint = new Map<string, number>();
  const out: OpenCodeMessage[] = [];
  for (const message of messages) {
    const completed = completedAt(message);
    if (completed === null) {
      out.push(message);
      continue;
    }
    const fingerprint = forkCopyFingerprint(message, completed);
    const sessionFingerprintKey = JSON.stringify([message.sessionID, fingerprint]);
    const sessionCount = (countBySessionFingerprint.get(sessionFingerprintKey) ?? 0) + 1;
    countBySessionFingerprint.set(sessionFingerprintKey, sessionCount);
    const keptCount = keptCountByFingerprint.get(fingerprint) ?? 0;
    if (sessionCount <= keptCount) {
      continue;
    }
    keptCountByFingerprint.set(fingerprint, sessionCount);
    out.push(message);
  }
  return out;
}

export async function getOpenCodeDbStats(): Promise<OpenCodeDbStats> {
  const db = openDbOrNull();
  if (!db) {
    return {
      dbPath: getOpenCodeDbPath(),
      sessionCount: 0,
      messageCount: 0,
      assistantMessageCount: 0,
    };
  }

  const conn = await db.open();
  try {
    const sessionRow = conn.get<{ c: number }>(`SELECT count(*) as c FROM "session_v2"`);
    const messageRow = conn.get<{ c: number }>(`SELECT count(*) as c FROM "session_message"`);

    let assistantCount = 0;
    if (await hasJsonExtract(conn)) {
      const a = conn.get<{ c: number }>(
        `SELECT count(*) as c FROM "session_message" WHERE type = 'assistant'`,
      );
      assistantCount = typeof a?.c === "number" ? a.c : 0;
    }

    return {
      dbPath: db.dbPath,
      sessionCount: typeof sessionRow?.c === "number" ? sessionRow.c : 0,
      messageCount: typeof messageRow?.c === "number" ? messageRow.c : 0,
      assistantMessageCount: assistantCount,
    };
  } finally {
    conn.close();
  }
}

export async function iterAssistantMessages(params: {
  sinceMs?: number;
  untilMs?: number;
}): Promise<OpenCodeMessage[]> {
  const db = openDbOrNull();
  if (!db) return [];

  const conn = await db.open();
  try {
    if (!(await hasJsonExtract(conn))) return [];
    const q = buildMessageQuery({ sinceMs: params.sinceMs, untilMs: params.untilMs });
    const rows = conn.all<ProjectedMessageRow>(q.sql, q.args);
    return dropForkCopies(mapAssistantMessages(rows));
  } finally {
    conn.close();
  }
}

/**
 * Read authoritative completed assistant/model-loop rows by completion time.
 *
 * This path intentionally does not share the creation-time filters used by token
 * history. A request may be created before a window cutoff and complete inside it.
 */
export async function iterCompletedAssistantMessages(params: {
  completedSinceMs?: number;
  completedUntilMs?: number;
}): Promise<OpenCodeMessage[]> {
  const db = openDbOrNull();
  if (!db) return [];

  const conn = await db.open();
  try {
    if (await hasJsonExtract(conn)) {
      const query = buildCompletedAssistantQuery(params);
      return dropForkCopies(
        mapCompletedAssistantMessages(conn.all<ProjectedMessageRow>(query.sql, query.args)),
      );
    }

    return [];
  } finally {
    conn.close();
  }
}

const USAGE_MESSAGE_COLUMNS = [
  "message.id AS id",
  "message.session_id AS session_id",
  "message.time_created AS time_created",
  "message.type AS role",
  // A failed compaction names no model: its usage stays unpriced.
  `${guardedJsonScalar("$.model.providerID", "message.data")} AS provider_id`,
  `${guardedJsonScalar("$.model.id", "message.data")} AS model_id`,
  `${guardedJsonScalar("$.tokens.input", "message.data")} AS tokens_input`,
  `${guardedJsonScalar("$.tokens.output", "message.data")} AS tokens_output`,
  `${guardedJsonScalar("$.tokens.reasoning", "message.data")} AS tokens_reasoning`,
  `${guardedJsonScalar("$.tokens.cache.read", "message.data")} AS tokens_cache_read`,
  `${guardedJsonScalar("$.tokens.cache.write", "message.data")} AS tokens_cache_write`,
].join(", ");

const USAGE_MESSAGE_FILTERS = [
  // Assistant messages, and compactions that recorded usage (a running one has none yet).
  `(message.type = 'assistant' OR (message.type = 'compaction'` +
    ` AND ${guardedJsonScalar("$.tokens", "message.data")} IS NOT NULL))`,
  // A fork starts with copies of its parent's rows, all older than the fork; only the parent
  // counts them. OpenCode's own usage stats use the same rule.
  `(session.fork_session_id IS NULL OR message.time_created >= session.time_created)`,
];

type UsagePageCursor = { timeCreated: number; id: string };

function readUsagePage(
  conn: SqliteConn,
  filter: { sinceMs?: number; untilMs?: number; sessionID?: string },
  after: UsagePageCursor | null,
  pageSize: number,
): ProjectedMessageRow[] {
  const where = [...USAGE_MESSAGE_FILTERS];
  const args: unknown[] = [];
  if (filter.sessionID !== undefined) {
    where.push("message.session_id = ?");
    args.push(filter.sessionID);
  }
  if (typeof filter.sinceMs === "number") {
    where.push("message.time_created >= ?");
    args.push(filter.sinceMs);
  }
  if (typeof filter.untilMs === "number") {
    where.push("message.time_created <= ?");
    args.push(filter.untilMs);
  }
  if (after) {
    // The rows after the last one read, in (time_created, id) order. The first condition
    // alone lets SQLite start from the creation-time index.
    where.push("message.time_created >= ? AND (message.time_created > ? OR message.id > ?)");
    args.push(after.timeCreated, after.timeCreated, after.id);
  }
  return conn.all<ProjectedMessageRow>(
    `SELECT ${USAGE_MESSAGE_COLUMNS} FROM "session_message" AS message` +
      ` LEFT JOIN "session_v2" AS session ON session.id = message.session_id` +
      ` WHERE ${where.join(" AND ")}` +
      ` ORDER BY message.time_created ASC, message.id ASC LIMIT ?`,
    [...args, pageSize],
  );
}

/**
 * Reads the rows that used tokens, at most `pageSize` at a time so the caller can let other
 * work run between pages: assistant messages and compactions that recorded usage, by creation
 * time, without the copies a fork starts with. `role` is the row type ("assistant" or
 * "compaction"). With `sessionIDs`, reads only those sessions, one after another.
 */
export async function* readUsageMessagePages(params: {
  sinceMs?: number;
  untilMs?: number;
  sessionIDs?: readonly string[];
  pageSize: number;
}): AsyncGenerator<OpenCodeMessage[]> {
  const db = openDbOrNull();
  if (!db) return;

  const conn = await db.open();
  try {
    if (!(await hasJsonExtract(conn))) return;
    const { sinceMs, untilMs, pageSize } = params;
    const filters =
      params.sessionIDs === undefined
        ? [{ sinceMs, untilMs }]
        : params.sessionIDs.map((sessionID) => ({ sinceMs, untilMs, sessionID }));
    for (const filter of filters) {
      let after: UsagePageCursor | null = null;
      let pageWasFull = true;
      while (pageWasFull) {
        const rows = readUsagePage(conn, filter, after, pageSize);
        const messages = rows.flatMap((row) => mapRowToOpenCodeMessage(row) ?? []);
        if (messages.length > 0) yield messages;
        const last = rows.at(-1);
        if (last) after = { timeCreated: last.time_created, id: last.id };
        pageWasFull = rows.length === pageSize;
      }
    }
  } finally {
    conn.close();
  }
}

export async function readAllSessionsIndex(): Promise<Record<string, OpenCodeSessionInfo>> {
  const db = openDbOrNull();
  const idx: Record<string, OpenCodeSessionInfo> = {};
  if (!db) return idx;

  const conn = await db.open();
  try {
    const rows = conn.all<SessionRow>(
      `SELECT id, title, parent_id, time_created, time_updated FROM "session_v2" ORDER BY time_created ASC, id ASC`,
    );

    for (const row of rows) {
      if (!row || typeof row.id !== "string" || !row.id.startsWith("ses_")) continue;
      idx[row.id] = {
        id: row.id,
        title: typeof row.title === "string" && row.title.trim() ? row.title : undefined,
        parentID: typeof row.parent_id === "string" ? row.parent_id : undefined,
        time: {
          created: typeof row.time_created === "number" ? row.time_created : undefined,
          updated: typeof row.time_updated === "number" ? row.time_updated : undefined,
        },
      };
    }

    return idx;
  } finally {
    conn.close();
  }
}

function compareSessionCreatedAt(a: OpenCodeSessionInfo, b: OpenCodeSessionInfo): number {
  const aCreated =
    typeof a.time?.created === "number" && Number.isFinite(a.time.created)
      ? a.time.created
      : Number.MAX_SAFE_INTEGER;
  const bCreated =
    typeof b.time?.created === "number" && Number.isFinite(b.time.created)
      ? b.time.created
      : Number.MAX_SAFE_INTEGER;

  if (aCreated !== bCreated) return aCreated - bCreated;
  return a.id.localeCompare(b.id);
}

/** The ids of a session and all its subagent sessions, depth first, children oldest first. */
export async function resolveSessionTree(rootSessionID: string): Promise<string[]> {
  if (!rootSessionID.startsWith("ses_")) {
    throw new SessionNotFoundError(rootSessionID, "(invalid session ID format)");
  }

  const sessionsIdx = await readAllSessionsIndex();
  const root = sessionsIdx[rootSessionID];
  if (!root) {
    throw new SessionNotFoundError(rootSessionID, getOpenCodeDbPath());
  }

  const childrenByParentID = new Map<string, OpenCodeSessionInfo[]>();
  for (const session of Object.values(sessionsIdx)) {
    if (!session.parentID) continue;
    const children = childrenByParentID.get(session.parentID);
    if (children) {
      children.push(session);
    } else {
      childrenByParentID.set(session.parentID, [session]);
    }
  }

  for (const children of childrenByParentID.values()) {
    children.sort(compareSessionCreatedAt);
  }

  const tree: string[] = [];
  const visit = (session: OpenCodeSessionInfo): void => {
    if (tree.includes(session.id)) return;
    tree.push(session.id);
    for (const child of childrenByParentID.get(session.id) ?? []) visit(child);
  };

  visit(root);
  return tree;
}
