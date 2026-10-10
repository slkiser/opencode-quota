import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveAgyAccounts } from "../src/lib/google-agy.js";
import { resolveGeminiCliAccounts } from "../src/lib/google-gemini-cli.js";
import {
  bindCredentialSource,
  clearReadAuthFileCacheForTests,
  getCredentialSourceDiagnostics,
  readAuthFile,
  readCredentialRows,
} from "../src/lib/opencode-auth.js";
import { createSqliteCredentialSource } from "../src/lib/opencode-auth-sqlite.js";
import {
  type CredentialDatabaseRow,
  writeCredentialDatabase,
} from "./helpers/credential-database.js";

/** Three logins without an `active` flag, newest first: DeepSeek, OpenAI, Copilot. */
const BASE_ROWS: CredentialDatabaseRow[] = [
  {
    id: "copilot",
    integrationId: "github-copilot",
    active: null,
    updated: 1,
    value: {
      type: "oauth",
      access: "copilot-access",
      refresh: "copilot-refresh",
      expires: 10,
      metadata: { enterpriseUrl: "example.ghe.com" },
    },
  },
  {
    id: "openai",
    integrationId: "openai",
    active: null,
    updated: 2,
    value: { type: "oauth", access: "openai-access", refresh: "openai-refresh", expires: 20 },
  },
  {
    id: "deepseek",
    integrationId: "deepseek",
    active: null,
    updated: 3,
    value: { type: "key", key: "deepseek-key" },
  },
];

function withRow(id: string, changes: Partial<CredentialDatabaseRow>): CredentialDatabaseRow[] {
  return BASE_ROWS.map((row) => (row.id === id ? { ...row, ...changes } : row));
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

let root: string;
let dataDir: string;
let databasePath: string;
let unbind: () => void;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "opencode-quota-auth-sqlite-"));
  dataDir = join(root, "opencode");
  mkdirSync(dataDir, { recursive: true });
  databasePath = join(dataDir, "opencode.db");
  vi.stubEnv("XDG_DATA_HOME", root);
  vi.stubEnv("OPENCODE_DB", databasePath);
  unbind = bindCredentialSource(createSqliteCredentialSource());
});

afterEach(() => {
  unbind();
  clearReadAuthFileCacheForTests();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("the terminal command's database login reader", () => {
  it("reads OAuth and key logins from OpenCode's database, metadata on top and key as api", async () => {
    writeCredentialDatabase(databasePath, BASE_ROWS);

    await expect(
      readAuthFile({ integrationIds: ["github-copilot", "deepseek", "openai"] }),
    ).resolves.toMatchObject({
      "github-copilot": { access: "copilot-access", enterpriseUrl: "example.ghe.com" },
      deepseek: { type: "api", key: "deepseek-key" },
      openai: { access: "openai-access" },
    });
  });

  it("keeps the OAuth methodID, which tells Sign in with ChatGPT logins apart (#316)", async () => {
    writeCredentialDatabase(
      databasePath,
      withRow("openai", {
        value: {
          type: "oauth",
          methodID: "chatgpt-token-sharing",
          access: "openai-access",
          refresh: "openai-refresh",
          expires: 20,
          metadata: { clientID: "client", scopes: ["chatgpt.tokens.use.direct"] },
        },
      }),
    );

    await expect(readCredentialRows(["openai"])).resolves.toEqual([
      expect.objectContaining({
        id: "openai",
        value: expect.objectContaining({ methodID: "chatgpt-token-sharing" }),
      }),
    ]);
  });

  it("exposes every credential row with active rows first", async () => {
    writeCredentialDatabase(databasePath, [
      ...withRow("openai", { label: "Work", active: 0 }),
      {
        id: "openai-active",
        integrationId: "openai",
        label: "Personal",
        active: 1,
        updated: 4,
        value: { type: "oauth", access: "personal-access" },
      },
    ]);

    await expect(readCredentialRows(["openai"])).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "openai-active",
          integrationId: "openai",
          label: "Personal",
          active: true,
          value: expect.objectContaining({ access: "personal-access" }),
        }),
        expect.objectContaining({ id: "openai", active: false }),
      ]),
    );
    const rows = await readCredentialRows(["openai"]);
    expect(rows.findIndex((row) => row.id === "openai-active")).toBeLessThan(
      rows.findIndex((row) => row.id === "openai"),
    );
  });

  it("ignores legacy auth.json entries", async () => {
    writeCredentialDatabase(databasePath, BASE_ROWS);
    writeFileSync(
      join(dataDir, "auth.json"),
      JSON.stringify({ openai: { type: "oauth", access: "file-access" } }),
    );

    await expect(
      readAuthFile({ integrationIds: ["github-copilot", "openai"] }),
    ).resolves.toMatchObject({
      "github-copilot": { access: "copilot-access" },
      openai: { access: "openai-access" },
    });
  });

  it("returns only rows of the requested ids, in database order", async () => {
    writeCredentialDatabase(databasePath, BASE_ROWS);

    expect((await readCredentialRows(["openai"])).map((row) => row.id)).toEqual(["openai"]);
    // Database order (most recently updated first), not request order.
    expect((await readCredentialRows(["github-copilot", "openai"])).map((row) => row.id)).toEqual([
      "openai",
      "copilot",
    ]);
    await expect(readCredentialRows([])).resolves.toEqual([]);
    await expect(readAuthFile({ integrationIds: ["xai"] })).resolves.toBeNull();
    await expect(readAuthFile({ integrationIds: ["openai"] })).resolves.toEqual({
      openai: { type: "oauth", access: "openai-access", refresh: "openai-refresh", expires: 20 },
    });
  });

  it("keeps only the requested connection methods", async () => {
    writeCredentialDatabase(databasePath, [
      ...BASE_ROWS,
      {
        id: "console",
        integrationId: "opencode",
        active: 1,
        updated: 5,
        value: { type: "oauth", access: "console-access", refresh: "console-refresh", expires: 1 },
      },
      {
        id: "workspace-key",
        integrationId: "opencode",
        active: 0,
        updated: 4,
        value: { type: "key", key: "workspace-key" },
      },
    ]);

    const ids = ["opencode", "openai", "deepseek"];
    expect((await readCredentialRows(ids, { methods: ["key"] })).map((row) => row.id)).toEqual([
      "workspace-key",
      "deepseek",
    ]);
    expect((await readCredentialRows(ids, { methods: ["oauth"] })).map((row) => row.id)).toEqual([
      "console",
      "openai",
    ]);
    expect(
      (await readCredentialRows(ids, { methods: ["key", "oauth"] })).map((row) => row.id),
    ).toEqual(["console", "workspace-key", "deepseek", "openai"]);
  });

  it("keeps the first (active) row per id when firstOnly is set", async () => {
    writeCredentialDatabase(databasePath, [
      ...withRow("openai", { active: 1 }),
      {
        id: "openai-newer-inactive",
        integrationId: "openai",
        active: 0,
        updated: 9,
        value: { type: "oauth", access: "inactive-access" },
      },
    ]);

    expect(
      (await readCredentialRows(["openai", "deepseek"], { firstOnly: true })).map((row) => row.id),
    ).toEqual(["openai", "deepseek"]);
    await expect(readAuthFile({ integrationIds: ["openai"] })).resolves.toMatchObject({
      openai: { access: "openai-access" },
    });
  });

  it("applies firstOnly before the method filter, so a mismatched active row yields nothing", async () => {
    writeCredentialDatabase(databasePath, [
      ...BASE_ROWS,
      {
        id: "openai-key",
        integrationId: "openai",
        active: 1,
        updated: 9,
        value: { type: "key", key: "openai-key" },
      },
    ]);

    await expect(
      readCredentialRows(["openai"], { firstOnly: true, methods: ["oauth"] }),
    ).resolves.toEqual([]);
  });

  it("parses the opencode-gemini-auth 2.x and AGY alpha OAuth rows", async () => {
    writeCredentialDatabase(databasePath, [
      ...BASE_ROWS,
      // opencode-gemini-auth 2.0.1: `gemini-cli` method on OpenCode 2's `google` integration.
      {
        id: "gemini",
        integrationId: "google",
        label: "user@example.com",
        active: 1,
        updated: 5,
        value: {
          type: "oauth",
          methodID: "gemini-cli",
          refresh: "gemini-refresh|gemini-project|",
          access: "gemini-access",
          expires: 50,
          metadata: { email: "user@example.com" },
        },
      },
      // @anthonyhaussman/opencode-agy-auth 1.2.11-alpha.0: `oauth` method on `google-agy`.
      {
        id: "agy",
        integrationId: "google-agy",
        label: "OAuth",
        active: 1,
        updated: 5,
        value: {
          type: "oauth",
          methodID: "oauth",
          refresh: "agy-refresh|agy-project|agy-managed-project",
          access: "agy-access",
          expires: 60,
        },
      },
    ]);
    const auth = await readAuthFile({ integrationIds: ["google", "google-agy"] });

    expect(resolveGeminiCliAccounts(auth)).toEqual([
      {
        sourceKey: "google",
        refreshToken: "gemini-refresh",
        projectId: "gemini-project",
        email: "user@example.com",
        accessToken: "gemini-access",
        expiresAt: 50,
      },
    ]);
    expect(resolveAgyAccounts(auth)).toEqual([
      {
        sourceKey: "google-agy",
        refreshToken: "agy-refresh",
        projectId: "agy-managed-project",
        accessToken: "agy-access",
        expiresAt: 60,
      },
    ]);
  });

  it("returns no rows for a missing database, a non-database file or OPENCODE_DB=:memory:, and never creates the file", async () => {
    await expect(readCredentialRows(["openai"])).resolves.toEqual([]);
    await expect(readAuthFile({ integrationIds: ["openai"] })).resolves.toBeNull();
    expect(existsSync(databasePath)).toBe(false);

    const notDatabasePath = join(dataDir, "not-a-database.db");
    writeFileSync(notDatabasePath, "not a SQLite database");
    vi.stubEnv("OPENCODE_DB", notDatabasePath);
    await expect(readCredentialRows(["openai"])).resolves.toEqual([]);
    expect(readFileSync(notDatabasePath, "utf8")).toBe("not a SQLite database");

    vi.stubEnv("OPENCODE_DB", ":memory:");
    await expect(readCredentialRows(["openai"])).resolves.toEqual([]);

    expect(readdirSync(root)).toEqual(["opencode"]);
    expect(readdirSync(dataDir)).toEqual(["not-a-database.db"]);
  });

  it("skips rows whose value is not a JSON object and never returns a failed row", async () => {
    writeCredentialDatabase(databasePath, [
      { id: "string-value", integrationId: "openai", active: 1, updated: 5, value: "oauth" },
      { id: "array-value", integrationId: "openai", active: 0, updated: 4, value: ["oauth"] },
      { id: "null-value", integrationId: "openai", active: 0, updated: 3, value: null },
      {
        id: "usable",
        integrationId: "openai",
        active: 0,
        updated: 1,
        value: { type: "oauth", access: "usable-access" },
      },
    ]);
    const database = new DatabaseSync(databasePath);
    database
      .prepare(
        "INSERT INTO credential VALUES ('broken-json', 'openai', 'default', '{broken', NULL, NULL, 0, 1, 2)",
      )
      .run();
    database.close();

    await expect(readCredentialRows(["openai"])).resolves.toEqual([
      {
        id: "usable",
        integrationId: "openai",
        label: "default",
        active: false,
        value: { type: "oauth", access: "usable-access" },
      },
    ]);
    await expect(readAuthFile({ integrationIds: ["openai"] })).resolves.toEqual({
      openai: { type: "oauth", access: "usable-access" },
    });
  });

  it("leaves the database file byte-for-byte unchanged", async () => {
    writeCredentialDatabase(databasePath, BASE_ROWS);
    const before = sha256(databasePath);

    await readCredentialRows(["github-copilot", "openai", "deepseek"]);
    await readCredentialRows(["openai"], { firstOnly: true, methods: ["oauth"] });
    await readAuthFile({ integrationIds: ["deepseek"], methods: ["key"] });

    expect(sha256(databasePath)).toBe(before);
    expect(readdirSync(dataDir)).toEqual(["opencode.db"]);
  });

  it("reports sqlite as the bound login source with no list error or failures", async () => {
    writeCredentialDatabase(databasePath, BASE_ROWS);
    await readCredentialRows(["openai", "deepseek"]);

    expect(getCredentialSourceDiagnostics()).toEqual({
      state: "bound",
      kind: "sqlite",
      failures: [],
    });
  });
});
