import { beforeEach, describe, expect, it, vi } from "vitest";

const promiseMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
}));

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
}));

const identityMocks = vi.hoisted(() => ({
  resolveAntigravityClientCredentials: vi.fn(),
  deriveResolvedAuthIdentity: vi.fn(
    async (params: { providerId: string }) => `identity:${params.providerId}`,
  ),
  composeResolvedAuthIdentities: vi.fn(
    async (params: { providerId: string; identities: readonly string[] }) =>
      `composed:${params.providerId}:${params.identities.join("|")}`,
  ),
}));

const testPaths = vi.hoisted(() => {
  const separator = process.platform === "win32" ? "\\" : "/";
  const join = (...parts: string[]) => parts.join(separator);
  const root = join(process.cwd(), ".google-auth-presence-test");
  const configDir = join(root, "config", "opencode");
  const dataDir = join(root, "data", "opencode");
  return {
    configDir,
    dataDir,
    cacheDir: join(root, "cache", "opencode"),
    stateDir: join(root, "state", "opencode"),
    configPath: join(configDir, "antigravity-accounts.json"),
    dataPath: join(dataDir, "antigravity-accounts.json"),
  };
});

vi.mock("fs/promises", () => ({
  readFile: promiseMocks.readFile,
}));

vi.mock("fs", () => ({
  existsSync: fsMocks.existsSync,
}));

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirCandidates: () => ({
    dataDirs: [testPaths.dataDir],
    configDirs: [testPaths.configDir],
    cacheDirs: [testPaths.cacheDir],
    stateDirs: [testPaths.stateDir],
  }),
}));

vi.mock("../src/lib/google-antigravity-companion.js", () => ({
  inspectAntigravityCompanionPresence: vi.fn(),
  resolveAntigravityClientCredentials: identityMocks.resolveAntigravityClientCredentials,
}));

vi.mock("../src/lib/resolved-auth-identity.js", () => ({
  deriveResolvedAuthIdentity: identityMocks.deriveResolvedAuthIdentity,
  composeResolvedAuthIdentities: identityMocks.composeResolvedAuthIdentities,
}));

import {
  hasAntigravityAccountsConfigured,
  inspectAntigravityAccountsPresence,
  readAntigravityAccounts,
  resolveGoogleAntigravityAuthIdentity,
} from "../src/lib/google.js";

const CONFIG_PATH = testPaths.configPath;
const DATA_PATH = testPaths.dataPath;

describe("google antigravity auth presence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    identityMocks.resolveAntigravityClientCredentials.mockResolvedValue({
      state: "configured",
      clientId: "client-id",
      clientSecret: "client-secret",
    });
  });

  it("composes account and companion cache identities from the selected accounts file", async () => {
    fsMocks.existsSync.mockImplementation((path) => path === CONFIG_PATH);
    promiseMocks.readFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        accounts: [
          {
            email: "alice@example.com",
            refreshToken: "refresh-secret",
            projectId: "project-one",
            addedAt: 0,
            lastUsed: 0,
          },
        ],
      }),
    );

    const identity = await resolveGoogleAntigravityAuthIdentity();

    expect(identityMocks.deriveResolvedAuthIdentity).toHaveBeenCalledWith({
      providerId: "google-antigravity",
      principal: { kind: "credential", value: "refresh-secret" },
      qualifiers: ["project-one"],
    });
    expect(identityMocks.deriveResolvedAuthIdentity).toHaveBeenCalledWith({
      providerId: "google-antigravity:companion",
      principal: { kind: "credential", value: "client-secret" },
      qualifiers: ["client-id"],
    });
    expect(identity).toContain("composed:google-antigravity:");
    expect(identity).not.toContain("refresh-secret");
  });

  it("reports missing when no candidate accounts file exists", async () => {
    fsMocks.existsSync.mockReturnValue(false);

    await expect(inspectAntigravityAccountsPresence()).resolves.toEqual({
      state: "missing",
      presentPaths: [],
      candidatePaths: [CONFIG_PATH, DATA_PATH],
      accountCount: 0,
      validAccountCount: 0,
    });
    await expect(hasAntigravityAccountsConfigured()).resolves.toBe(false);
    await expect(readAntigravityAccounts()).resolves.toBeNull();
  });

  it("skips an invalid earlier file and uses a later valid accounts file", async () => {
    fsMocks.existsSync.mockImplementation((path) => path === CONFIG_PATH || path === DATA_PATH);
    promiseMocks.readFile.mockImplementation(async (path: string) => {
      if (path === CONFIG_PATH) {
        return "{not-json";
      }

      if (path === DATA_PATH) {
        return JSON.stringify({
          version: 1,
          accounts: [
            {
              email: "user@example.com",
              refreshToken: "refresh-token",
              projectId: "proj-1",
              addedAt: 0,
              lastUsed: 0,
            },
          ],
        });
      }

      throw new Error(`unexpected path ${path}`);
    });

    await expect(inspectAntigravityAccountsPresence()).resolves.toEqual({
      state: "present",
      selectedPath: DATA_PATH,
      presentPaths: [CONFIG_PATH, DATA_PATH],
      candidatePaths: [CONFIG_PATH, DATA_PATH],
      accountCount: 1,
      validAccountCount: 1,
    });
    await expect(hasAntigravityAccountsConfigured()).resolves.toBe(true);
    await expect(readAntigravityAccounts()).resolves.toEqual([
      {
        email: "user@example.com",
        refreshToken: "refresh-token",
        projectId: "proj-1",
        addedAt: 0,
        lastUsed: 0,
      },
    ]);
  });

  it("skips an empty earlier file and uses a later valid accounts file", async () => {
    fsMocks.existsSync.mockImplementation((path) => path === CONFIG_PATH || path === DATA_PATH);
    promiseMocks.readFile.mockImplementation(async (path: string) => {
      if (path === CONFIG_PATH) {
        return JSON.stringify({
          version: 1,
          accounts: [],
        });
      }

      if (path === DATA_PATH) {
        return JSON.stringify({
          version: 1,
          accounts: [
            {
              email: "user@example.com",
              refreshToken: "refresh-token",
              projectId: "proj-1",
              addedAt: 0,
              lastUsed: 0,
            },
          ],
        });
      }

      throw new Error(`unexpected path ${path}`);
    });

    await expect(inspectAntigravityAccountsPresence()).resolves.toEqual({
      state: "present",
      selectedPath: DATA_PATH,
      presentPaths: [CONFIG_PATH, DATA_PATH],
      candidatePaths: [CONFIG_PATH, DATA_PATH],
      accountCount: 1,
      validAccountCount: 1,
    });
    await expect(hasAntigravityAccountsConfigured()).resolves.toBe(true);
    await expect(readAntigravityAccounts()).resolves.toEqual([
      {
        email: "user@example.com",
        refreshToken: "refresh-token",
        projectId: "proj-1",
        addedAt: 0,
        lastUsed: 0,
      },
    ]);
  });

  it("treats a present file with no valid refresh tokens as present but not configured", async () => {
    fsMocks.existsSync.mockImplementation((path) => path === CONFIG_PATH);
    promiseMocks.readFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        accounts: [
          {
            email: "user@example.com",
            refreshToken: "",
            projectId: "proj-1",
            addedAt: 0,
            lastUsed: 0,
          },
        ],
      }),
    );

    await expect(inspectAntigravityAccountsPresence()).resolves.toEqual({
      state: "present",
      selectedPath: CONFIG_PATH,
      presentPaths: [CONFIG_PATH],
      candidatePaths: [CONFIG_PATH, DATA_PATH],
      accountCount: 1,
      validAccountCount: 0,
    });
    await expect(hasAntigravityAccountsConfigured()).resolves.toBe(false);
    await expect(readAntigravityAccounts()).resolves.toBeNull();
  });
});
