import { describe, expect, it, vi } from "vite-plus/test";
import type { QuotaSnapshot } from "../src/core/types.js";
import { createQuotaClient } from "../src/tui/client.js";

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
function fakeRpc() {
  const waiting: Array<(snapshot: QuotaSnapshot) => void> = [];
  const call = () =>
    new Promise<{ snapshot: QuotaSnapshot }>((resolve) =>
      waiting.push((answer) => resolve({ snapshot: answer })),
    );
  let changed: (snapshot: QuotaSnapshot) => void = () => {};
  const rpc = {
    snapshot: vi.fn(call),
    refresh: vi.fn(call),
    notices: vi.fn(async () => ({ homeLine: "" })),
    command: vi.fn(),
    events: {
      on: vi.fn(
        (_name: string, handler: (event: { data: { snapshot: QuotaSnapshot } }) => void) => {
          changed = (answer) => handler({ data: { snapshot: answer } });
          return () => {};
        },
      ),
    },
  };
  const client = createQuotaClient({
    location: { directory: process.cwd() },
    data: {},
    client: { rpc: () => rpc },
  });
  return {
    client,
    rpc,
    answer: (index: number, answer: QuotaSnapshot) => waiting[index]?.(answer),
    changed: (answer: QuotaSnapshot) => changed(answer),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("TUI quota client", () => {
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
});
