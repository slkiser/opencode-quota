/**
 * OpenCode loads the plugin again many times an hour: every module starts afresh and a new store
 * reads the snapshot file the last one wrote. Through the real Claude provider, a temp
 * `opencode.db` and fake HTTP, the new instance sends no usage request before the last check's
 * wait has passed. A login that can't be saved (as on Windows) is checked again after 30 s; it
 * sends none only within the minute Claude's shared probe reuses its last reply.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { getProviders } from "../src/providers/registry.js";
import { defaultSettings } from "../src/settings/index.js";
import { fakeHttp, useProviderWorld } from "./helpers/provider-fetch.js";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const START_MS = Date.parse("2026-10-10T12:00:00.000Z");
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const POSIX_IDENTITY_STORAGE = process.platform !== "win32" && typeof process.getuid === "function";

const world = useProviderWorld();
const cleanups: Array<() => unknown> = [];
let usageReply: () => Response;
let usageRequests: () => number;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START_MS);
  world.storeLogins([
    {
      id: "work",
      integrationId: "anthropic",
      label: "work",
      active: null,
      updated: 1,
      value: { type: "oauth", access: "token-work", expires: START_MS + 24 * 60 * MINUTE },
    },
  ]);
  const fetchMock = fakeHttp((url) => (url === USAGE_URL ? usageReply() : {}));
  usageRequests = () => fetchMock.mock.calls.filter(([url]) => String(url) === USAGE_URL).length;
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  // Reloads share Claude's usage probe within a process; the next test starts a new one.
  (await import("../src/lib/anthropic.js")).clearAnthropicDiagnosticsCacheForTests();
  vi.useRealTimers();
});

function usage(): Response {
  return new Response(
    JSON.stringify({ five_hour: { utilization: 10 }, seven_day: { utilization: 20 } }),
  );
}

function rateLimited(retryAfterSeconds: number): Response {
  return new Response("{}", { status: 429, headers: { "Retry-After": `${retryAfterSeconds}` } });
}

/** As on Windows: no protected key file, so no login identity is saved. */
function withoutIdentityStorage(): void {
  const getuid = process.getuid;
  Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
  cleanups.push(() => {
    Object.defineProperty(process, "getuid", { value: getuid, configurable: true });
  });
}

/**
 * One plugin instance: every module loaded afresh, OpenCode's logins bound again, and a store
 * over Claude alone (checks at most once a minute) on the shared snapshot file.
 */
async function startInstance(providerIds = ["anthropic"]) {
  vi.resetModules();
  const { bindCredentialSource } = await import("../src/lib/opencode-auth.js");
  const { createSqliteCredentialSource } = await import("../src/lib/opencode-auth-sqlite.js");
  const { loadProviderSource } = await import("../src/core/provider-source.js");
  const { createQuotaStore } = await import("../src/core/store.js");
  cleanups.push(bindCredentialSource(createSqliteCredentialSource()));
  const settings = defaultSettings();
  // No Claude CLI: only the OpenCode login counts.
  settings.providers.anthropic.binaryPath = join(world.configDir, "no-claude");
  settings.providers.checking.minIntervalMs = MINUTE;
  settings.providers.off = getProviders()
    .map(({ id }) => (id === "quota-providers" ? "custom" : id))
    .filter((id) => id !== "anthropic");
  const loaded = {
    path: "settings.jsonc",
    exists: true,
    settings,
    issues: [],
    fromFile: [],
    notRead: [],
  };
  const client = {
    config: { providers: async () => ({ data: { providers: providerIds.map((id) => ({ id })) } }) },
  };
  const host = {
    client,
    workspaceRoot: world.configDir,
    locationDirectory: world.configDir,
    settings: () => loaded,
  };
  const store = createQuotaStore({
    source: (model) => loadProviderSource(host, model),
    file: join(world.configDir, "snapshot-v6.json"),
    log: () => {},
  });
  cleanups.push(() => store.dispose());
  return store;
}

/** A new instance's first snapshot and poll, as the TUI asks after a reload. */
async function reloadAndPoll() {
  const store = await startInstance();
  await store.snapshot();
  return { store, snapshot: await store.refresh({ reason: "poll" }) };
}

function usagePath(): string {
  return join(process.env.XDG_STATE_HOME!, "opencode-claude-code-plugin", "account-usage.json");
}

function writeNamedReadings(): string {
  const path = usagePath();
  mkdirSync(dirname(path), { recursive: true });
  const reading = {
    utilization: 0.2,
    observedAt: START_MS - SECOND,
    resetsAt: START_MS + 60 * MINUTE,
    status: "allowed",
  };
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      accounts: {
        default: { five_hour: reading },
        work: { five_hour: reading },
      },
    }),
  );
  return path;
}

it("refreshes named readings, keeps valid ones through bad source data, and keeps listed-account and OpenCode-login caches apart", async () => {
  const path = writeNamedReadings();
  usageReply = usage;
  const ids = ["anthropic", "claude-code-default", "claude-code-work", "openai"];
  const first = await startInstance(ids);
  const model = { providerID: "claude-code-work", id: "sonnet" };
  const snapshot = await first.refresh({ reason: "manual", model });
  expect(snapshot.providers[0]?.rows.map((row) => [row.id, row.account])).toEqual([
    ["anthropic.five_hour", "Default"],
    ["anthropic.five_hour", "Work"],
  ]);
  expect(snapshot.providerAccounts).toEqual({
    "claude-code-default": { providerId: "anthropic", account: "Default" },
    "claude-code-work": { providerId: "anthropic", account: "Work" },
    "claude-code": { providerId: "anthropic", account: "Default" },
    "claude-agent": { providerId: "anthropic", account: "Default" },
  });
  vi.setSystemTime(START_MS + MINUTE);
  const reread = await first.refresh({ reason: "poll", model });
  expect(reread.providers[0]).toMatchObject({
    okAtMs: START_MS + MINUTE,
    checkedAtMs: START_MS + MINUTE,
  });
  expect(usageRequests()).toBe(0);
  writeFileSync(path, "{");
  const bad = await first.refresh({ reason: "manual", model });
  expect(bad.providers[0]).toMatchObject({ error: { code: "no_data" }, okAtMs: START_MS + MINUTE });
  expect(bad.providers[0]?.rows.map((row) => row.percentRemaining)).toEqual([80, 80]);
  const login = await first.refresh({
    reason: "manual",
    model: { providerID: "anthropic", id: "sonnet" },
  });
  expect(login.providers[0]?.rows[0]).toMatchObject({
    id: "anthropic.five_hour",
    percentRemaining: 90,
  });
  expect(login.providerAccounts).toBeUndefined();
  const named = await first.snapshot({ refresh: false, model });
  expect(named.sourceScope).not.toBe(login.sourceScope);
  expect(named.providers[0]?.rows.map((row) => row.account)).toEqual(["Default", "Work"]);
  ids.splice(ids.indexOf("claude-code-default"), 1);
  const removed = await first.snapshot({ refresh: false, model });
  expect(removed.sourceScope).not.toBe(named.sourceScope);
  expect(removed.providers[0]?.rows ?? []).toEqual([]);
});

it("rereads the plugin's file at every refresh, without waiting out the check interval", async () => {
  const path = writeNamedReadings();
  const ids = ["claude-code-default", "claude-code-work"];
  const model = { providerID: "claude-code-work", id: "sonnet" };
  const store = await startInstance(ids);
  await store.refresh({ reason: "poll", model });
  const usage = JSON.parse(readFileSync(path, "utf8"));
  usage.accounts.work.five_hour.utilization = 0.5;
  writeFileSync(path, JSON.stringify(usage));
  vi.setSystemTime(START_MS + 10 * SECOND);
  const polled = await store.refresh({ reason: "poll", model });
  expect(polled.providers[0]?.rows.map((row) => [row.account, row.percentRemaining])).toEqual([
    ["Default", 80],
    ["Work", 50],
  ]);
});

it("names the account the session's model uses, and none for another vendor's model", async () => {
  writeNamedReadings();
  const store = await startInstance(["claude-code-default", "claude-code-work"]);
  const work = await store.refresh({
    reason: "poll",
    model: { providerID: "claude-code-work", id: "sonnet" },
  });
  expect(work.currentModelAccount).toEqual({ providerId: "anthropic", account: "Work" });
  const other = await store.snapshot({
    refresh: false,
    model: { providerID: "openai", id: "gpt-5" },
  });
  expect(other.currentModelAccount).toBeUndefined();
});

it("rereads 30 s after a turn when the plugin had no reading yet, without a backoff", async () => {
  const ids = ["claude-code-default", "claude-code-work"];
  const model = { providerID: "claude-code-work", id: "sonnet" };
  const store = await startInstance(ids);
  const path = usagePath();
  for (const minute of [0, 1, 2, 3]) {
    if (minute === 2) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ version: 1, accounts: {} }));
    }
    vi.setSystemTime(START_MS + minute * MINUTE);
    const polled = await store.refresh({ reason: "poll", model });
    expect(polled.providers[0]).toMatchObject({
      rows: [],
      checkedAtMs: START_MS + minute * MINUTE,
    });
    expect(polled.providers[0]?.error).toBeUndefined();
  }
  writeNamedReadings();
  vi.setSystemTime(START_MS + 3 * MINUTE + 30 * SECOND);
  const afterTurn = await store.refresh({ reason: "turn", model });
  expect(afterTurn.providers[0]?.rows.map((row) => [row.account, row.percentRemaining])).toEqual([
    ["Default", 80],
    ["Work", 80],
  ]);
});

it("keeps no copy of named readings across a reload, and its first refresh rereads the plugin's file", async () => {
  writeNamedReadings();
  const ids = ["anthropic", "claude-code-default", "claude-code-work"];
  const model = { providerID: "claude-code-work", id: "sonnet" };
  const first = await startInstance(ids);
  await first.refresh({ reason: "manual", model });
  await first.dispose();

  vi.setSystemTime(START_MS + 10 * SECOND);
  const reloaded = await startInstance(ids);
  const restored = await reloaded.snapshot({ refresh: false, model });
  expect(restored.providers[0]?.rows ?? []).toEqual([]);
  const polled = await reloaded.refresh({ reason: "poll", model });
  expect(polled.providers[0]?.checkedAtMs).toBe(START_MS + 10 * SECOND);
  expect(polled.providers[0]?.rows.map((row) => [row.account, row.percentRemaining])).toEqual([
    ["Default", 80],
    ["Work", 80],
  ]);
});

describe.each([
  { login: "a saved login", saved: true },
  { login: "a login that can't be saved (as on Windows)", saved: false },
])("after a reload, with $login", ({ saved }) => {
  beforeEach(() => {
    if (!saved) withoutIdentityStorage();
  });

  it.runIf(!saved || POSIX_IDENTITY_STORAGE)(
    "sends no usage request within the check interval of the last check",
    async () => {
      usageReply = usage;
      const first = await startInstance();
      await first.refresh({ reason: "poll" });
      await first.dispose();
      expect(usageRequests()).toBe(1);

      vi.setSystemTime(START_MS + MINUTE - SECOND);
      const { store, snapshot } = await reloadAndPoll();
      expect(usageRequests()).toBe(1);
      // A saved login's rows come back from the file; others are checked again after 30 s and
      // get the reply Claude's shared probe still holds, so no usage request goes out.
      expect(snapshot.providers[0]?.rows.length).toBe(2);

      // The next request waits one interval after the last check: the file's, or that recheck's.
      vi.setSystemTime(saved ? START_MS + MINUTE : START_MS + 2 * MINUTE - SECOND);
      await store.refresh({ reason: "poll" });
      expect(usageRequests()).toBe(2);
    },
  );

  it.runIf(!saved || POSIX_IDENTITY_STORAGE)(
    "waits out the Retry-After of a rate limit",
    async () => {
      usageReply = () => rateLimited(240);
      const first = await startInstance();
      await first.refresh({ reason: "poll" });
      await first.dispose();
      expect(usageRequests()).toBe(1);

      vi.setSystemTime(START_MS + 4 * MINUTE - SECOND);
      const { store } = await reloadAndPoll();
      expect(usageRequests()).toBe(1);

      usageReply = usage;
      vi.setSystemTime(START_MS + 4 * MINUTE);
      const recovered = await store.refresh({ reason: "poll" });
      expect(usageRequests()).toBe(2);
      expect(recovered.providers[0]?.rows.length).toBe(2);
    },
  );

  it.runIf(!saved || POSIX_IDENTITY_STORAGE)(
    "waits out the error backoff after failures in a row",
    async () => {
      // Each failure doubles the wait: 1, 2, then 4 minutes.
      usageReply = () => new Response("down", { status: 503 });
      const first = await startInstance();
      await first.refresh({ reason: "poll" });
      vi.setSystemTime(START_MS + MINUTE);
      await first.refresh({ reason: "poll" });
      vi.setSystemTime(START_MS + 3 * MINUTE);
      await first.refresh({ reason: "poll" });
      await first.dispose();
      expect(usageRequests()).toBe(3);

      vi.setSystemTime(START_MS + 7 * MINUTE - SECOND);
      const { store } = await reloadAndPoll();
      expect(usageRequests()).toBe(3);

      // The fourth failure in a row waits 8 minutes.
      vi.setSystemTime(START_MS + 7 * MINUTE);
      await store.refresh({ reason: "poll" });
      expect(usageRequests()).toBe(4);
      vi.setSystemTime(START_MS + 15 * MINUTE - SECOND);
      await store.refresh({ reason: "poll" });
      expect(usageRequests()).toBe(4);
      vi.setSystemTime(START_MS + 15 * MINUTE);
      await store.refresh({ reason: "poll" });
      expect(usageRequests()).toBe(5);
    },
  );
});
