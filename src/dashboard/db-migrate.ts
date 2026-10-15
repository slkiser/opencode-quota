/**
 * Database migration for dashboard historical tracking
 */

import { readFileSync, mkdirSync, chmodSync, rmSync } from "fs";
import { randomUUID } from "node:crypto";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface DatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: any[]): any;
    run(...params: any[]): any;
    all(...params: any[]): any[];
  };
}

export function migrateSchema(db: DatabaseLike): void {
  try {
    // Check current version
    let currentVersion = 0;
    try {
      const row = db
        .prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1")
        .get();
      currentVersion = row?.version || 0;
    } catch {
      // Table doesn't exist yet, version is 0
    }

    console.log(`Current dashboard schema version: ${currentVersion}`);

    if (currentVersion < 1) {
      console.log("Applying dashboard schema v1...");
      const schemaPath = join(__dirname, "schema.sql");
      const schemaSql = readFileSync(schemaPath, "utf-8");
      db.exec(schemaSql);
      console.log("✓ Dashboard schema v1 applied");
    }

    if (currentVersion < 2) {
      // Native connections expose their on-disk file; WASM readers expose an
      // ephemeral in-memory database and never back up/export the live file.
      const file = db
        .prepare("PRAGMA database_list")
        .all()
        .find((row) => row.name === "main")?.file;
      if (currentVersion === 1 && file) {
        const directory = `${file}.pre-v2-${randomUUID()}`;
        mkdirSync(directory, { mode: 0o700 });
        const backup = join(directory, "history.sqlite");
        try {
          db.prepare("VACUUM INTO ?").run(backup);
          chmodSync(backup, 0o600);
        } catch (error) {
          rmSync(directory, { recursive: true, force: true });
          throw error;
        }
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(`CREATE TABLE IF NOT EXISTS accounting_observations (
          provider TEXT NOT NULL, observation_id TEXT NOT NULL,
          observed_at INTEGER NOT NULL, row_id TEXT NOT NULL,
          account_identity TEXT NOT NULL, window_id TEXT,
          row_data TEXT NOT NULL,
          PRIMARY KEY(provider, account_identity, observation_id, row_id)
        );
        CREATE INDEX IF NOT EXISTS idx_accounting_identity_time
          ON accounting_observations(provider, account_identity, window_id, observed_at);
        INSERT OR IGNORE INTO schema_version(version, applied_at) VALUES(2, ${Date.now()});`);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
  } catch (err) {
    console.error("Failed to migrate dashboard schema:", err);
    throw err;
  }
}
