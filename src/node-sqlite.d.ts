declare module "node:sqlite" {
  export type DatabaseSyncOptions = {
    readOnly?: boolean;
    enableForeignKeyConstraints?: boolean;
    open?: boolean;
  };

  export class StatementSync {
    all(...params: any[]): any[];
    get(...params: any[]): any;
    run(...params: any[]): any;
  }

  export class DatabaseSync {
    constructor(filename: string, options?: DatabaseSyncOptions);
    prepare(sql: string): StatementSync;
    exec(sql: string): void;
    close(): void;
  }
}
