import { createEffect, createMemo, createRoot, createSignal, onCleanup } from "solid-js";
import { describe, expect, it, vi } from "vite-plus/test";
import type { QuotaSnapshot } from "../src/core/types.js";
import { createGuiQuota } from "../src/gui/bridge.js";

// The app's Solid: the browser build, whose effects and memos run again (the node build's never do).
vi.mock("solid-js", () => import("solid-js/dist/solid.js"));

const SNAPSHOT: QuotaSnapshot = {
  version: 6,
  providers: [],
  resetNotices: [],
  generatedAtMs: Date.parse("2026-10-27T12:00:00.000Z"),
  serverId: "server-1",
  revision: 1,
};

/** The quota RPC: each session's snapshot carries tokens with its number as `input`. */
function sessionRpc() {
  return {
    snapshot: vi.fn(async (input: { sessionID?: string }) => ({
      snapshot: {
        ...SNAPSHOT,
        ...(input.sessionID
          ? {
              sessionTokens: { input: Number(input.sessionID.slice(1)), cachedInput: 0, output: 0 },
            }
          : {}),
      },
    })),
    refresh: vi.fn(),
    notices: vi.fn(async () => ({ homeLine: "" })),
    events: { on: vi.fn(() => () => {}) },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("GUI quota bridge, read by Solid surfaces", () => {
  it("shows the new session's tokens after a move to another session of the same folder", async () => {
    const rpc = sessionRpc();
    const gui = createGuiQuota({
      client: () => ({ rpc: () => rpc }) as never,
      directory: () => "/a",
    });
    const [session, setSession] = createSignal("s1");
    const { tokens, dispose } = createRoot((dispose) => {
      // As a surface does: one watch of the session on screen, and a read of its snapshot.
      createEffect(() => {
        onCleanup(gui.watch("/a", session()));
      });
      const tokens = createMemo(() => gui.snapshot("/a", session())?.sessionTokens?.input);
      return { tokens, dispose };
    });
    await settle();
    expect(tokens()).toBe(1);

    setSession("s2");
    await settle();
    expect(rpc.snapshot).toHaveBeenLastCalledWith({ sessionID: "s2" }, expect.anything());
    expect(tokens()).toBe(2);
    dispose();
  });

  it("shows a folder that was forgotten once it is watched again", async () => {
    const rpc = sessionRpc();
    const gui = createGuiQuota({
      client: () => ({ rpc: () => rpc }) as never,
      directory: () => "/a",
    });
    const [watching, setWatching] = createSignal(true);
    const { tokens, dispose } = createRoot((dispose) => {
      createEffect(() => {
        if (watching()) onCleanup(gui.watch("/a", "s1"));
      });
      const tokens = createMemo(() => gui.snapshot("/a", "s1")?.sessionTokens?.input);
      return { tokens, dispose };
    });
    await settle();
    expect(tokens()).toBe(1);

    setWatching(false);
    await settle();
    expect(tokens()).toBeUndefined();
    setWatching(true);
    await settle();
    expect(tokens()).toBe(1);
    dispose();
  });
});
