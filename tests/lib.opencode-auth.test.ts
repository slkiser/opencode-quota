import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearReadAuthFileCacheForTests,
  getCredentialDatabasePath,
  getCredentialDatabasePaths,
  readAuthFile,
} from "../src/lib/opencode-auth.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  clearReadAuthFileCacheForTests();
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createCredentialDatabase(): Promise<{ dataDir: string; databasePath: string }> {
  const root = await mkdtemp(join(tmpdir(), "opencode-quota-auth-"));
  temporaryDirectories.push(root);
  const dataDir = join(root, "opencode");
  await mkdir(dataDir, { recursive: true });
  const databasePath = join(dataDir, "opencode.db");
  const database = new DatabaseSync(databasePath);
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
  database
    .prepare("INSERT INTO credential VALUES (?, ?, 'default', ?, NULL, NULL, NULL, 1, ?)")
    .run(
      "copilot",
      "github-copilot",
      JSON.stringify({
        type: "oauth",
        access: "copilot-access",
        refresh: "copilot-refresh",
        expires: 10,
        metadata: { enterpriseUrl: "example.ghe.com" },
      }),
      1,
    );
  database
    .prepare("INSERT INTO credential VALUES (?, ?, 'default', ?, NULL, NULL, NULL, 1, ?)")
    .run(
      "openai",
      "openai",
      JSON.stringify({
        type: "oauth",
        access: "openai-access",
        refresh: "openai-refresh",
        expires: 20,
      }),
      2,
    );
  database
    .prepare("INSERT INTO credential VALUES (?, ?, 'default', ?, NULL, NULL, NULL, 1, ?)")
    .run("deepseek", "deepseek", JSON.stringify({ type: "key", key: "deepseek-key" }), 3);
  database.close();
  return { dataDir, databasePath };
}

describe("OpenCode auth reader", () => {
  it("reports the credential database path and honors OPENCODE_DB", async () => {
    const { dataDir } = await createCredentialDatabase();
    vi.stubEnv("XDG_DATA_HOME", join(dataDir, ".."));

    expect(getCredentialDatabasePaths()).toContain(join(dataDir, "opencode.db"));
    expect(getCredentialDatabasePath()).toBe(join(dataDir, "opencode.db"));

    vi.stubEnv("OPENCODE_DB", "custom.db");
    expect(getCredentialDatabasePaths()).toEqual([join(dataDir, "custom.db")]);
  });

  it("falls back to OAuth credentials stored in OpenCode's database", async () => {
    const { dataDir } = await createCredentialDatabase();
    vi.stubEnv("XDG_DATA_HOME", join(dataDir, ".."));

    await expect(readAuthFile()).resolves.toMatchObject({
      "github-copilot": { access: "copilot-access", enterpriseUrl: "example.ghe.com" },
      deepseek: { type: "api", key: "deepseek-key" },
      openai: { access: "openai-access" },
    });
  });

  it("ignores legacy auth.json entries", async () => {
    const { dataDir } = await createCredentialDatabase();
    vi.stubEnv("XDG_DATA_HOME", join(dataDir, ".."));
    await writeFile(
      join(dataDir, "auth.json"),
      JSON.stringify({ openai: { type: "oauth", access: "file-access" } }),
    );

    await expect(readAuthFile()).resolves.toMatchObject({
      "github-copilot": { access: "copilot-access" },
      openai: { access: "openai-access" },
    });
  });
});
