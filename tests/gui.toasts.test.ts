import type { Context } from "@opencode/plugin/gui";
import { describe, expect, it, vi } from "vite-plus/test";
import type { ProviderSnapshot, QuotaSnapshot } from "../src/core/types.js";
import type { GuiQuota } from "../src/gui/bridge.js";
import { createGuiToasts } from "../src/gui/toasts.js";

/**
 * The cleanups the toasts register with Solid; effects run at once (on the server build they
 * never run by themselves).
 */
const cleanups = vi.hoisted(() => [] as Array<() => void>);
vi.mock("solid-js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("solid-js")>()),
  createEffect: (effect: () => void) => effect(),
  onCleanup: (cleanup: () => void) => {
    cleanups.push(cleanup);
  },
}));

const NOW = Date.now();

function provider(providerId: string, label: string, percentRemaining: number): ProviderSnapshot {
  return {
    providerId,
    label,
    rows: [
      {
        id: `${providerId}.weekly`,
        providerId,
        label: "Weekly",
        type: "quota",
        method: "remote_api",
        authority: "provider_reported",
        window: "week",
        prominence: "primary",
        percentRemaining,
        resetsAt: new Date(NOW + 3 * 86_400_000).toISOString(),
      },
    ],
    okAtMs: NOW,
    checkedAtMs: NOW,
    refreshing: false,
  };
}

function snapshot(providers: ProviderSnapshot[], values: Record<string, unknown>): QuotaSnapshot {
  return {
    version: 6,
    providers,
    resetNotices: [],
    generatedAtMs: NOW,
    serverId: "server",
    revision: NOW,
    settings: { values } as unknown as QuotaSnapshot["settings"],
  };
}

const REPLY_TOAST = { "toast.afterReply": "always" };

/**
 * A window with sessions "a" in folder /a and "b" in /b, on the app's own server. Refreshes
 * wait for `answer`; `emit` sends a server event; `dispose` runs the Solid cleanups.
 */
function start(byFolder: Record<string, QuotaSnapshot>) {
  cleanups.length = 0;
  const handlers = new Map<string, (event: unknown) => void>();
  const server = {
    builtin: true,
    data: {
      on(type: string, handler: (event: unknown) => void) {
        handlers.set(type, handler);
        return () => handlers.delete(type);
      },
      session: { get: () => ({}) },
    },
  };
  const show = vi.fn();
  const ctx = {
    servers: { list: () => ["server"], get: () => server },
    sessions: {
      list: () => [
        { id: "a", server: { builtin: true } },
        { id: "b", server: { builtin: true } },
      ],
    },
    toast: { show },
    t: (key: string) => key,
  } as unknown as Context;
  const waiting: Array<() => void> = [];
  const stops: Array<ReturnType<typeof vi.fn>> = [];
  const data = {
    snapshot: (directory: string | undefined) => byFolder[directory ?? ""],
    watch: vi.fn(() => {
      const stop = vi.fn();
      stops.push(stop);
      return stop;
    }),
    refresh: vi.fn(() => new Promise<void>((resolve) => waiting.push(resolve))),
    failure: () => undefined,
  } as unknown as GuiQuota;
  const toasts = createGuiToasts(ctx, data);
  return {
    toasts,
    show,
    stops,
    emit(type: string, sessionID: string) {
      handlers.get(type)?.({ location: { directory: `/${sessionID}` }, data: { sessionID } });
    },
    async answer() {
      for (const resolve of waiting.splice(0)) resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    dispose() {
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
  };
}

describe("GUI quota toasts", () => {
  it("follows the settings of each turn's own folder", async () => {
    const quiet = snapshot([provider("claude", "Claude", 80)], {
      ...REPLY_TOAST,
      "toast.show": false,
    });
    const loud = snapshot([provider("copilot", "Copilot", 40)], REPLY_TOAST);
    const app = start({ "/a": quiet, "/b": loud });
    // The latest snapshot any folder sent is /b's, which toasts.
    app.toasts.receive(loud);

    app.emit("session.execution.succeeded", "a");
    app.emit("session.execution.succeeded", "b");
    await app.answer();

    expect(app.show).toHaveBeenCalledTimes(1);
    expect(app.show.mock.calls[0]?.[0].description).toMatch(/^Copilot: /);
  });

  it("shows a sentence per provider, without the TUI's columns", async () => {
    const both = snapshot(
      [provider("claude", "Claude", 80), provider("copilot", "Copilot", 40)],
      REPLY_TOAST,
    );
    const app = start({ "/a": both });

    app.emit("session.execution.succeeded", "a");
    await app.answer();

    const lines = String(app.show.mock.calls[0]?.[0].description).split("\n");
    expect(lines).toEqual([
      expect.stringMatching(/^Claude: 7d 80% left \S+\.$/),
      expect.stringMatching(/^Copilot: 7d 40% left \S+\.$/),
    ]);
    for (const line of lines) expect(line).not.toMatch(/ {2}|[█░▓▒■□━─]/u);
  });

  it("releases the refreshes' watches on cleanup and drops their late answers", async () => {
    const app = start({ "/a": snapshot([provider("claude", "Claude", 80)], REPLY_TOAST) });

    app.emit("session.execution.succeeded", "a");
    app.emit("session.step.ended", "a");
    expect(app.stops).toHaveLength(2);
    app.dispose();

    for (const stop of app.stops) expect(stop).toHaveBeenCalledTimes(1);
    await app.answer();
    expect(app.show).not.toHaveBeenCalled();
    for (const stop of app.stops) expect(stop).toHaveBeenCalledTimes(1);
  });
});
