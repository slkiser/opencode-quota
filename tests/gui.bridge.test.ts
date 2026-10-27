import { describe, expect, it, vi } from "vite-plus/test";
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

describe("GUI quota bridge", () => {
  it("takes the snapshot over the quota RPC, as the TUI does", async () => {
    const rpc = fakeRpc();
    const gui = createGuiQuota({
      client: () => ({ rpc: () => rpc }) as never,
      directory: () => "/p",
    });
    const stop = gui.quota.start();
    const unwatch = gui.quota.watch();
    await settle();
    expect(gui.quota.snapshot()?.providers[0]?.rows[0]?.percentRemaining).toBe(40);
    expect(rpc.events.on).toHaveBeenCalledWith("changed", expect.any(Function), expect.anything());
    unwatch();
    stop();
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
