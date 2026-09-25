import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storageMocks = vi.hoisted(() => ({
  dbPath: "",
}));

vi.mock("../src/lib/opencode-storage.js", () => ({
  getOpenCodeDbPath: () => storageMocks.dbPath,
}));

import {
  DEFAULT_OPENCODE_ZEN_ACCOUNT_CACHE_MAX_AGE_MS,
  resolveOpenCodeZenAccount,
  resolveOpenCodeZenAccountCached,
} from "../src/lib/opencode-zen-config.js";

async function importNodeSqlite(): Promise<typeof import("node:sqlite") | null> {
  try {
    return await import("node:sqlite");
  } catch {
    return null;
  }
}

const FUTURE_EXPIRY_MS = Date.now() + 60_000;

describe("OpenCode Zen Console account resolution", () => {
  let sqlite: typeof import("node:sqlite") | null;
  let dir: string;

  beforeEach(async () => {
    sqlite = await importNodeSqlite();
    dir = await mkdtemp(join(tmpdir(), "opencode-zen-config-"));
    storageMocks.dbPath = "";
    vi.resetModules();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function openSeededDb(
    seed: (writer: import("node:sqlite").DatabaseSync) => void,
  ): Promise<void> {
    if (!sqlite) return;
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
        ov("token_expiry", FUTURE_EXPIRY_MS),
        0,
        0,
      );
    writer
      .prepare(`INSERT INTO account_state (id, active_account_id, active_org_id) VALUES (?, ?, ?)`)
      .run(ov("state_id", 1), ov("active_account_id", "acc_1"), ov("active_org_id", "org_1"));
  }

  it("resolves the active console account from the OpenCode state DB", async () => {
    if (!sqlite) return;
    await openSeededDb((writer) => seedAccount(writer));

    await expect(resolveOpenCodeZenAccount()).resolves.toEqual({
      state: "configured",
      account: {
        email: "dev@example.com",
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

  it("reports missing_org when a signed-in account has no active org", async () => {
    if (!sqlite) return;
    await openSeededDb((writer) => seedAccount(writer, { active_org_id: null }));
    await expect(resolveOpenCodeZenAccount()).resolves.toEqual({ state: "missing_org" });
  });

  it("reports no_active_account when account_state has no active account", async () => {
    if (!sqlite) return;
    await openSeededDb((writer) =>
      seedAccount(writer, { active_account_id: null, active_org_id: null }),
    );
    await expect(resolveOpenCodeZenAccount()).resolves.toEqual({ state: "no_active_account" });
  });

  it("reports no_active_account when the account_state table is empty", async () => {
    if (!sqlite) return;
    await openSeededDb(() => {});
    await expect(resolveOpenCodeZenAccount()).resolves.toEqual({ state: "no_active_account" });
  });

  it("reports inactive_account when the active account row is gone", async () => {
    if (!sqlite) return;
    await openSeededDb((writer) => seedAccount(writer, { active_account_id: "acc_gone" }));
    await expect(resolveOpenCodeZenAccount()).resolves.toEqual({ state: "inactive_account" });
  });

  it("rejects an expired access token", async () => {
    if (!sqlite) return;
    const expiredMs = Date.now() - 1;
    await openSeededDb((writer) => seedAccount(writer, { token_expiry: expiredMs }));
    await expect(resolveOpenCodeZenAccount()).resolves.toEqual({
      state: "expired",
      expiryMs: expiredMs,
    });
  });

  it("rejects an empty access token", async () => {
    if (!sqlite) return;
    await openSeededDb((writer) => seedAccount(writer, { access_token: " " }));
    await expect(resolveOpenCodeZenAccount()).resolves.toEqual({
      state: "expired",
      expiryMs: 0,
    });
  });

  it("rejects a non-HTTPS console URL", async () => {
    if (!sqlite) return;
    await openSeededDb((writer) => seedAccount(writer, { url: "http://opencode.ai/console/" }));
    await expect(resolveOpenCodeZenAccount()).resolves.toEqual({ state: "none" });
  });

  it("caches the resolved account within the configured TTL", async () => {
    if (!sqlite) return;
    await openSeededDb((writer) => seedAccount(writer));
    const { DatabaseSync } = sqlite;

    const first = await resolveOpenCodeZenAccountCached({ maxAgeMs: 5_000 });
    const writer = new DatabaseSync(storageMocks.dbPath);
    writer.prepare(`UPDATE account SET access_token = 'st_rotated-token' WHERE id = 'acc_1'`).run();
    writer.close();

    await expect(resolveOpenCodeZenAccountCached({ maxAgeMs: 5_000 })).resolves.toEqual(first);
    expect(DEFAULT_OPENCODE_ZEN_ACCOUNT_CACHE_MAX_AGE_MS).toBeGreaterThan(0);
  });
});
