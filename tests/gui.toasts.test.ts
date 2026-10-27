import type { Context } from "@opencode/plugin/gui";
import { describe, expect, it, vi } from "vite-plus/test";
import type { ProviderSnapshot, QuotaSnapshot, ResetNotice } from "../src/core/types.js";
import type { GuiQuota } from "../src/gui/bridge.js";
import { surfaceSettings } from "../src/gui/surface-settings.js";
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
function start(
  byFolder: Record<string, QuotaSnapshot>,
  settingsOf: (snapshot: QuotaSnapshot | undefined) => ReturnType<typeof surfaceSettings> = (
    snapshot,
  ) => surfaceSettings(snapshot),
) {
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
  const toasts = createGuiToasts(ctx, data, settingsOf);
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
    app.toasts.receive(loud, "/b");

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

  describe("a reset notice that comes while a turn's toast is made", () => {
    const notice: ResetNotice = {
      id: "claude-weekly",
      rowId: "claude.weekly",
      providerId: "claude",
      label: "Weekly",
      window: "week",
      percentRemaining: 100,
      // After the window started.
      atMs: Date.now() + 60_000,
    };
    /** A turn waiting for its refresh, with a reset notice the page's unsaved changes ask for. */
    function waiting(saved: Record<string, unknown>) {
      let preview: Record<string, unknown> | undefined = {
        "toast.resetNotice": "all",
        "toast.names": { "claude.weekly": "Unsaved" },
      };
      const quiet = snapshot([provider("claude", "Claude", 100)], saved);
      const app = start({ "/a": quiet }, (shown) => surfaceSettings(shown, preview));
      app.emit("session.execution.succeeded", "a");
      app.toasts.receive({ ...quiet, resetNotices: [notice] }, "/a");
      // The page discards its changes and closes before the turn's toast is made.
      preview = undefined;
      return app;
    }

    it("follows the saved names once it shows", async () => {
      const app = waiting({ "toast.resetNotice": "all" });
      await app.answer();
      const descriptions = app.show.mock.calls.map(([toast]) => String(toast.description));
      expect(descriptions).toEqual([expect.stringContaining("Claude Weekly is available again")]);
      expect(descriptions.join("\n")).not.toContain("Unsaved");
    });

    it("does not show when the saved settings turn reset notices off", async () => {
      const app = waiting({ "toast.resetNotice": "off" });
      await app.answer();
      expect(app.show).not.toHaveBeenCalled();
    });

    it("does not show when a newer snapshot of its folder turns reset notices off", async () => {
      const on = snapshot([provider("claude", "Claude", 100)], { "toast.resetNotice": "all" });
      const byFolder = { "/a": on };
      const app = start(byFolder);
      app.emit("session.execution.succeeded", "a");
      app.toasts.receive({ ...on, resetNotices: [notice] }, "/a");
      const off = snapshot([provider("claude", "Claude", 100)], { "toast.resetNotice": "off" });
      byFolder["/a"] = off;
      app.toasts.receive(off, "/a");

      await app.answer();
      expect(app.show).not.toHaveBeenCalled();
    });
  });

  describe("the alert when every provider fails", () => {
    const failing = () =>
      snapshot([{ ...provider("claude", "Claude", 0), rows: [], error: { code: "timeout" } }], {});
    const healthy = () => snapshot([provider("copilot", "Copilot", 80)], {});
    const turn = async (app: ReturnType<typeof start>, sessionID: string) => {
      app.emit("session.execution.succeeded", sessionID);
      await app.answer();
    };
    const errors = (app: ReturnType<typeof start>) =>
      app.show.mock.calls.filter(([toast]) => toast.variant === "error").length;

    it("shows for each folder's outage, though another folder's already showed", async () => {
      const app = start({ "/a": failing(), "/b": failing() });
      await turn(app, "a");
      await turn(app, "b");
      expect(errors(app)).toBe(2);
    });

    it("does not show again for an unchanged outage after another folder's providers answer", async () => {
      const app = start({ "/a": failing(), "/b": healthy() });
      await turn(app, "a");
      await turn(app, "b");
      await turn(app, "a");
      expect(errors(app)).toBe(1);
    });
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
