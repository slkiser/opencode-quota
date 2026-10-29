import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { QuotaSnapshot } from "../src/core/types.js";
import type { AnthropicQuotaResult } from "../src/lib/anthropic.js";
import { anthropicProvider } from "../src/providers/anthropic.js";
import { createQuotaClient } from "../src/tui/client.js";
import { useOpencodeFolders } from "./helpers/opencode-folders.js";
import { createServerContext, writePluginTestSettings } from "./helpers/plugin-test-harness.js";
import { createQuotaRpcBridge, createQuotaRpcEvents } from "./helpers/quota-rpc-bridge.js";

const credentials = vi.hoisted(() => ({
  available: vi.fn(),
  cli: vi.fn(),
  oauth: vi.fn(),
  identity: vi.fn(),
}));

// Only the credential/transport boundary is fake. Selection, availability, source, store,
// server RPC, JSON broadcasts and TUI clients all run their real code.
vi.mock("../src/lib/anthropic.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/anthropic.js")>()),
  hasAnthropicCredentialsConfigured: credentials.available,
  readAnthropicLogins: async () => [
    {
      row: {
        id: "account-A",
        integrationId: "anthropic",
        label: "Account A",
        active: true,
        value: { type: "oauth", access: "fake-account-A" },
      },
      auth: { state: "configured", accessToken: "fake-account-A" },
    },
  ],
  anthropicLoginsIdentity: credentials.identity,
  getAnthropicDiagnostics: credentials.cli,
  queryAnthropicQuotaWithOAuth: credentials.oauth,
}));

const folders = useOpencodeFolders();
const cleanups: Array<() => unknown> = [];

function quota(percentRemaining: number, resetsAt?: string): AnthropicQuotaResult {
  return {
    success: true,
    five_hour: { percentRemaining, ...(resetsAt ? { resetTimeIso: resetsAt } : {}) },
    seven_day: { percentRemaining },
  };
}

function cliQuota(percentRemaining: number) {
  return {
    installed: true,
    authStatus: "authenticated",
    quotaSupported: true,
    quotaSource: "claude-auth-status-json",
    checkedCommands: [],
    quota: quota(percentRemaining),
  };
}

function remaining(snapshot: QuotaSnapshot | undefined) {
  return snapshot?.providers.find((provider) => provider.providerId === "anthropic")?.rows[0]
    ?.percentRemaining;
}

async function setup() {
  const event = Promise.withResolvers<{ type: string; data?: unknown }>();
  const models = new Map<string, string>();
  const fake = createServerContext({
    directory: folders.root,
    openCodeProviders: ["anthropic", "claude-code"],
    sessionGet: vi.fn(async ({ sessionID }) => ({
      model: { id: "claude-sonnet-4-5", providerID: models.get(sessionID) ?? sessionID },
    })),
    events: {
      async *[Symbol.asyncIterator]() {
        yield await event.promise;
      },
    },
  });
  const events = createQuotaRpcEvents();
  fake.emit.mockImplementation(events.emit);
  const { createQuotaServerPlugin } = await import("../src/plugin.js");
  const cleanup = await createQuotaServerPlugin({ providers: () => [anthropicProvider] }).setup(
    fake.ctx as never,
  );
  if (typeof cleanup === "function") cleanups.push(cleanup);
  const handlers = fake.ctx.rpc.register.mock.calls[0]?.[1];
  if (!handlers) throw new Error("quota RPC was not registered");
  function client(onSnapshot?: (snapshot: QuotaSnapshot) => void) {
    const client = createQuotaClient(
      {
        location: { directory: folders.root },
        data: {},
        client: { rpc: createQuotaRpcBridge(handlers, events) as never },
      },
      onSnapshot,
    );
    cleanups.push(client.start());
    return client;
  }
  return {
    client,
    emit: fake.emit,
    loginChanged: () => event.resolve({ type: "credential.switched" }),
    switchModel: (sessionID: string, providerID: string) => models.set(sessionID, providerID),
    modelChanged: (sessionID: string, providerID: string) => {
      models.set(sessionID, providerID);
      event.resolve({
        type: "session.model.selected",
        data: { sessionID, model: { id: "claude-sonnet-4-5", providerID } },
      });
    },
    saveSettings: (patch: object) =>
      handlers.saveSettings({ patch }, { signal: new AbortController().signal }),
  };
}

describe("Anthropic runtime delivery", () => {
  beforeEach(() => {
    credentials.available.mockReset().mockResolvedValue(true);
    credentials.cli.mockReset().mockResolvedValue(cliQuota(40));
    credentials.oauth.mockReset().mockResolvedValue(quota(90));
    credentials.identity
      .mockReset()
      .mockImplementation(async (logins: unknown[]) =>
        logins.length ? "opencode-account-A" : null,
      );
    writePluginTestSettings(folders.configDir, {
      providers: { checking: { minIntervalMs: 60_000 } },
    });
  });

  afterEach(async () => {
    // Stop clients first, then wait for the server's outstanding fetches and writes.
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.restoreAllMocks();
  });

  it.each(["one TUI", "two TUIs"])(
    "keeps two sessions on their selected logins through RPC answers and broadcasts in %s",
    async (surfaces) => {
      const server = await setup();
      const a = server.client();
      const b = surfaces === "one TUI" ? a : server.client();
      await b.refresh("manual", "claude-code");
      expect(remaining(b.snapshot("claude-code"))).toBe(40);
      await a.refresh("manual", "anthropic");

      expect(server.emit).toHaveBeenCalledWith("changed", expect.anything());
      expect(remaining(a.snapshot("anthropic"))).toBe(90);
      expect(remaining(b.snapshot("claude-code"))).toBe(40);

      // A third client's refresh reaches B only through the server's broadcast.
      credentials.cli.mockResolvedValue(cliQuota(35));
      await server.client().refresh("manual", "claude-code");
      expect(remaining(b.snapshot("claude-code"))).toBe(35);
      expect(remaining(a.snapshot("anthropic"))).toBe(90);
    },
  );

  it("keeps an unavailable Claude Code login out of its session after another runtime broadcasts", async () => {
    credentials.available.mockImplementation(
      async ({ useClaudeCodeCredentials }) => !useClaudeCodeCredentials,
    );
    const server = await setup();
    const a = server.client();
    const b = server.client();
    await b.refresh("manual", "claude-code");
    expect(b.snapshot("claude-code")?.providers).toEqual([]);
    await a.refresh("manual", "anthropic");
    expect(remaining(a.snapshot("anthropic"))).toBe(90);
    expect(b.snapshot("claude-code")?.providers).toEqual([]);
    expect(credentials.cli).not.toHaveBeenCalled();
  });

  it.each(["settings recheck", "settings change", "credential event"])(
    "refreshes the active Claude Code login after a %s",
    async (change) => {
      const server = await setup();
      const b = server.client();
      await b.refresh("manual", "claude-code");
      expect(remaining(b.snapshot("claude-code"))).toBe(40);
      server.emit.mockClear();
      credentials.cli.mockResolvedValue(cliQuota(35));
      if (change === "credential event") server.loginChanged();
      else if (change === "settings recheck") {
        await server.saveSettings({ providers: { checking: { requestTimeoutMs: 12_000 } } });
      } else {
        await server.saveSettings({ words: { percent: "used" } });
      }

      // A plain settings change keeps the minimum interval; a recheck or login event fetches.
      const expected = change === "settings change" ? 40 : 35;
      await vi.waitFor(() => expect(server.emit).toHaveBeenCalled());
      await vi.waitFor(() => expect(remaining(b.snapshot("claude-code"))).toBe(expected));
      if (change !== "settings change") expect(credentials.cli).toHaveBeenCalledTimes(2);
      expect(credentials.available).toHaveBeenLastCalledWith(
        expect.objectContaining({ useClaudeCodeCredentials: true }),
      );
    },
  );

  it("fetches B independently while an account-A refresh is in flight", async () => {
    const pendingA = Promise.withResolvers<AnthropicQuotaResult>();
    credentials.oauth.mockReturnValueOnce(pendingA.promise);
    const server = await setup();
    const a = server.client();
    const b = server.client();
    const refreshingA = a.refresh("manual", "anthropic");
    await vi.waitFor(() => expect(credentials.oauth).toHaveBeenCalledOnce());
    const refreshingB = b.refresh("manual", "claude-code");
    // Resolve A even on failure, so server cleanup cannot wait on the stalled request.
    try {
      await vi.waitFor(() => expect(credentials.cli).toHaveBeenCalledOnce());
      expect(remaining(await refreshingB)).toBe(40);
    } finally {
      pendingA.resolve(quota(90));
      await Promise.all([refreshingA, refreshingB]);
    }
    expect(remaining(a.snapshot("anthropic"))).toBe(90);
    expect(remaining(b.snapshot("claude-code"))).toBe(40);
  });

  it("fetches B independently when both identity reads time out and A is still in flight", async () => {
    const realSetTimeout = globalThis.setTimeout;
    // Shorten only the store's 15 s read deadline; its timeout and fallback code still run.
    vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, ms, ...args) =>
      realSetTimeout(callback, ms === 15_000 ? 10 : ms, ...args),
    );
    credentials.identity.mockImplementation(() => new Promise(() => {}));
    const pendingA = Promise.withResolvers<AnthropicQuotaResult>();
    credentials.oauth.mockReturnValueOnce(pendingA.promise);
    const server = await setup();
    const a = server.client();
    const b = server.client();
    const refreshingA = a.refresh("manual", "anthropic");
    await vi.waitFor(() => expect(credentials.oauth).toHaveBeenCalledOnce());
    const refreshingB = b.refresh("manual", "claude-code");
    try {
      await vi.waitFor(() => expect(credentials.cli).toHaveBeenCalledOnce());
      expect(remaining(await refreshingB)).toBe(40);
    } finally {
      pendingA.resolve(quota(90));
      await Promise.all([refreshingA, refreshingB]);
    }
    expect(remaining(a.snapshot("anthropic"))).toBe(90);
    expect(remaining(b.snapshot("claude-code"))).toBe(40);
  });

  describe.each([
    ["claude-code", "anthropic", 90],
    ["anthropic", "claude-code", 40],
  ] as const)("switch from %s to %s", (before, after, expected) => {
    it.each(["settings recheck", "settings change", "credential event"])(
      "uses the current session model after a %s before the next session RPC",
      async (change) => {
        const server = await setup();
        server.switchModel("session", before);
        const client = server.client();
        await client.refresh("manual", "session");
        credentials.cli.mockClear();
        credentials.oauth.mockClear();

        server.switchModel("session", after);
        if (change === "credential event") server.loginChanged();
        else if (change === "settings recheck") {
          await server.saveSettings({ providers: { checking: { requestTimeoutMs: 12_000 } } });
        } else {
          await server.saveSettings({ words: { percent: "used" } });
        }

        await vi.waitFor(() => expect(remaining(client.snapshot("session"))).toBe(expected));
        const selected = after === "claude-code" ? credentials.cli : credentials.oauth;
        const other = after === "claude-code" ? credentials.oauth : credentials.cli;
        expect(selected).toHaveBeenCalledOnce();
        expect(other).not.toHaveBeenCalled();
      },
    );

    it("follows the model-selected event when two sessions started in the same scope", async () => {
      const server = await setup();
      server.switchModel("switching", before);
      server.switchModel("staying", before);
      const client = server.client();
      await client.refresh("manual", "switching");
      await client.refresh("manual", "staying");

      server.modelChanged("switching", after);

      await vi.waitFor(() => expect(remaining(client.snapshot("switching"))).toBe(expected));
      expect(remaining(client.snapshot("staying"))).toBe(before === "claude-code" ? 40 : 90);
    });
  });

  it.each(["startup watch", "closed session"])(
    "keeps account-A reset notices out of a B-only TUI after a %s",
    async (inactive) => {
      let now = Date.now();
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const reset = now + 60_000;
      credentials.oauth.mockResolvedValue(quota(5, new Date(reset).toISOString()));
      const server = await setup();
      const received: QuotaSnapshot[] = [];
      const b = server.client((snapshot) => received.push(snapshot));
      if (inactive === "startup watch") b.watch()();
      else {
        const stop = b.watch("anthropic");
        await vi.waitFor(() => expect(remaining(b.snapshot("anthropic"))).toBe(5));
        stop();
      }
      await vi.waitFor(() => expect(remaining(b.snapshot())).toBe(5));
      cleanups.push(b.watch("claude-code"));
      await vi.waitFor(() => expect(remaining(b.snapshot("claude-code"))).toBe(40));
      received.length = 0;

      now = reset + 1;
      credentials.oauth.mockResolvedValue(quota(90, new Date(now + 5 * 60 * 60_000).toISOString()));
      const a = await server.client().refresh("manual", "anthropic");

      expect(a?.resetNotices).toHaveLength(1);
      expect(received.length).toBeGreaterThan(0);
      expect(received.flatMap((snapshot) => snapshot.resetNotices)).toEqual([]);
      expect(remaining(b.snapshot("claude-code"))).toBe(40);
    },
  );
});
