import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ dataDir: "" }));

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirCandidates: () => ({ dataDirs: [runtime.dataDir] }),
  getOpencodeRuntimeDirs: () => ({ dataDir: runtime.dataDir }),
}));

import {
  clearReadAuthFileCacheForTests,
  isCurrentXaiOAuth,
  readAuthFile,
  updateCurrentXaiOAuth,
} from "../src/lib/opencode-auth.js";

describe("OpenCode auth updates", () => {
  let tempDir: string;
  let authFile: string;
  let originalAuthContent: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "opencode-quota-auth-"));
    runtime.dataDir = join(tempDir, "data");
    authFile = join(runtime.dataDir, "auth.json");
    mkdirSync(runtime.dataDir, { recursive: true });
    originalAuthContent = process.env.OPENCODE_AUTH_CONTENT;
    delete process.env.OPENCODE_AUTH_CONTENT;
    clearReadAuthFileCacheForTests();
  });

  afterEach(() => {
    if (originalAuthContent === undefined) {
      delete process.env.OPENCODE_AUTH_CONTENT;
    } else {
      process.env.OPENCODE_AUTH_CONTENT = originalAuthContent;
    }
    clearReadAuthFileCacheForTests();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("atomically replaces only the matching xAI record", async () => {
    writeFileSync(
      authFile,
      JSON.stringify({
        companion: { type: "oauth", access: "companion-access", custom: "preserve-me" },
        xai: {
          type: "oauth",
          access: "old-access",
          refresh: "old-refresh",
          expires: 100,
          accountId: "account-1",
        },
      }),
      { encoding: "utf8", mode: 0o600 },
    );

    await expect(isCurrentXaiOAuth({ access: "old-access", refresh: "old-refresh" })).resolves.toBe(
      true,
    );
    await expect(
      updateCurrentXaiOAuth({
        expectedAccess: "old-access",
        expectedRefresh: "old-refresh",
        access: "new-access",
        refresh: "new-refresh",
        expires: 200,
      }),
    ).resolves.toBe(true);

    expect(JSON.parse(readFileSync(authFile, "utf8"))).toEqual({
      companion: { type: "oauth", access: "companion-access", custom: "preserve-me" },
      xai: {
        type: "oauth",
        access: "new-access",
        refresh: "new-refresh",
        expires: 200,
        accountId: "account-1",
      },
    });
    expect(statSync(authFile).mode & 0o777).toBe(0o600);
  });

  it("does not overwrite an xAI record changed by OpenCode", async () => {
    const original = {
      xai: { type: "oauth", access: "newer-access", refresh: "newer-refresh", expires: 300 },
    };
    writeFileSync(authFile, JSON.stringify(original), { encoding: "utf8", mode: 0o600 });

    await expect(
      updateCurrentXaiOAuth({
        expectedAccess: "old-access",
        expectedRefresh: "old-refresh",
        access: "refreshed-access",
        refresh: "refreshed-refresh",
        expires: 400,
      }),
    ).resolves.toBe(false);

    expect(JSON.parse(readFileSync(authFile, "utf8"))).toEqual(original);
  });

  it("does not mutate file-backed auth when OPENCODE_AUTH_CONTENT is active", async () => {
    const original = {
      xai: { type: "oauth", access: "old-access", refresh: "old-refresh", expires: 100 },
    };
    writeFileSync(authFile, JSON.stringify(original), { encoding: "utf8", mode: 0o600 });
    const environmentAuth = {
      xai: { type: "oauth", access: "env-access", refresh: "env-refresh", expires: 200 },
    };
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(environmentAuth);

    await expect(readAuthFile()).resolves.toEqual(environmentAuth);

    await expect(isCurrentXaiOAuth({ access: "old-access", refresh: "old-refresh" })).resolves.toBe(
      false,
    );
    await expect(
      updateCurrentXaiOAuth({
        expectedAccess: "old-access",
        expectedRefresh: "old-refresh",
        access: "refreshed-access",
        refresh: "refreshed-refresh",
        expires: 200,
      }),
    ).resolves.toBe(false);

    expect(JSON.parse(readFileSync(authFile, "utf8"))).toEqual(original);
  });
});
