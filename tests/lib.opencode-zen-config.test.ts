import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storageMocks = vi.hoisted(() => ({
  dbPath: "",
}));

const sqliteMocks = vi.hoisted(() => ({
  open: vi.fn(),
  actual: null as null | ((path: string) => Promise<unknown>),
}));

const fsMocks = vi.hoisted(() => ({
  statSync: vi.fn(),
  actual: null as null | typeof import("node:fs").statSync,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  fsMocks.actual = actual.statSync;
  return {
    statSync: (
      path: Parameters<typeof actual.statSync>[0],
      options?: Parameters<typeof actual.statSync>[1],
    ) => fsMocks.statSync(path, options),
  };
});

vi.mock("../src/lib/opencode-storage.js", () => ({
  getOpenCodeDbPath: () => storageMocks.dbPath,
}));

vi.mock("../src/lib/opencode-sqlite.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/opencode-sqlite.js")>();
  sqliteMocks.actual = actual.openOpenCodeSqliteReadOnly;
  return { openOpenCodeSqliteReadOnly: (path: string) => sqliteMocks.open(path) };
});

import { resolveOpenCodeZenAccount } from "../src/lib/opencode-zen-config.js";

async function importNodeSqlite(): Promise<typeof import("node:sqlite") | null> {
  try {
    return await import("node:sqlite");
  } catch {
    return null;
  }
}

const sqlite = await importNodeSqlite();
const testWithSqlite = sqlite === null ? it.skip : it;

const FIXED_NOW_MS = 1_700_000_000_000;

describe("OpenCode Zen Console account resolution", () => {
  let dir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    // mockReset clears implementations too, so per-test mockRejectedValue /
    // mockImplementation set-up cannot leak into later tests.
    sqliteMocks.open.mockReset();
    sqliteMocks.open.mockImplementation((path: string) => {
      if (!sqliteMocks.actual) throw new Error("actual sqlite opener missing");
      return sqliteMocks.actual(path);
    });
    fsMocks.statSync.mockReset();
    fsMocks.statSync.mockImplementation((path: string, options?: { throwIfNoEntry?: boolean }) => {
      if (!fsMocks.actual) throw new Error("actual statSync missing");
      return fsMocks.actual(path, options);
    });
    dir = await mkdtemp(join(tmpdir(), "opencode-zen-config-"));
    storageMocks.dbPath = "";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIXED_NOW_MS);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });

  async function openSeededDb(
    seed: (writer: import("node:sqlite").DatabaseSync) => void,
  ): Promise<void> {
    if (!sqlite) throw new Error("node:sqlite unavailable");
    const dbPath = join(dir, "opencode.db");
    const writer = new sqlite.DatabaseSync(dbPath);
    writer.exec(`
      CREATE TABLE account (
        id TEXT PRIMARY KEY,
        email TEXT,
        url TEXT,
        access_token TEXT,
        refresh_token TEXT,
        token_expiry INTEGER,
        time_created INTEGER,
        time_updated INTEGER
      );
      CREATE TABLE account_state (
        id INTEGER PRIMARY KEY,
        active_account_id TEXT,
        active_org_id TEXT
      );
    `);
    seed(writer);
    writer.close();
    storageMocks.dbPath = dbPath;
  }

  function seedAccount(
    writer: import("node:sqlite").DatabaseSync,
    overrides: Record<string, unknown> = {},
  ): void {
    const ov = (key: string, fallback: unknown): unknown =>
      key in overrides ? overrides[key] : fallback;
    writer
      .prepare(
        `INSERT INTO account (id, email, url, access_token, refresh_token, token_expiry, time_created, time_updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ov("id", "acc_1"),
        ov("email", "dev@example.com"),
        ov("url", "https://opencode.ai/console/"),
        ov("access_token", "st_secret-token"),
        ov("refresh_token", "rt_refresh"),
        ov("token_expiry", FIXED_NOW_MS + 60_000),
        0,
        0,
      );
    writer
      .prepare(`INSERT INTO account_state (id, active_account_id, active_org_id) VALUES (?, ?, ?)`)
      .run(ov("state_id", 1), ov("active_account_id", "acc_1"), ov("active_org_id", "org_1"));
  }

  testWithSqlite("resolves the active console account from the OpenCode state DB", async () => {
    await openSeededDb((writer) => seedAccount(writer));

    await expect(resolveOpenCodeZenAccount()).resolves.toEqual({
      state: "configured",
      account: {
        baseUrl: "https://opencode.ai/console",
        accessToken: "st_secret-token",
        activeOrgId: "org_1",
      },
    });
  });

  it("reports none when the state DB is absent", async () => {
    storageMocks.dbPath = "";
    await expect(resolveOpenCodeZenAccount()).resolves.toEqual({ state: "none" });
    storageMocks.dbPath = join(dir, "does-not-exist.db");
    await expect(resolveOpenCodeZenAccount()).resolves.toEqual({ state: "none" });
  });

  it("reports none when the opener fails with ENOENT for an absent state DB", async () => {
    storageMocks.dbPath = join(dir, "does-not-exist.db");
    sqliteMocks.open.mockRejectedValue(
      Object.assign(new Error("unable to open database file"), { code: "ENOENT" }),
    );

    await expect(resolveOpenCodeZenAccount()).resolves.toEqual({ state: "none" });
  });

  it("reports none when the opener wraps an ENOENT cause", async () => {
    storageMocks.dbPath = join(dir, "does-not-exist.db");
    const enoent = Object.assign(new Error("unable to open database file"), { code: "ENOENT" });
    sqliteMocks.open.mockRejectedValue(
      new Error("OpenCode SQLite backend unavailable in this runtime", { cause: enoent }),
    );

    await expect(resolveOpenCodeZenAccount()).resolves.toEqual({ state: "none" });
  });

  testWithSqlite("reports none when node:sqlite reports an absent DB as CANTOPEN", async () => {
    storageMocks.dbPath = join(dir, "does-not-exist.db");
    // node:sqlite surfaces missing files as ERR_SQLITE_ERROR / errcode 14
    // without an ENOENT code; the stat fallback must classify it as missing.
    sqliteMocks.open.mockRejectedValue(
      Object.assign(new Error("unable to open database file"), {
        code: "ERR_SQLITE_ERROR",
        errcode: 14,
      }),
    );
    fsMocks.statSync.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT: no such file or directory, stat"), {
        code: "ENOENT",
      });
    });

    await expect(resolveOpenCodeZenAccount()).resolves.toEqual({ state: "none" });
  });

  it("reports read_error for EACCES-style failures even when the path cannot be statted", async () => {
    // Simulates an unsearchable parent directory: both the opener and statSync
    // fail with EACCES, so no existsSync/stat-based "missing" shortcut applies.
    storageMocks.dbPath = join(dir, "unsearchable-parent", "opencode.db");
    sqliteMocks.open.mockRejectedValue(
      Object.assign(new Error("permission denied"), { code: "EACCES" }),
    );
    fsMocks.statSync.mockImplementation(() => {
      throw Object.assign(new Error("permission denied, stat"), { code: "EACCES" });
    });

    await expect(resolveOpenCodeZenAccount()).resolves.toEqual({ state: "read_error" });
  });

  it("reports read_error when the opener fails for an existing state DB", async () => {
    const dbPath = join(dir, "opencode.db");
    await writeFile(dbPath, "not-a-real-db");
    storageMocks.dbPath = dbPath;
    sqliteMocks.open.mockRejectedValue(new Error("backend unavailable"));

    await expect(resolveOpenCodeZenAccount()).resolves.toEqual({ state: "read_error" });
  });

  it("reports read_error when an existing DB's opener error wraps an unrelated ENOENT", async () => {
    const dbPath = join(dir, "opencode.db");
    await writeFile(dbPath, "not-a-real-db");
    storageMocks.dbPath = dbPath;
    const enoent = Object.assign(new Error("some unrelated missing file"), { code: "ENOENT" });
    sqliteMocks.open.mockRejectedValue(
      new Error("OpenCode SQLite backend unavailable in this runtime", { cause: enoent }),
    );

    await expect(resolveOpenCodeZenAccount()).resolves.toEqual({ state: "read_error" });
  });

  testWithSqlite("reports incompatible when the Console tables are absent", async () => {
    const dbPath = join(dir, "opencode.db");
    const writer = new sqlite.DatabaseSync(dbPath);
    writer.exec(`CREATE TABLE unrelated (id INTEGER PRIMARY KEY)`);
    writer.close();
    storageMocks.dbPath = dbPath;

    await expect(resolveOpenCodeZenAccount()).resolves.toEqual({ state: "incompatible" });
  });

  testWithSqlite("reports incompatible when required columns are missing", async () => {
    const dbPath = join(dir, "opencode.db");
    const writer = new sqlite.DatabaseSync(dbPath);
    writer.exec(`
      CREATE TABLE account (id TEXT PRIMARY KEY, email TEXT);
      CREATE TABLE account_state (id INTEGER PRIMARY KEY, active_account_id TEXT);
    `);
    writer.close();
    storageMocks.dbPath = dbPath;

    await expect(resolveOpenCodeZenAccount()).resolves.toEqual({ state: "incompatible" });
  });

  testWithSqlite("reports incompatible when only one required column is missing", async () => {
    const dbPath = join(dir, "opencode.db");
    const writer = new sqlite.DatabaseSync(dbPath);
    writer.exec(`
      CREATE TABLE account (
        id TEXT PRIMARY KEY, email TEXT, url TEXT, access_token TEXT,
        refresh_token TEXT, token_expiry INTEGER, time_created INTEGER, time_updated INTEGER
      );
      CREATE TABLE account_state (id INTEGER PRIMARY KEY, active_account_id TEXT);
    `);
    writer.close();
    storageMocks.dbPath = dbPath;

    await expect(resolveOpenCodeZenAccount()).resolves.toEqual({ state: "incompatible" });
  });

  it("reports read_error and closes the connection when the account query fails", async () => {
    // Schema probes succeed so execution reaches the account_state SELECT,
    // whose disk-I/O failure must map to read_error (not incompatible).
    const columns = (names: string[]): Array<{ name: string }> => names.map((name) => ({ name }));
    const conn = {
      all: vi.fn((sql: string) => {
        if (sql.includes("sqlite_master")) {
          return columns(["account", "account_state"]);
        }
        if (sql.includes("table_info(account_state)")) {
          return columns(["id", "active_account_id", "active_org_id"]);
        }
        if (sql.includes("table_info(account)")) {
          return columns(["id", "email", "url", "access_token", "refresh_token", "token_expiry"]);
        }
        return [];
      }),
      get: vi.fn(() => {
        throw new Error("disk I/O error");
      }),
      close: vi.fn(),
    };
    storageMocks.dbPath = join(dir, "opencode.db");
    sqliteMocks.open.mockResolvedValue(conn);

    await expect(resolveOpenCodeZenAccount()).resolves.toEqual({ state: "read_error" });
    expect(conn.close).toHaveBeenCalledTimes(1);
  });

  testWithSqlite("reports missing_org when a signed-in account has no active org", async () => {
    await openSeededDb((writer) => seedAccount(writer, { active_org_id: null }));
    await expect(resolveOpenCodeZenAccount()).resolves.toEqual({ state: "missing_org" });
  });

  testWithSqlite("reports no_active_account when account_state has no active account", async () => {
    await openSeededDb((writer) =>
      seedAccount(writer, { active_account_id: null, active_org_id: null }),
    );
    await expect(resolveOpenCodeZenAccount()).resolves.toEqual({ state: "no_active_account" });
  });

  testWithSqlite("reports no_active_account when the account_state table is empty", async () => {
    await openSeededDb(() => {});
    await expect(resolveOpenCodeZenAccount()).resolves.toEqual({ state: "no_active_account" });
  });

  testWithSqlite("reports inactive_account when the active account row is gone", async () => {
    await openSeededDb((writer) => seedAccount(writer, { active_account_id: "acc_gone" }));
    await expect(resolveOpenCodeZenAccount()).resolves.toEqual({ state: "inactive_account" });
  });

  testWithSqlite("rejects an expired access token", async () => {
    const expiredMs = FIXED_NOW_MS - 1;
    await openSeededDb((writer) => seedAccount(writer, { token_expiry: expiredMs }));
    await expect(resolveOpenCodeZenAccount()).resolves.toEqual({
      state: "expired",
      expiryMs: expiredMs,
    });
  });

  testWithSqlite("rejects an empty access token", async () => {
    await openSeededDb((writer) => seedAccount(writer, { access_token: " " }));
    await expect(resolveOpenCodeZenAccount()).resolves.toEqual({
      state: "expired",
      expiryMs: 0,
    });
  });

  testWithSqlite.each([
    ["a malformed URL", "not-a-url"],
    ["a plain-HTTP URL", "http://opencode.ai/console/"],
    ["a URL with embedded credentials", "https://user:pass@opencode.ai/console"],
    ["a URL with a query string", "https://opencode.ai/console?org=1"],
    ["a URL with a fragment", "https://opencode.ai/console#org"],
    ["a URL with a bare question mark", "https://opencode.ai/console?"],
    ["a URL with a bare hash", "https://opencode.ai/console#"],
  ])("reports invalid_url for %s", async (_name, url) => {
    await openSeededDb((writer) => seedAccount(writer, { url }));
    await expect(resolveOpenCodeZenAccount()).resolves.toEqual({ state: "invalid_url" });
  });

  testWithSqlite.each([
    ["https://opencode.ai/console/", "https://opencode.ai/console"],
    ["https://opencode.ai", "https://opencode.ai"],
    ["https://console.example.dev/base///", "https://console.example.dev/base"],
  ])("keeps the path base of a valid console URL (%s)", async (url, expectedBase) => {
    await openSeededDb((writer) => seedAccount(writer, { url }));
    await expect(resolveOpenCodeZenAccount()).resolves.toEqual({
      state: "configured",
      account: {
        baseUrl: expectedBase,
        accessToken: "st_secret-token",
        activeOrgId: "org_1",
      },
    });
  });

  describe("account cache", () => {
    testWithSqlite("serves the cached account within the TTL and rereads after it", async () => {
      await openSeededDb((writer) => seedAccount(writer));
      vi.resetModules();
      const { resolveOpenCodeZenAccountCached } = await import("../src/lib/opencode-zen-config.js");

      const first = await resolveOpenCodeZenAccountCached();
      expect(first.state).toBe("configured");

      // Rotate the token behind the cache's back, then move 5s forward: inside
      // the 30s TTL and before the token expiry — still the cached account.
      const writer = new sqlite.DatabaseSync(storageMocks.dbPath);
      writer
        .prepare(`UPDATE account SET access_token = 'st_rotated-token' WHERE id = 'acc_1'`)
        .run();
      writer.close();
      vi.setSystemTime(FIXED_NOW_MS + 5_000);
      await expect(resolveOpenCodeZenAccountCached()).resolves.toEqual(first);

      // 31s after the first read: TTL elapsed — the resolver rereads the DB
      // and sees the rotated token.
      vi.setSystemTime(FIXED_NOW_MS + 31_000);
      await expect(resolveOpenCodeZenAccountCached()).resolves.toEqual({
        state: "configured",
        account: {
          baseUrl: "https://opencode.ai/console",
          accessToken: "st_rotated-token",
          activeOrgId: "org_1",
        },
      });
    });

    testWithSqlite("rereads when the token expires before the configured TTL", async () => {
      await openSeededDb((writer) => seedAccount(writer, { token_expiry: FIXED_NOW_MS + 10_000 }));
      vi.resetModules();
      const { resolveOpenCodeZenAccountCached } = await import("../src/lib/opencode-zen-config.js");

      const first = await resolveOpenCodeZenAccountCached();
      expect(first.state).toBe("configured");

      // 15s later: still inside the 30s TTL but past the token expiry — the
      // capped cache must reread and report the now-expired session.
      vi.setSystemTime(FIXED_NOW_MS + 15_000);
      await expect(resolveOpenCodeZenAccountCached()).resolves.toEqual({
        state: "expired",
        expiryMs: FIXED_NOW_MS + 10_000,
      });
    });

    testWithSqlite("rereads immediately on maxAgeMs 0 even with an unexpired cache", async () => {
      await openSeededDb((writer) => seedAccount(writer));
      vi.resetModules();
      const { resolveOpenCodeZenAccountCached } = await import("../src/lib/opencode-zen-config.js");

      const first = await resolveOpenCodeZenAccountCached();
      expect(first).toEqual({
        state: "configured",
        account: {
          baseUrl: "https://opencode.ai/console",
          accessToken: "st_secret-token",
          activeOrgId: "org_1",
        },
      });

      // Rotate the token, then force a refresh with maxAgeMs 0 while the prior
      // cache entry is still unexpired: the new token must be returned.
      const writer = new sqlite.DatabaseSync(storageMocks.dbPath);
      writer
        .prepare(`UPDATE account SET access_token = 'st_rotated-token' WHERE id = 'acc_1'`)
        .run();
      writer.close();

      await expect(resolveOpenCodeZenAccountCached({ maxAgeMs: 0 })).resolves.toEqual({
        state: "configured",
        account: {
          baseUrl: "https://opencode.ai/console",
          accessToken: "st_rotated-token",
          activeOrgId: "org_1",
        },
      });
    });

    testWithSqlite("does not cache an already-expired token after a fresh login", async () => {
      await openSeededDb((writer) => seedAccount(writer, { token_expiry: FIXED_NOW_MS - 1_000 }));
      vi.resetModules();
      const { resolveOpenCodeZenAccountCached } = await import("../src/lib/opencode-zen-config.js");

      await expect(resolveOpenCodeZenAccountCached()).resolves.toEqual({
        state: "expired",
        expiryMs: FIXED_NOW_MS - 1_000,
      });

      // The user signs in again right away: the expired result must not stay
      // cached, so the very next cached call rereads and sees the new session.
      const writer = new sqlite.DatabaseSync(storageMocks.dbPath);
      writer
        .prepare(
          `UPDATE account SET access_token = 'st_fresh-token', token_expiry = ? WHERE id = 'acc_1'`,
        )
        .run(FIXED_NOW_MS + 60_000);
      writer.close();

      await expect(resolveOpenCodeZenAccountCached()).resolves.toEqual({
        state: "configured",
        account: {
          baseUrl: "https://opencode.ai/console",
          accessToken: "st_fresh-token",
          activeOrgId: "org_1",
        },
      });
    });
  });
});
