import { join } from "path";
import { existsSync } from "fs";

import { getOpencodeRuntimeDirCandidates } from "./opencode-runtime-paths.js";
import { pickFirstExistingPath } from "./path-pick.js";
import { openOpenCodeSqliteReadOnly } from "./opencode-sqlite.js";

/**
 * Error thrown when a session is not found.
 *
 * With OpenCode >=1.2, sessions/messages live in SQLite (`opencode.db`).
 * This is thrown by iterAssistantMessagesForSession when the database is
 * missing/unreadable, the session id is invalid, or the session row does
 * not exist.
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

export interface OpenCodeTokenCache {
  read: number;
  write: number;
}

export interface OpenCodeTokens {
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

export type OpenCodeDbStats = {
  dbPath: string;
  sessionCount: number;
  messageCount: number;
  assistantMessageCount: number;
};

export function getOpenCodeDataDirCandidates(): string[] {
  // OpenCode stores data under `${Global.Path.data}` which is `join(xdgData, "opencode")`.
  // We return candidate opencode data dirs in priority order.
  return getOpencodeRuntimeDirCandidates().dataDirs;
}

export function getOpenCodeDataDir(): string {
  return pickFirstExistingPath(getOpenCodeDataDirCandidates());
}

export function getOpenCodeDbPathCandidates(): string[] {
  return getOpenCodeDataDirCandidates().map((d) => join(d, "opencode.db"));
}

export function getOpenCodeDbPath(): string {
  return pickFirstExistingPath(getOpenCodeDbPathCandidates());
}

type MessageRow = {
  id: string;
  session_id: string;
  time_created: number;
  time_updated?: number;
  data: string;
};

type SessionRow = {
  id: string;
  title: string | null;
  parent_id: string | null;
  time_created: number;
  time_updated: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function safeJsonParse(raw: string): unknown | null {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

// Stay comfortably below SQLite's default host-parameter cap once optional
// time filters are included in the query.
const SQLITE_MAX_MESSAGE_QUERY_ARGS = 900;

function normalizeNumber(n: unknown): number | undefined {
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

function normalizeString(s: unknown): string | undefined {
  return typeof s === "string" ? s : undefined;
}

function mapRowToOpenCodeMessage(row: MessageRow): OpenCodeMessage | null {
  if (!row || typeof row !== "object") return null;
  if (typeof row.id !== "string" || typeof row.session_id !== "string") return null;
  if (typeof row.time_created !== "number") return null;

  const payload = asRecord(safeJsonParse(row.data));
  if (!payload) return null;

  const payloadTime = asRecord(payload.time);
  const role = normalizeString(payload.role) ?? "unknown";

  return {
    id: row.id,
    sessionID: row.session_id,
    role,
    providerID: normalizeString(payload.providerID),
    modelID: normalizeString(payload.modelID),
    tokens: payload.tokens as OpenCodeTokens | undefined,
    cost: normalizeNumber(payload.cost),
    time: {
      created: row.time_created,
      completed: normalizeNumber(payloadTime?.completed),
    },
    agent: normalizeString(payload.agent),
    mode: normalizeString(payload.mode),
  };
}

function openDbOrNull(): {
  dbPath: string;
  open: () => ReturnType<typeof openOpenCodeSqliteReadOnly>;
} | null {
  const dbPath = getOpenCodeDbPath();
  if (!dbPath) return null;
  if (!existsSync(dbPath)) return null;
  return {
    dbPath,
    open: () => openOpenCodeSqliteReadOnly(dbPath),
  };
}

function validateSessionIdOrThrow(sessionID: string): void {
  if (!sessionID.startsWith("ses_")) {
    throw new SessionNotFoundError(sessionID, "(invalid session ID format)");
  }
}

function normalizeSessionIdsOrThrow(sessionIDs: readonly string[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();

  for (const sessionID of sessionIDs) {
    validateSessionIdOrThrow(sessionID);
    if (seen.has(sessionID)) continue;
    seen.add(sessionID);
    unique.push(sessionID);
  }

  return unique;
}

function chunkArray<T>(items: readonly T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

function buildMessageQuery(params: {
  sessionID?: string;
  sessionIDs?: string[];
  sinceMs?: number;
  untilMs?: number;
}): { sql: string; args: unknown[] } {
  if (params.sessionID && params.sessionIDs?.length) {
    throw new Error("buildMessageQuery received both sessionID and sessionIDs");
  }

  const where: string[] = [];
  const args: unknown[] = [];

  if (params.sessionID) {
    where.push(`session_id = ?`);
    args.push(params.sessionID);
  } else if (params.sessionIDs) {
    if (params.sessionIDs.length === 0) {
      where.push(`1 = 0`);
    } else {
      where.push(`session_id IN (${params.sessionIDs.map(() => "?").join(", ")})`);
      args.push(...params.sessionIDs);
    }
  }

  if (typeof params.sinceMs === "number") {
    where.push(`time_created >= ?`);
    args.push(params.sinceMs);
  }

  if (typeof params.untilMs === "number") {
    where.push(`time_created <= ?`);
    args.push(params.untilMs);
  }

  const sql =
    `SELECT id, session_id, time_created, time_updated, data FROM "message"` +
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

function mapAssistantMessages(rows: MessageRow[]): OpenCodeMessage[] {
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

function mapCompletedAssistantMessages(rows: MessageRow[]): OpenCodeMessage[] {
  return mapAssistantMessages(rows).filter((message) => completedAt(message) !== null);
}

function compareCompletedMessageOrder(a: OpenCodeMessage, b: OpenCodeMessage): number {
  const aCompleted = completedAt(a) ?? Number.MAX_SAFE_INTEGER;
  const bCompleted = completedAt(b) ?? Number.MAX_SAFE_INTEGER;
  if (aCompleted !== bCompleted) return aCompleted - bCompleted;
  return a.id.localeCompare(b.id);
}

function buildCompletedAssistantQuery(params: {
  completedSinceMs?: number;
  completedUntilMs?: number;
}): { sql: string; args: unknown[] } {
  const completedExpression = `CAST(json_extract(data, '$.time.completed') AS REAL)`;
  const where = [
    `json_extract(data, '$.role') = 'assistant'`,
    `json_type(data, '$.time.completed') IN ('integer', 'real')`,
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
      `SELECT id, session_id, time_created, time_updated, data FROM "message"` +
      ` WHERE ${where.join(" AND ")}` +
      ` ORDER BY ${completedExpression} ASC, id ASC`,
    args,
  };
}

function compareMessageOrder(a: OpenCodeMessage, b: OpenCodeMessage): number {
  const aCreated = typeof a.time?.created === "number" ? a.time.created : Number.MAX_SAFE_INTEGER;
  const bCreated = typeof b.time?.created === "number" ? b.time.created : Number.MAX_SAFE_INTEGER;
  if (aCreated !== bCreated) return aCreated - bCreated;
  return a.id.localeCompare(b.id);
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
    const sessionRow = conn.get<{ c: number }>(`SELECT count(*) as c FROM "session"`);
    const messageRow = conn.get<{ c: number }>(`SELECT count(*) as c FROM "message"`);

    let assistantCount = 0;
    if (await hasJsonExtract(conn)) {
      const a = conn.get<{ c: number }>(
        `SELECT count(*) as c FROM "message" WHERE json_extract(data, '$.role') = 'assistant'`,
      );
      assistantCount = typeof a?.c === "number" ? a.c : 0;
    } else {
      const rows = conn.all<{ data: string }>(`SELECT data FROM "message"`);
      for (const r of rows) {
        const payload = asRecord(safeJsonParse(r.data));
        if (payload?.role === "assistant") assistantCount += 1;
      }
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
    const q = buildMessageQuery({ sinceMs: params.sinceMs, untilMs: params.untilMs });
    const rows = conn.all<MessageRow>(q.sql, q.args);
    return mapAssistantMessages(rows);
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
      return mapCompletedAssistantMessages(conn.all<MessageRow>(query.sql, query.args));
    }

    const rows = conn.all<MessageRow>(
      `SELECT id, session_id, time_created, time_updated, data FROM "message"`,
    );
    return mapCompletedAssistantMessages(rows)
      .filter((message) => {
        const atMs = completedAt(message);
        if (atMs === null) return false;
        if (typeof params.completedSinceMs === "number" && atMs < params.completedSinceMs) {
          return false;
        }
        if (typeof params.completedUntilMs === "number" && atMs > params.completedUntilMs) {
          return false;
        }
        return true;
      })
      .sort(compareCompletedMessageOrder);
  } finally {
    conn.close();
  }
}

/**
 * Read assistant messages for a specific session only.
 */
export async function iterAssistantMessagesForSession(params: {
  sessionID: string;
  sinceMs?: number;
  untilMs?: number;
}): Promise<OpenCodeMessage[]> {
  const { sessionID, sinceMs, untilMs } = params;
  validateSessionIdOrThrow(sessionID);

  const db = openDbOrNull();
  if (!db) {
    throw new SessionNotFoundError(sessionID, getOpenCodeDbPath());
  }

  const conn = await db.open();
  try {
    const exists = conn.get<{ ok: number }>(`SELECT 1 as ok FROM "session" WHERE id = ? LIMIT 1`, [
      sessionID,
    ]);
    if (!exists) {
      throw new SessionNotFoundError(sessionID, db.dbPath);
    }

    const q = buildMessageQuery({ sessionID, sinceMs, untilMs });
    const rows = conn.all<MessageRow>(q.sql, q.args);
    return mapAssistantMessages(rows);
  } finally {
    conn.close();
  }
}

/**
 * Read assistant messages for a specific set of sessions.
 */
export async function iterAssistantMessagesForSessions(params: {
  sessionIDs: string[];
  sinceMs?: number;
  untilMs?: number;
}): Promise<OpenCodeMessage[]> {
  const sessionIDs = normalizeSessionIdsOrThrow(params.sessionIDs);
  if (sessionIDs.length === 0) return [];

  const db = openDbOrNull();
  if (!db) {
    throw new SessionNotFoundError(sessionIDs[0]!, getOpenCodeDbPath());
  }

  const conn = await db.open();
  try {
    const reservedArgs =
      (typeof params.sinceMs === "number" ? 1 : 0) + (typeof params.untilMs === "number" ? 1 : 0);
    const maxSessionIdsPerQuery = Math.max(1, SQLITE_MAX_MESSAGE_QUERY_ARGS - reservedArgs);
    const messages: OpenCodeMessage[] = [];

    for (const sessionIdChunk of chunkArray(sessionIDs, maxSessionIdsPerQuery)) {
      const q = buildMessageQuery({
        sessionIDs: sessionIdChunk,
        sinceMs: params.sinceMs,
        untilMs: params.untilMs,
      });
      const rows = conn.all<MessageRow>(q.sql, q.args);
      messages.push(...mapAssistantMessages(rows));
    }

    messages.sort(compareMessageOrder);
    return messages;
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
      `SELECT id, title, parent_id, time_created, time_updated FROM "session" ORDER BY time_created ASC, id ASC`,
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
