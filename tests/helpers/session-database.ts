import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** One row of OpenCode 2's `session_v2` table (the columns the plugin reads). */
export type SessionDatabaseSession = {
  id: string;
  /** Set for a subagent session; a fork has none. */
  parentID?: string;
  /** For a fork: the session it was forked from (`fork_session_id`). */
  forkOf?: string;
  title?: string;
  /** For a fork: when it was forked. Its copies of the parent's messages are older. */
  created: number;
};

/** One row of OpenCode 2's `session_message` table; its `data` JSON is built from the rest. */
export type SessionDatabaseMessage = {
  id: string;
  sessionID: string;
  /** Defaults to "assistant". */
  type?: string;
  created: number;
  /** An assistant message's end; absent while it is still running. */
  completed?: number;
  /** A compaction's state; defaults to "completed". */
  status?: "running" | "completed" | "failed";
  /** A failed compaction names no model: leave both out. */
  providerID?: string;
  modelID?: string;
  /** A compaction without `tokens` recorded no usage. */
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  cost?: number;
};

function tokenUsage(tokens: NonNullable<SessionDatabaseMessage["tokens"]>) {
  return {
    input: tokens.input ?? 0,
    output: tokens.output ?? 0,
    reasoning: tokens.reasoning ?? 0,
    cache: { read: tokens.cacheRead ?? 0, write: tokens.cacheWrite ?? 0 },
  };
}

/** The message's `data` JSON, shaped like OpenCode 2's (`packages/schema/src/session-message.ts`). */
function messageData(message: SessionDatabaseMessage): Record<string, unknown> {
  const model =
    message.providerID === undefined && message.modelID === undefined
      ? {}
      : { model: { providerID: message.providerID, id: message.modelID } };
  if (message.type === "compaction") {
    return {
      type: "compaction",
      id: message.id,
      status: message.status ?? "completed",
      reason: "auto",
      ...model,
      ...(message.tokens ? { tokens: tokenUsage(message.tokens), cost: message.cost ?? 0 } : {}),
      time: { created: message.created },
    };
  }
  return {
    ...model,
    tokens: tokenUsage(message.tokens ?? {}),
    cost: message.cost ?? 0,
    time:
      message.completed === undefined
        ? { created: message.created }
        : { created: message.created, completed: message.completed },
  };
}

/**
 * Creates OpenCode 2's session tables and their indexes in a new database file (use a temp
 * dir), creating its folder, and inserts `sessions` and `messages`. A message's `seq` is its
 * place in `messages`.
 */
export function writeSessionDatabase(
  databasePath: string,
  data: {
    sessions: readonly SessionDatabaseSession[];
    messages: readonly SessionDatabaseMessage[];
  },
): void {
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      CREATE TABLE "session_v2" (
        id TEXT PRIMARY KEY,
        title TEXT,
        parent_id TEXT,
        fork_session_id TEXT,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL
      );
      CREATE INDEX "session_v2_parent_idx" ON "session_v2" (parent_id);
      CREATE TABLE "session_message" (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        seq INTEGER NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE UNIQUE INDEX "session_message_session_seq_idx" ON "session_message" (session_id, seq);
      CREATE INDEX "session_message_session_type_seq_idx"
        ON "session_message" (session_id, type, seq);
      CREATE INDEX "session_message_session_time_created_id_idx"
        ON "session_message" (session_id, time_created, id);
      CREATE INDEX "session_message_time_created_idx" ON "session_message" (time_created);
    `);
    database.exec("BEGIN");
    const insertSession = database.prepare(`INSERT INTO "session_v2" VALUES (?, ?, ?, ?, ?, ?)`);
    for (const session of data.sessions) {
      insertSession.run(
        session.id,
        session.title ?? null,
        session.parentID ?? null,
        session.forkOf ?? null,
        session.created,
        session.created,
      );
    }
    const insertMessage = database.prepare(
      `INSERT INTO "session_message" VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    data.messages.forEach((message, seq) => {
      insertMessage.run(
        message.id,
        message.sessionID,
        message.type ?? "assistant",
        seq,
        message.created,
        message.completed ?? message.created,
        JSON.stringify(messageData(message)),
      );
    });
    database.exec("COMMIT");
  } finally {
    database.close();
  }
}
