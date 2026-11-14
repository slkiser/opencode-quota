import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { QuotaSnapshot } from "../src/core/types.js";
import { createQuotaClient, ownFolderEvents } from "../src/tui/client.js";

const NOW = Date.parse("2026-10-10T12:00:00.000Z");

function snapshot(revision: number, input = 0, serverId = "server-1"): QuotaSnapshot {
  return {
    version: 6,
    providers: [],
    resetNotices: [],
    generatedAtMs: NOW,
    serverId,
    revision,
    sessionTokens: { input, cachedInput: 0, output: 0 },
  };
}

/** A quota RPC whose calls wait until the test answers them, oldest first or not. */
function fakeRpc(own?: { directory: string }) {
  const waiting: Array<(snapshot: QuotaSnapshot) => void> = [];
  const call = () =>
    new Promise<{ snapshot: QuotaSnapshot }>((resolve) =>
      waiting.push((answer) => resolve({ snapshot: answer })),
    );
  let changed: (snapshot: QuotaSnapshot, directory?: string) => void = () => {};
  const rpc = {
    snapshot: vi.fn(call),
    refresh: vi.fn(call),
    notices: vi.fn(async () => ({ homeLine: "" })),
    command: vi.fn(),
    events: {
      on: vi.fn(
        (
          _name: string,
          handler: (event: {
            location?: { directory: string };
            data: { snapshot: QuotaSnapshot };
          }) => void,
        ) => {
          changed = (answer, directory) =>
            handler({
              ...(directory ? { location: { directory } } : {}),
              data: { snapshot: answer },
            });
          return () => {};
        },
      ),
    },
  };
  const host = {
    location: { directory: process.cwd() },
    data: {},
    client: { rpc: () => rpc },
  };
  const client = createQuotaClient(
    own ? { ...host, acceptsEventFrom: ownFolderEvents(host) } : host,
  );
  return {
    client,
    host,
    rpc,
    answer: (index: number, answer: QuotaSnapshot) => waiting[index]?.(answer),
    changed: (answer: QuotaSnapshot, directory?: string) => changed(answer, directory),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("TUI quota client", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps the snapshot with the highest revision, even one built in the same millisecond", async () => {
    const { client, answer, changed } = fakeRpc();
    const stop = client.start();
    client.watch();
    changed(snapshot(2));
    answer(0, snapshot(1));
    await settle();
    expect(client.snapshot()?.revision).toBe(2);
    stop();
  });

  it("takes the snapshots of a restarted server, whose revisions start over", async () => {
    const { client, changed } = fakeRpc();
    const stop = client.start();
    client.watch();
    changed(snapshot(5));
    changed(snapshot(1, 0, "server-2"));
    await settle();
    expect(client.snapshot()).toMatchObject({ serverId: "server-2", revision: 1 });
    changed(snapshot(2, 0, "server-2"));
    changed(snapshot(1, 0, "server-2"));
    expect(client.snapshot()).toMatchObject({ serverId: "server-2", revision: 2 });
    stop();
  });

  it("applies folder A again after a folder B answer, keeping revisions and sessions separate", async () => {
    const { client, host, answer, changed } = fakeRpc();
    const stop = client.start();
    const folderA = host.location;
    for (const [index, directory, serverId, revision] of [
      [0, folderA.directory, "server-a", 5],
      [1, "/folder-b", "server-b", 50],
      [2, folderA.directory, "server-a", 6],
    ] as const) {
      host.location = { directory };
      const unwatch = client.watch(`session-${index}`);
      const value = { ...snapshot(revision, index, serverId), sourceScope: "shared-scope" };
      answer(index, value);
      await settle();
      expect(client.snapshot(`session-${index}`)).toMatchObject(value);
      unwatch();
    }
    changed({ ...snapshot(4, 99, "server-a"), sourceScope: "shared-scope" });
    expect(client.snapshot("session-0")).toMatchObject(snapshot(6, 0, "server-a"));
    host.location = { directory: "/folder-b" };
    expect(client.snapshot("session-1")).toMatchObject(snapshot(50, 1, "server-b"));
    stop();
  });

  it("retires only the restarted folder's old server and resets its model revisions", async () => {
    const { client, host, answer, changed } = fakeRpc();
    const stop = client.start();
    const folderA = host.location;
    for (const [index, directory, serverId, revision] of [
      [0, folderA.directory, "server-a", 50],
      [1, "/folder-b", "server-b", 60],
      [2, folderA.directory, "server-a-new", 1],
    ] as const) {
      host.location = { directory };
      const request = client.refresh("turn", directory);
      answer(index, {
        ...snapshot(revision, index, serverId),
        currentModelProviderIds: [serverId],
      });
      await request;
    }
    changed(snapshot(100, 99, "server-a"), folderA.directory);
    expect(client.snapshot(folderA.directory)).toMatchObject({
      serverId: "server-a-new",
      revision: 1,
      currentModelProviderIds: ["server-a-new"],
    });
    host.location = { directory: "/folder-b" };
    changed(snapshot(61, 0, "server-b"), "/folder-b");
    expect(client.snapshot("/folder-b")).toMatchObject({
      serverId: "server-b",
      revision: 61,
      currentModelProviderIds: ["server-b"],
    });
    stop();
  });

  it("keeps a late answer with the folder named when its call started", async () => {
    const { client, host, answer } = fakeRpc();
    const folderA = host.location;
    const first = client.refresh("turn", "session-a");
    host.location = { directory: "/folder-b" };
    const second = client.refresh("turn", "session-b");
    answer(1, snapshot(50, 2, "server-b"));
    await second;
    answer(0, snapshot(5, 1, "server-a"));
    expect(await first).toMatchObject(snapshot(5, 1, "server-a"));
    expect(client.snapshot("session-b")).toMatchObject(snapshot(50, 2, "server-b"));
    host.location = folderA;
    expect(client.snapshot("session-a")).toMatchObject(snapshot(5, 1, "server-a"));
  });

  it("keeps its own folder's server when another folder's server, on the same service, speaks", async () => {
    const own = process.cwd();
    const { client, answer, changed } = fakeRpc({ directory: own });
    const stop = client.start();
    client.watch("ses_1");
    changed(snapshot(5), own);
    changed(snapshot(1, 0, "server-2"), "/other/folder");
    changed(snapshot(1, 0, "server-2"));
    answer(0, snapshot(6, 300));
    await settle();
    expect(client.snapshot("ses_1")).toMatchObject({
      serverId: "server-1",
      revision: 6,
      sessionTokens: { input: 300 },
    });
    stop();
  });

  it("still follows a restarted server of its own folder", async () => {
    const own = process.cwd();
    const { client, changed } = fakeRpc({ directory: own });
    const stop = client.start();
    client.watch();
    changed(snapshot(5), own);
    changed(snapshot(1, 0, "server-2"), own);
    await settle();
    expect(client.snapshot()).toMatchObject({ serverId: "server-2", revision: 1 });
    stop();
  });

  it("ignores a late answer from the server it moved away from", async () => {
    const { client, answer, changed } = fakeRpc();
    const stop = client.start();
    const pending = client.refresh("turn", "ses_1");
    changed(snapshot(20));
    changed(snapshot(1, 0, "server-2"));
    answer(0, snapshot(21, 500));
    await pending;
    // Neither its snapshot nor what it says about the session is taken.
    const shown = client.snapshot("ses_1");
    expect([shown?.serverId, shown?.revision, shown?.sessionTokens]).toEqual([
      "server-2",
      1,
      undefined,
    ]);
    stop();
  });

  it("keeps a session's part from the latest call that asked about it", async () => {
    const { client, answer } = fakeRpc();
    const stop = client.start();
    const first = client.refresh("turn", "ses_1");
    const second = client.refresh("turn", "ses_1");
    answer(1, snapshot(2, 200));
    await second;
    answer(0, snapshot(3, 100));
    await first;
    expect(client.snapshot("ses_1")).toMatchObject({
      revision: 3,
      sessionTokens: { input: 200 },
    });
    stop();
  });

  it("keeps which custom sources serve a session's model to that session", async () => {
    const { client, answer } = fakeRpc();
    const stop = client.start();
    const prefixes = { "quota-providers": ["quota-providers.custom.alpha."] };
    const asked = client.refresh("turn", "ses_1");
    answer(0, { ...snapshot(2), currentModelRowPrefixes: prefixes });
    await asked;
    expect(client.snapshot("ses_1")?.currentModelRowPrefixes).toEqual(prefixes);
    expect(client.snapshot("ses_2")?.currentModelRowPrefixes).toBeUndefined();
    expect(client.snapshot()?.currentModelRowPrefixes).toBeUndefined();
    stop();
  });

  it("drops answers to calls made before the TUI stopped", async () => {
    const { client, rpc, answer, changed } = fakeRpc();
    const stop = client.start();
    client.watch("ses_1");
    stop();
    stop();
    answer(0, snapshot(1));
    changed(snapshot(2));
    await settle();
    expect(client.snapshot("ses_1")).toBeUndefined();

    // Started again, the surface still on screen asks again at once.
    const again = client.start();
    expect(rpc.snapshot).toHaveBeenCalledTimes(2);
    answer(1, snapshot(3));
    await settle();
    expect(client.snapshot("ses_1")?.revision).toBe(3);
    again();
  });

  it("expires inactive session data and ignores later events for those sessions", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const { client, answer, changed } = fakeRpc();
    const stop = client.start();
    for (let index = 0; index < 100; index += 1) {
      const request = client.refresh("turn", `session-${index}`);
      answer(index, { ...snapshot(index + 1, index + 1), currentModelProviderIds: ["old"] });
      await request;
    }
    vi.setSystemTime(NOW + 4 * 60_000);
    changed({ ...snapshot(101), sessionID: "session-0", currentModelProviderIds: ["stale"] });
    vi.setSystemTime(NOW + 5 * 60_000);
    changed({ ...snapshot(102), sessionID: "session-0", currentModelProviderIds: ["stale"] });
    for (let index = 0; index < 80; index += 1) {
      expect(client.snapshot(`session-${index}`)?.sessionTokens).toBeUndefined();
      expect(client.snapshot(`session-${index}`)?.currentModelProviderIds).toBeUndefined();
    }
    for (let index = 80; index < 100; index += 1) {
      expect(client.snapshot(`session-${index}`)).toMatchObject({
        sessionTokens: { input: index + 1 },
        currentModelProviderIds: ["old"],
      });
    }
    // A new request restores all session fields from its answer.
    const reopened = client.refresh("turn", "session-0");
    answer(100, { ...snapshot(103, 300), currentModelProviderIds: ["new"] });
    await reopened;
    expect(client.snapshot("session-0")).toMatchObject({
      sessionTokens: { input: 300 },
      currentModelProviderIds: ["new"],
    });
    stop();
  });

  it("shows cached session data immediately when reopened after five minutes within the newest 20 unwatched sessions", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const { client, rpc, answer, changed } = fakeRpc();
    const stop = client.start();
    const cached: QuotaSnapshot = {
      ...snapshot(1, 123),
      sourceScope: "session-scope",
      providers: [{ providerId: "copilot", label: "Session quota", refreshing: false, rows: [] }],
      currentModelProviderIds: ["copilot"],
      currentModelRowPrefixes: { copilot: ["copilot.premium."] },
    };
    const unwatch = client.watch("reopened");
    answer(0, cached);
    await settle();
    unwatch();
    for (let index = 0; index < 19; index += 1) {
      const request = client.refresh("turn", `session-${index}`);
      answer(index + 1, snapshot(index + 2));
      await request;
    }
    // Watched sessions do not use any of the 20 unwatched cache slots.
    const unwatchOther = client.watch("on-screen");
    answer(20, snapshot(21));
    await settle();
    vi.setSystemTime(NOW + 6 * 60_000);
    changed(snapshot(22));

    const unwatchReopened = client.watch("reopened");
    expect(rpc.snapshot).toHaveBeenLastCalledWith({ sessionID: "reopened" }, expect.anything());
    expect(client.snapshot("reopened")).toMatchObject({
      sourceScope: cached.sourceScope,
      providers: cached.providers,
      sessionTokens: cached.sessionTokens,
      currentModelProviderIds: cached.currentModelProviderIds,
      currentModelRowPrefixes: cached.currentModelRowPrefixes,
    });
    // The fresh answer is still pending when the cached fields above are read.
    answer(21, {
      ...cached,
      revision: 23,
      sessionTokens: { input: 456, cachedInput: 0, output: 0 },
    });
    await settle();
    expect(client.snapshot("reopened")?.sessionTokens?.input).toBe(456);
    unwatchReopened();
    unwatchOther();
    stop();
  });

  it("keeps the most recently read sessions even when their reads share a millisecond", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const { client, answer, changed } = fakeRpc();
    const stop = client.start();
    for (let index = 0; index < 21; index += 1) {
      const request = client.refresh("turn", `session-${index}`);
      answer(index, snapshot(index + 1, index + 1));
      await request;
    }
    expect(client.snapshot("session-0")?.sessionTokens?.input).toBe(1);
    vi.setSystemTime(NOW + 6 * 60_000);
    changed(snapshot(22));
    expect(client.snapshot("session-0")?.sessionTokens?.input).toBe(1);
    expect(client.snapshot("session-1")?.sessionTokens).toBeUndefined();
    stop();
  });

  it("keeps every watched session until its last surface leaves, then expires it outside the newest 20", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const { client, answer, changed } = fakeRpc();
    const stop = client.start();
    const unwatch = client.watch("active");
    const unwatchSecond = client.watch("active");
    answer(0, snapshot(1, 123));
    await settle();
    for (let index = 0; index < 20; index += 1) {
      const request = client.refresh("turn", `session-${index}`);
      answer(index + 1, snapshot(index + 2));
      await request;
    }
    unwatch();
    vi.setSystemTime(NOW + 6 * 60_000);
    changed({ ...snapshot(22), sessionID: "active", currentModelProviderIds: ["new"] });
    expect(client.snapshot("active")).toMatchObject({
      sessionTokens: { input: 123 },
      currentModelProviderIds: ["new"],
    });
    unwatchSecond();
    for (let index = 0; index < 20; index += 1) {
      client.snapshot(`session-${index}`);
    }
    vi.setSystemTime(NOW + 11 * 60_000);
    changed(snapshot(23));
    expect(client.snapshot("active")?.sessionTokens).toBeUndefined();
    stop();
  });

  it("does not let an expired request overwrite a reopened session, even with a higher revision", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const { client, answer, changed } = fakeRpc();
    const stop = client.start();
    const old = client.refresh("turn", "reopened");
    for (let index = 0; index < 20; index += 1) {
      const request = client.refresh("turn", `session-${index}`);
      answer(index + 1, snapshot(1));
      await request;
    }
    vi.setSystemTime(NOW + 5 * 60_000);
    changed(snapshot(1));
    const fresh = client.refresh("turn", "reopened");
    answer(21, { ...snapshot(2, 200), currentModelProviderIds: ["fresh"] });
    await fresh;
    answer(0, { ...snapshot(3, 100), currentModelProviderIds: ["stale"] });
    await old;
    expect(client.snapshot("reopened")).toMatchObject({
      revision: 3,
      sessionTokens: { input: 200 },
      currentModelProviderIds: ["fresh"],
    });
    stop();
  });
});
