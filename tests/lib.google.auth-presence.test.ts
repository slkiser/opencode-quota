import { beforeEach, describe, expect, it, vi } from "vitest";

const promiseMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
}));

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  readFile: promiseMocks.readFile,
}));

vi.mock("fs", () => ({
  existsSync: fsMocks.existsSync,
}));

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirCandidates: () => ({
    dataDirs: ["/home/test/.local/share/opencode"],
    configDirs: ["/home/test/.config/opencode"],
    cacheDirs: ["/home/test/.cache/opencode"],
    stateDirs: ["/home/test/.local/state/opencode"],
  }),
}));

import {
  hasAntigravityAccountsConfigured,
  inspectAntigravityAccountsPresence,
  readAntigravityAccounts,
} from "../src/lib/google.js";

const CONFIG_PATH = "/home/test/.config/opencode/antigravity-accounts.json";
const DATA_PATH = "/home/test/.local/share/opencode/antigravity-accounts.json";

describe("google antigravity auth presence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
