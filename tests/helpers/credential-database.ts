import { DatabaseSync } from "node:sqlite";

/** One row of OpenCode 2's `credential` table. */
export type CredentialDatabaseRow = {
  id: string;
  integrationId: string;
  /** Defaults to `default`, the label OpenCode gives an unnamed connection. */
  label?: string;
  active: 0 | 1 | null;
  /** `time_updated`; newer rows come first among rows with the same `active`. */
  updated: number;
  /** Stored as JSON in the `value` column. */
  value: unknown;
};

/**
 * The models.dev catalog OpenCode caches in its `kv` table: an object of provider ids, or the
 * JSON string OpenCode keeps in its `body`. Without it the database has no `kv` table.
 */
export type CredentialDatabaseOptions = {
  catalog?: Record<string, unknown> | string;
};

/**
 * Creates OpenCode 2's `credential` table in a new database file (use a temp dir) and
 * inserts `rows`.
 */
export function writeCredentialDatabase(
  databasePath: string,
  rows: readonly CredentialDatabaseRow[],
  options: CredentialDatabaseOptions = {},
): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`CREATE TABLE credential (
      id TEXT PRIMARY KEY,
      integration_id TEXT,
      label TEXT NOT NULL,
      value TEXT NOT NULL,
      connector_id TEXT,
      method_id TEXT,
      active INTEGER,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    )`);
    const insert = database.prepare(
      "INSERT INTO credential VALUES (?, ?, ?, ?, NULL, NULL, ?, 1, ?)",
    );
    for (const row of rows) {
      insert.run(
        row.id,
        row.integrationId,
        row.label ?? "default",
        JSON.stringify(row.value),
        row.active,
        row.updated,
      );
    }
    if (options.catalog !== undefined) {
      database.exec("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      database.prepare("INSERT INTO kv VALUES (?, ?)").run(
        "models-dev:v2:catalog",
        JSON.stringify({
          updatedAt: 0,
          digest: "test",
          body:
            typeof options.catalog === "string" ? options.catalog : JSON.stringify(options.catalog),
        }),
      );
    }
  } finally {
    database.close();
  }
}
