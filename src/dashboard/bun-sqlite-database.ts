/**
 * DatabaseLike adapter over bun:sqlite — used when the dashboard's writer
 * (dashboard-instance.ts, which runs inside opencode's own plugin process)
 * is executing under Bun, which is opencode's actual plugin runtime.
 *
 * bun:sqlite is a real, writable, native SQLite binding built directly into
 * Bun itself — unlike better-sqlite3, which is a separately-compiled native
 * addon that must match the *host* runtime's ABI exactly (see
 * sqljs-database.ts's header comment for the Electron-side version of this
 * same class of problem). Mirrors the Bun-detection pattern already used by
 * lib/opencode-sqlite.ts.
 */

interface PreparedLike {
  get(...params: unknown[]): any;
  run(...params: unknown[]): any;
  all(...params: unknown[]): any[];
}

interface BunSqliteStatement {
  get(...params: unknown[]): any;
  run(...params: unknown[]): any;
  all(...params: unknown[]): any[];
}

interface BunSqliteDb {
  query(sql: string): BunSqliteStatement;
  exec(sql: string): void;
  close(): void;
}

interface BunSqliteModule {
  Database: new (path: string) => BunSqliteDb;
}

export class BunSqliteDatabaseAdapter {
  private constructor(private readonly db: BunSqliteDb) {}

  static async open(dbPath: string): Promise<BunSqliteDatabaseAdapter> {
    const { Database } = (await import("bun:sqlite")) as unknown as BunSqliteModule;
    const db = new Database(dbPath);
    db.exec("PRAGMA busy_timeout = 1500");
    return new BunSqliteDatabaseAdapter(db);
  }

  prepare(sql: string): PreparedLike {
    const db = this.db;
    return {
      get: (...params: unknown[]) => db.query(sql).get(...params) ?? undefined,
      all: (...params: unknown[]) => db.query(sql).all(...params),
      run: (...params: unknown[]) => db.query(sql).run(...params),
    };
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }
}
