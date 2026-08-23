import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readOpenAIMultiAuthAccountsFromPath } from "../src/lib/openai-multi-auth.js";

const tempDirs: string[] = [];

async function makeAccountsFile(value: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "opencode-quota-openai-multi-auth-"));
  tempDirs.push(dir);
  const path = join(dir, "accounts.json");
  await writeFile(path, JSON.stringify(value), "utf8");
  return path;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("oc-codex-multi-auth account discovery", () => {
  it("returns null for a missing account file", async () => {
    await expect(
      readOpenAIMultiAuthAccountsFromPath(join(tmpdir(), "does-not-exist-accounts.json")),
    ).resolves.toBeNull();
  });

  it("returns null for malformed or unsupported storage", async () => {
    const malformed = await makeAccountsFile({ version: 3, accounts: "not-an-array" });
    const unsupported = await makeAccountsFile({ version: 2, accounts: [] });

    await expect(readOpenAIMultiAuthAccountsFromPath(malformed)).resolves.toBeNull();
    await expect(readOpenAIMultiAuthAccountsFromPath(unsupported)).resolves.toBeNull();
  });

  it("reads V3 accounts, ignores disabled records, and preserves distinct identities", async () => {
    const path = await makeAccountsFile({
      version: 3,
      activeIndex: 1,
      accounts: [
        {
          accountId: "business-account",
          accountUserId: "seat-a",
          accountLabel: "Business",
          email: "business@example.invalid",
          accessToken: "cached-business",
          refreshToken: "refresh-business",
          expiresAt: Date.now() + 60_000,
          enabled: true,
        },
        {
          accountId: "disabled-account",
          accessToken: "cached-disabled",
          refreshToken: "refresh-disabled",
          enabled: false,
        },
        {
          accountId: "personal-account",
          accountUserId: "seat-b",
          accountLabel: "Personal",
          email: "personal@example.invalid",
          accessToken: "cached-personal",
          refreshToken: "refresh-personal",
          enabled: true,
        },
      ],
    });

    const accounts = await readOpenAIMultiAuthAccountsFromPath(path);

    expect(accounts).toHaveLength(2);
    expect(accounts?.map((account) => account.accountLabel)).toEqual(["Business", "Personal"]);
    expect(accounts?.map((account) => account.sourceId)[0]).toMatch(
      /^openai-multi-auth:[a-f0-9]{16}$/,
    );
    expect(accounts?.[0]?.sourceId).not.toBe(accounts?.[1]?.sourceId);
  });

  it("keeps an enabled account without a cached access token without exposing refresh data", async () => {
    const path = await makeAccountsFile({
      version: 3,
      accounts: [
        {
          accountId: "needs-refresh",
          accountLabel: "Personal",
          refreshToken: "refresh-only",
          enabled: true,
        },
      ],
    });

    const accounts = await readOpenAIMultiAuthAccountsFromPath(path);

    expect(accounts).toHaveLength(1);
    expect(accounts?.[0]?.accessToken).toBeUndefined();
    expect(accounts?.[0]).not.toHaveProperty("refreshToken");
  });
});
