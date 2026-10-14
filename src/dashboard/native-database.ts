/** Writable SQLite in a real Node process, never Electron's mismatched ABI. */
export async function openNativeDashboardDatabase(dbPath: string) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    // Node 20 fallback. Missing optional bindings remain an explicit failure.
  }
  const db = DatabaseSync
    ? new DatabaseSync(dbPath)
    : new (await import("better-sqlite3")).default(dbPath);
  try {
    // Rollback journaling keeps Electron's read-only sql.js file reader current.
    // Do not switch a database with existing WAL writers to another mode.
    db.exec("PRAGMA busy_timeout = 1500");
    const mode = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    if (mode.journal_mode === "wal")
      throw new Error("History is in WAL mode; native reads are required");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
