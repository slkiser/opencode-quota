import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveOpenCodeConsoleAuth } from "../src/lib/opencode-console-auth.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createCredentialDatabaseWith(
  integrationId: string,
  value: Record<string, unknown>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "opencode-console-auth-"));
  temporaryDirectories.push(root);
  const dataDir = join(root, "opencode");
  await mkdir(dataDir, { recursive: true });
  const database = new DatabaseSync(join(dataDir, "opencode.db"));
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
    .prepare("INSERT INTO credential VALUES (?, ?, 'default', ?, NULL, NULL, NULL, 1, 1)")
    .run("cred-console", integrationId, JSON.stringify(value));
  database.close();
  vi.stubEnv("XDG_DATA_HOME", root);
}

describe("OpenCode Console credential reader", () => {
  it("returns none without console credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-console-auth-empty-"));
    temporaryDirectories.push(root);
    vi.stubEnv("XDG_DATA_HOME", root);
    await expect(resolveOpenCodeConsoleAuth()).resolves.toEqual({ state: "none" });
  });

  it("resolves the configured console credential with org metadata", async () => {
    const expires = Date.now() + 60_000;
    await createCredentialDatabaseWith("opencode", {
      type: "oauth",
      methodID: "server",
      access: "console-access",
      refresh: "console-refresh",
      expires,
      metadata: { email: "ran@example.com", orgID: "wrk_1", orgName: "WSC Sports" },
    });

    const state = await resolveOpenCodeConsoleAuth();
    expect(state).toEqual({
      state: "configured",
      credential: {
        accessToken: "console-access",
        refreshToken: "console-refresh",
        expiresAt: expires,
        orgId: "wrk_1",
        orgName: "WSC Sports",
        email: "ran@example.com",
        server: undefined,
      },
    });
  });

  it("reports expired console credentials", async () => {
    await createCredentialDatabaseWith("opencode", {
      type: "oauth",
      access: "console-access",
      expires: Date.now() - 60_000,
      metadata: { orgID: "wrk_1" },
    });

    const state = await resolveOpenCodeConsoleAuth();
    expect(state.state).toBe("expired");
  });

  it("reports invalid credentials without an access token", async () => {
    await createCredentialDatabaseWith("opencode", { type: "oauth", access: "  " });

    await expect(resolveOpenCodeConsoleAuth()).resolves.toMatchObject({
      state: "invalid",
      error: "OpenCode Console credential has no access token",
    });
  });

  it("ignores key-shaped opencode rows", async () => {
    await createCredentialDatabaseWith("opencode", { type: "key", key: "workspace-key" });

    await expect(resolveOpenCodeConsoleAuth()).resolves.toEqual({ state: "none" });
  });
});
