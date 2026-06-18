declare module "better-sqlite3" {
  class Statement {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  }

  class Database {
    constructor(filename: string, options?: { readonly?: boolean });
    prepare(sql: string): Statement;
    close(): void;
  }

  export default Database;
}
