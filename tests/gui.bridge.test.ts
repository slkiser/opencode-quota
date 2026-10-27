import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { QuotaSnapshot } from "../src/core/types.js";
import type { UsageReport } from "../src/core/usage.js";
import { createGuiQuota } from "../src/gui/bridge.js";
import type { ClientSettings } from "../src/settings/index.js";

const NOW = Date.parse("2026-10-27T12:00:00.000Z");

const SNAPSHOT: QuotaSnapshot = {
  version: 6,
  providers: [
    {
      providerId: "copilot",
      label: "Copilot",
      refreshing: false,
      rows: [
        {
          id: "copilot.premium",
          providerId: "copilot",
          label: "Premium interactions",
          type: "quota",
          method: "remote_api",
          authority: "provider_reported",
          prominence: "primary",
          percentRemaining: 40,
          resetsAt: "2026-11-01T00:00:00.000Z",
        },
      ],
    },
  ],
  resetNotices: [],
  generatedAtMs: NOW,
  serverId: "server-1",
  revision: 1,
};

/** The quota RPC of one server; every call records its input and options. */
function fakeRpc() {
  return {
    snapshot: vi.fn(async () => ({ snapshot: SNAPSHOT })),
    refresh: vi.fn(async () => ({ snapshot: SNAPSHOT })),
    notices: vi.fn(async () => ({ homeLine: "" })),
    usage: vi.fn(async () => ({ report: { range: "7d" } as unknown as UsageReport })),
    settings: vi.fn(async () => ({ values: {} }) as unknown as ClientSettings),
    events: { on: vi.fn(() => () => {}) },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

type ChangedEvent = { location?: { directory: string }; data: { snapshot: QuotaSnapshot } };

/**
 * The quota RPC of one server, by folder: `snapshot` answers the folder's snapshot, or waits for
 * the test when `hold` is set; `emit` sends a `changed` event about one folder to every listener.
 */
function folderRpc(byFolder: Record<string, QuotaSnapshot>) {
  const held: Array<() => void> = [];
  const listeners: Array<{ handler: (event: ChangedEvent) => void; signal?: AbortSignal }> = [];
  const rpc = {
    hold: false,
    snapshot: vi.fn((_input: unknown, options: { location?: { directory: string } }) => {
      const answer = { snapshot: byFolder[options.location?.directory ?? ""] as QuotaSnapshot };
      if (!rpc.hold) return Promise.resolve(answer);
      return new Promise<typeof answer>((resolve) => held.push(() => resolve(answer)));
    }),
    refresh: vi.fn(),
    notices: vi.fn(async () => ({ homeLine: "" })),
    events: {
      on: vi.fn(
        (
          _name: string,
          handler: (event: ChangedEvent) => void,
          options?: { signal?: AbortSignal },
        ) => {
          listeners.push({ handler, signal: options?.signal });
          return () => {};
        },
      ),
    },
    release() {
      for (const resolve of held.splice(0)) resolve();
    },
    listening: () => listeners.filter((listener) => !listener.signal?.aborted).length,
    emit(directory: string, snapshot: QuotaSnapshot) {
      for (const listener of listeners) {
        if (!listener.signal?.aborted)
          listener.handler({ location: { directory }, data: { snapshot } });
      }
    },
  };
  return rpc;
}

function snapshotOf(serverId: string, revision: number, percentRemaining: number): QuotaSnapshot {
  const provider = SNAPSHOT.providers[0]!;
  const row = provider.rows[0]!;
  return {
    ...SNAPSHOT,
    serverId,
    revision,
    providers: [{ ...provider, rows: [{ ...row, percentRemaining }] }],
  };
}

const percentOf = (snapshot: QuotaSnapshot | undefined) =>
  snapshot?.providers[0]?.rows[0]?.percentRemaining;

afterEach(() => {
  vi.useRealTimers();
});

describe("GUI quota bridge", () => {
  it("takes the snapshot over the quota RPC, as the TUI does", async () => {
    const rpc = fakeRpc();
    const gui = createGuiQuota({
      client: () => ({ rpc: () => rpc }) as never,
      directory: () => "/p",
    });
    const unwatch = gui.watch("/p");
    await settle();
    expect(gui.snapshot("/p")?.providers[0]?.rows[0]?.percentRemaining).toBe(40);
    expect(rpc.events.on).toHaveBeenCalledWith("changed", expect.any(Function), expect.anything());
    unwatch();
  });

  it("keeps each folder's snapshot apart, so going back to a folder shows its own again", async () => {
    const rpc = folderRpc({
      "/a": snapshotOf("server-a", 1, 10),
      "/b": snapshotOf("server-b", 1, 20),
    });
    const gui = createGuiQuota({
      client: () => ({ rpc: () => rpc }) as never,
      directory: () => "/a",
    });
    let unwatch = gui.watch("/a");
    await settle();
    unwatch();
    unwatch = gui.watch("/b");
    await settle();
    expect(percentOf(gui.snapshot("/b"))).toBe(20);
    unwatch();
    unwatch = gui.watch("/a");
    await settle();
    expect(percentOf(gui.snapshot("/a"))).toBe(10);
    unwatch();
  });

  it("applies only the events about the folder it watches", async () => {
    const rpc = folderRpc({ "/a": snapshotOf("server-a", 1, 10) });
    const gui = createGuiQuota({
      client: () => ({ rpc: () => rpc }) as never,
      directory: () => "/a",
    });
    const unwatch = gui.watch("/a");
    await settle();
    rpc.emit("/b", snapshotOf("server-b", 9, 99));
    expect(percentOf(gui.snapshot("/a"))).toBe(10);
    rpc.emit("/a", snapshotOf("server-a", 2, 30));
    expect(percentOf(gui.snapshot("/a"))).toBe(30);
    unwatch();
  });

  it("drops the answer to a folder's call that arrives after that folder left the screen", async () => {
    const rpc = folderRpc({ "/a": snapshotOf("server-a", 1, 10) });
    const gui = createGuiQuota({
      client: () => ({ rpc: () => rpc }) as never,
      directory: () => "/a",
    });
    rpc.hold = true;
    gui.watch("/a")();
    rpc.release();
    await settle();
    expect(gui.snapshot("/a")).toBeUndefined();
  });

  it("listens again on the new client after the server restarts", async () => {
    vi.useFakeTimers();
    const first = folderRpc({ "/a": snapshotOf("server-1", 1, 10) });
    const second = folderRpc({ "/a": snapshotOf("server-2", 1, 50) });
    let current = { rpc: () => first };
    const gui = createGuiQuota({ client: () => current as never, directory: () => "/a" });
    const unwatch = gui.watch("/a");
    await vi.advanceTimersByTimeAsync(0);
    expect(first.listening()).toBe(1);
    current = { rpc: () => second };
    await vi.advanceTimersByTimeAsync(5_000);
    expect(first.listening()).toBe(0);
    expect(second.listening()).toBe(1);
    expect(percentOf(gui.snapshot("/a"))).toBe(50);
    second.emit("/a", snapshotOf("server-2", 2, 60));
    expect(percentOf(gui.snapshot("/a"))).toBe(60);
    unwatch();
  });

  it("stops polling and listening when nothing watches", async () => {
    vi.useFakeTimers();
    const rpc = folderRpc({ "/a": snapshotOf("server-a", 1, 10) });
    const gui = createGuiQuota({
      client: () => ({ rpc: () => rpc }) as never,
      directory: () => "/a",
    });
    const unwatchFirst = gui.watch("/a");
    const unwatchSecond = gui.watch("/a");
    await vi.advanceTimersByTimeAsync(0);
    unwatchFirst();
    expect(rpc.listening()).toBe(1);
    unwatchSecond();
    unwatchSecond();
    expect(rpc.listening()).toBe(0);
    const calls = rpc.snapshot.mock.calls.length;
    await vi.advanceTimersByTimeAsync(180_000);
    expect(rpc.snapshot.mock.calls.length).toBe(calls);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("forgets a folder nothing watches, and asks the server afresh when it is watched again", async () => {
    const rpc = folderRpc({ "/a": snapshotOf("server-a", 1, 10) });
    const gui = createGuiQuota({
      client: () => ({ rpc: () => rpc }) as never,
      directory: () => "/a",
    });
    let unwatch = gui.watch("/a");
    await settle();
    expect(percentOf(gui.snapshot("/a"))).toBe(10);
    unwatch();
    expect(gui.snapshot("/a")).toBeUndefined();
    const calls = rpc.snapshot.mock.calls.length;
    unwatch = gui.watch("/a");
    await settle();
    expect(rpc.snapshot.mock.calls.length).toBeGreaterThan(calls);
    expect(percentOf(gui.snapshot("/a"))).toBe(10);
    unwatch();
  });

  it("says a later call failed while it still shows the earlier snapshot", async () => {
    vi.useFakeTimers();
    const rpc = fakeRpc();
    const gui = createGuiQuota({
      client: () => ({ rpc: () => rpc }) as never,
      directory: () => "/p",
    });
    const unwatch = gui.watch("/p");
    await vi.advanceTimersByTimeAsync(0);
    expect(percentOf(gui.snapshot("/p"))).toBe(40);
    rpc.snapshot.mockRejectedValue({ type: "rpc.unavailable", message: "no such RPC" });
    rpc.refresh.mockRejectedValue({ type: "rpc.unavailable", message: "no such RPC" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(percentOf(gui.snapshot("/p"))).toBe(40);
    expect(gui.failure("/p")).toEqual({ kind: "unavailable" });
    unwatch();
  });

  it("says the server has no quota RPC, instead of loading forever", async () => {
    const rpc = fakeRpc();
    rpc.snapshot.mockRejectedValue({ type: "rpc.unavailable", message: "no such RPC" });
    const gui = createGuiQuota({
      client: () => ({ rpc: () => rpc }) as never,
      directory: () => "/p",
    });
    const unwatch = gui.watch("/p");
    await settle();
    expect(gui.snapshot("/p")).toBeUndefined();
    expect(gui.failure("/p")).toEqual({ kind: "unavailable" });
    unwatch();
  });

  it("says why a call failed, and forgets it once a snapshot arrives", async () => {
    const rpc = fakeRpc();
    rpc.snapshot.mockRejectedValueOnce(new Error("server unreachable"));
    const gui = createGuiQuota({
      client: () => ({ rpc: () => rpc }) as never,
      directory: () => "/p",
    });
    let unwatch = gui.watch("/p");
    await settle();
    expect(gui.failure("/p")).toEqual({ kind: "error", message: "server unreachable" });
    unwatch();
    unwatch = gui.watch("/p");
    await settle();
    expect(gui.failure("/p")).toBeUndefined();
    expect(percentOf(gui.snapshot("/p"))).toBe(40);
    unwatch();
  });

  it("says why when the client offers no quota RPC at all", async () => {
    const gui = createGuiQuota({
      client: () =>
        ({
          rpc: () => {
            throw new Error("rpc is not supported");
          },
        }) as never,
      directory: () => undefined,
    });
    const unwatch = gui.watch(undefined);
    await settle();
    expect(gui.failure(undefined)).toEqual({ kind: "error", message: "rpc is not supported" });
    unwatch();
  });

  it("names the folder of the session on screen, and none without one", async () => {
    const rpc = fakeRpc();
    let directory: string | undefined = "/work/project";
    const gui = createGuiQuota({
      client: () => ({ rpc: () => rpc }) as never,
      directory: () => directory,
    });
    await gui.settings();
    directory = undefined;
    await gui.settings();
    const [withSession, onHome] = rpc.settings.mock.calls as unknown as Array<
      [unknown, { location?: unknown; signal: AbortSignal }]
    >;
    expect(withSession[1].location).toEqual({ directory: "/work/project" });
    expect(onHome[1]).not.toHaveProperty("location");
    expect(onHome[1].signal).toBeInstanceOf(AbortSignal);
  });

  it("asks the server's current client at every call (a restarted server has a new one)", async () => {
    const first = fakeRpc();
    const second = fakeRpc();
    let current = first;
    const gui = createGuiQuota({
      client: () => ({ rpc: () => current }) as never,
      directory: () => undefined,
    });
    await gui.usage({ range: "7d" });
    current = second;
    await gui.usage({ range: "30d" });
    expect(first.usage).toHaveBeenCalledTimes(1);
    expect(second.usage.mock.calls[0]?.[0]).toEqual({ range: "30d" });
  });

  it("answers the usage report and the settings the server sends", async () => {
    const rpc = fakeRpc();
    const gui = createGuiQuota({
      client: () => ({ rpc: () => rpc }) as never,
      directory: () => "/p",
    });
    expect(await gui.usage({ range: "7d" })).toEqual({ range: "7d" });
    expect(await gui.settings()).toEqual({ values: {} });
    expect(rpc.settings.mock.calls[0]?.[0]).toEqual({});
  });
});
