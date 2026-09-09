import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const testPaths = vi.hoisted(() => ({
  home: "/tmp/opencode-quota-openai-multi-auth-home",
}));
const identityMocks = vi.hoisted(() => ({
  composeResolvedAuthIdentities: vi.fn(
    async ({ identities }: { identities: readonly string[] }) => `composed:${identities.join("|")}`,
  ),
  deriveResolvedAuthIdentity: vi.fn(
    async ({ principal }: { principal: { kind: string; value: string } }) =>
      `opaque-${principal.kind}-${[...principal.value].reduce((sum, character) => sum + character.charCodeAt(0), 0)}`,
  ),
}));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => testPaths.home,
}));

vi.mock("../src/lib/resolved-auth-identity.js", () => identityMocks);

import {
  readOpenAIMultiAuthAccountsFromPath,
  resolveOpenAIMultiAuthIdentity,
} from "../src/lib/openai-multi-auth.js";

const tempDirs: string[] = [];

async function makeAccountsFile(value: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "opencode-quota-openai-multi-auth-"));
  tempDirs.push(dir);
  const path = join(dir, "accounts.json");
  await writeFile(path, JSON.stringify(value), "utf8");
  return path;
}

async function writeGlobalAccountsFile(value: unknown): Promise<void> {
  const directory = join(testPaths.home, ".opencode");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "oc-codex-multi-auth-accounts.json"),
    JSON.stringify(value),
    "utf8",
  );
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  await rm(testPaths.home, { recursive: true, force: true });
  identityMocks.deriveResolvedAuthIdentity.mockClear();
  identityMocks.composeResolvedAuthIdentities.mockClear();
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

  it("accepts optional metadata, sanitizes plan types, and keeps addedAt", async () => {
    const path = await makeAccountsFile({
      version: 1,
      accounts: [
        {
          accountId: "account-with-metadata",
          planType: " PRO ",
          addedAt: 1_700_000_000_000,
          refreshToken: "refresh-metadata",
        },
        {
          accountId: "account-with-unknown-plan",
          planType: "<script>alert(1)</script>",
          refreshToken: "refresh-unknown-plan",
        },
      ],
    });

    const accounts = await readOpenAIMultiAuthAccountsFromPath(path);

    expect(accounts).toEqual([
      expect.objectContaining({
        accountId: "account-with-metadata",
        planType: "pro",
        addedAt: 1_700_000_000_000,
      }),
      expect.objectContaining({
        accountId: "account-with-unknown-plan",
        planType: undefined,
      }),
    ]);
  });

  it("uses only stable metadata for source ids and retains ambiguous subscriptions", async () => {
    const path = await makeAccountsFile({
      version: 3,
      accounts: [
        {
          accountId: "stable-account",
          organizationId: "workspace",
          accountUserId: "member",
          email: "first@example.invalid",
          accessToken: "access-first",
          refreshToken: "refresh-first",
          addedAt: 10,
        },
        {
          accountId: "stable-account",
          organizationId: "workspace",
          accountUserId: "member",
          email: "second@example.invalid",
          accessToken: "access-second",
          refreshToken: "refresh-second",
          addedAt: 10,
        },
        {
          email: "ambiguous-first@example.invalid",
          accessToken: "ambiguous-access-first",
          refreshToken: "ambiguous-refresh-first",
        },
        {
          email: "ambiguous-second@example.invalid",
          accessToken: "ambiguous-access-second",
          refreshToken: "ambiguous-refresh-second",
        },
      ],
    });

    const accounts = await readOpenAIMultiAuthAccountsFromPath(path);

    expect(accounts).toHaveLength(4);
    expect(accounts?.[0]?.sourceId).not.toBe(accounts?.[1]?.sourceId);
    expect(accounts?.[0]?.sourceId?.split(":slot-")[0]).toBe(
      accounts?.[1]?.sourceId?.split(":slot-")[0],
    );
    expect(accounts?.[2]?.sourceId).toBe("openai-multi-auth:slot-2");
    expect(accounts?.[3]?.sourceId).toBe("openai-multi-auth:slot-3");
    expect(accounts?.map((account) => account.sourceId).join("\n")).not.toContain(
      "example.invalid",
    );
    expect(accounts?.map((account) => account.sourceId).join("\n")).not.toContain("access-");
    expect(accounts?.map((account) => account.sourceId).join("\n")).not.toContain("refresh-");
    expect(JSON.stringify(accounts)).not.toContain("refreshToken");
  });

  it("changes a stable source id when addedAt changes", async () => {
    const path = await makeAccountsFile({
      version: 3,
      accounts: [
        { accountId: "account", addedAt: 1, refreshToken: "refresh-one" },
        { accountId: "account", addedAt: 2, refreshToken: "refresh-two" },
      ],
    });

    const accounts = await readOpenAIMultiAuthAccountsFromPath(path);

    expect(accounts?.[0]?.sourceId).not.toBe(accounts?.[1]?.sourceId);
  });

  it("treats a valid account pool as active and keeps its cache identity stable when reordered", async () => {
    const accounts = [
      { accountId: "account-a", refreshToken: "refresh-a" },
      { accountId: "account-b", refreshToken: "refresh-b" },
    ];
    await writeGlobalAccountsFile({ version: 3, accounts });

    const first = await resolveOpenAIMultiAuthIdentity();
    await writeGlobalAccountsFile({ version: 3, accounts: [...accounts].reverse() });
    const reordered = await resolveOpenAIMultiAuthIdentity();

    expect(first.state).toBe("active");
    expect(first.identity).toBe(reordered.identity);
    expect(identityMocks.deriveResolvedAuthIdentity).toHaveBeenCalledWith({
      providerId: "openai",
      principal: { kind: "stable-id", value: '["account-a",null,null,null]' },
    });
  });

  it("changes the account-set identity when an enabled account is added", async () => {
    await writeGlobalAccountsFile({
      version: 3,
      accounts: [{ accountId: "account-a", refreshToken: "refresh-a" }],
    });
    const first = await resolveOpenAIMultiAuthIdentity();

    await writeGlobalAccountsFile({
      version: 3,
      accounts: [
        { accountId: "account-a", refreshToken: "refresh-a" },
        { accountId: "account-b", refreshToken: "refresh-b" },
      ],
    });
    const expanded = await resolveOpenAIMultiAuthIdentity();

    expect(first).toMatchObject({ state: "active" });
    expect(expanded).toMatchObject({ state: "active" });
    expect(first.identity).not.toBe(expanded.identity);
  });

  it("uses the private refresh credential only when stable account metadata is absent", async () => {
    const refreshToken = "refresh-private-only";
    await writeGlobalAccountsFile({
      version: 3,
      accounts: [{ email: "private@example.invalid", refreshToken }],
    });

    const resolved = await resolveOpenAIMultiAuthIdentity();

    expect(resolved.state).toBe("active");
    expect(identityMocks.deriveResolvedAuthIdentity).toHaveBeenCalledWith({
      providerId: "openai",
      principal: { kind: "credential", value: refreshToken },
    });
    expect(JSON.stringify(resolved)).not.toContain(refreshToken);
  });

  it("returns active with a null identity when private identity protection fails", async () => {
    identityMocks.deriveResolvedAuthIdentity.mockResolvedValueOnce(null);
    await writeGlobalAccountsFile({
      version: 3,
      accounts: [{ accountId: "protected-account", refreshToken: "refresh-protected" }],
    });

    await expect(resolveOpenAIMultiAuthIdentity()).resolves.toEqual({
      state: "active",
      identity: null,
    });
  });
});
