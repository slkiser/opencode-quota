/** Additive migrations with SQLite-managed snapshots and locked version checks. */
import {
  readFileSync,
  mkdirSync,
  chmodSync,
  rmSync,
  openSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

interface DatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: any[]): any;
    run(...params: any[]): any;
    all(...params: any[]): any[];
  };
}
const directory = dirname(fileURLToPath(import.meta.url));
const V2 = `CREATE TABLE IF NOT EXISTS accounting_observations (
  provider TEXT NOT NULL, observation_id TEXT NOT NULL, observed_at INTEGER NOT NULL,
  row_id TEXT NOT NULL, account_identity TEXT NOT NULL, window_id TEXT, row_data TEXT NOT NULL,
  PRIMARY KEY(provider,account_identity,observation_id,row_id));
CREATE INDEX IF NOT EXISTS idx_accounting_identity_time
  ON accounting_observations(provider,account_identity,window_id,observed_at);`;
const V3 = `CREATE TABLE IF NOT EXISTS reset_events (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, account_identity TEXT NOT NULL,
  window_id TEXT NOT NULL, observed_at INTEGER NOT NULL, reset_at INTEGER NOT NULL,
  event_data TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
  lease_owner TEXT, lease_until INTEGER, lease_channel TEXT,
  delivered_at INTEGER, delivered_channel TEXT);
CREATE INDEX IF NOT EXISTS idx_reset_events_pending ON reset_events(state,observed_at);`;
const V4 = `CREATE TABLE IF NOT EXISTS reset_delivery_consumers (
  consumer_id TEXT PRIMARY KEY, watched TEXT NOT NULL, available_until INTEGER NOT NULL);`;
const V5 = `CREATE TABLE IF NOT EXISTS custom_estimate_events (
 definition_id TEXT NOT NULL,source TEXT NOT NULL,event_id TEXT NOT NULL,fingerprint TEXT NOT NULL,
 completed_at INTEGER NOT NULL,provider_id TEXT NOT NULL,model_id TEXT NOT NULL,tokens TEXT,
 PRIMARY KEY(definition_id,source,event_id));
 CREATE INDEX IF NOT EXISTS idx_custom_events_time ON custom_estimate_events(definition_id,source,completed_at);
 CREATE INDEX IF NOT EXISTS idx_custom_events_fingerprint ON custom_estimate_events(definition_id,source,fingerprint);
 CREATE TABLE IF NOT EXISTS custom_estimate_aliases (
 definition_id TEXT NOT NULL,source TEXT NOT NULL,message_key TEXT NOT NULL,event_id TEXT NOT NULL,
 PRIMARY KEY(definition_id,source,message_key));`;
function version(db: DatabaseLike): number {
  if (
    !db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'").get()
  )
    return 0;
  return Number(
    db.prepare("SELECT max(version) AS version FROM schema_version").get()?.version ?? 0,
  );
}
export function migrateSchema(db: DatabaseLike): void {
  for (let attempt = 0; attempt < 5; attempt++) {
    const initial = version(db);
    if (initial >= 5) return;
    const file = db
      .prepare("PRAGMA database_list")
      .all()
      .find((row) => row.name === "main")?.file;
    let backupDirectory: string | null = null;
    if (initial > 0 && file) {
      // Never copy/read the live DB through ordinary filesystem APIs: closing
      // that descriptor can cancel SQLite's POSIX locks (sqlite.org/howtocorrupt).
      backupDirectory = `${file}.pre-v${initial + 1}-${randomUUID()}`;
      mkdirSync(backupDirectory, { mode: 0o700 });
      const backup = join(backupDirectory, "history.sqlite");
      try {
        db.prepare("VACUUM INTO ?").run(backup);
        chmodSync(backup, 0o600);
        const fd = openSync(backup, "r");
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      } catch (error) {
        rmSync(backupDirectory, { recursive: true, force: true });
        throw error;
      }
    }
    db.exec("BEGIN EXCLUSIVE");
    try {
      const current = version(db);
      if (current !== initial) {
        db.exec("ROLLBACK");
        // Another process won the upgrade. This process's snapshot might have
        // captured that newer version; it is not advertised as a pre-upgrade backup.
        if (backupDirectory) rmSync(backupDirectory, { recursive: true, force: true });
        continue;
      }
      if (current < 1) db.exec(readFileSync(join(directory, "schema.sql"), "utf8"));
      for (const [target, sql] of [
        [2, V2],
        [3, V3],
        [4, V4],
        [5, V5],
      ] as const)
        if (current < target) {
          db.exec(sql);
          db.prepare("INSERT OR IGNORE INTO schema_version(version,applied_at) VALUES(?,?)").run(
            target,
            Date.now(),
          );
        }
      db.exec("COMMIT");
      return;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  throw new Error("History migration changed concurrently; retry required");
}
