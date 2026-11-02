/**
 * OpenCode loads the plugin again many times an hour: every module starts afresh and a new store
 * reads the snapshot file the last one wrote. Through the real Claude provider, a temp
 * `opencode.db` and fake HTTP, the new instance sends no usage request before the last check's
 * wait has passed, also when the login can't be saved (as on Windows).
 */

import { join } from "node:path";
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
async function startInstance() {
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
    config: { providers: async () => ({ data: { providers: [{ id: "anthropic" }] } }) },
  };
  const host = {
    client,
    workspaceRoot: world.configDir,
    locationDirectory: world.configDir,
    settings: () => loaded,
  };
  const store = createQuotaStore({
    source: () => loadProviderSource(host),
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

describe.each([
  { login: "a saved login", saved: true },
  { login: "a login that can't be saved (as on Windows)", saved: false },
])("after a reload, with $login", ({ saved }) => {
  beforeEach(() => {
    if (!saved) withoutIdentityStorage();
  });

  it.runIf(!saved || POSIX_IDENTITY_STORAGE)(
    "waits out the check interval of the last check",
    async () => {
      usageReply = usage;
      const first = await startInstance();
      await first.refresh({ reason: "poll" });
      await first.dispose();
      expect(usageRequests()).toBe(1);

      vi.setSystemTime(START_MS + MINUTE - SECOND);
      const { store, snapshot } = await reloadAndPoll();
      expect(usageRequests()).toBe(1);
      // Only a saved login's rows are shown again; others wait for the next check.
      expect(snapshot.providers[0]?.rows.length).toBe(saved ? 2 : 0);

      vi.setSystemTime(START_MS + MINUTE);
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
