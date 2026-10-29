import type { Context } from "@opencode/plugin/gui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ProviderSnapshot, QuotaSnapshot, ResetNotice } from "../src/core/types.js";
import type { GuiQuota } from "../src/gui/bridge.js";
import { surfaceSettings } from "../src/gui/surface-settings.js";
import type { PanelView, RowSettings } from "../src/gui/surfaces-model.js";
import { createGuiToasts, type DrawRows } from "../src/gui/toasts.js";
import {
  FakeElement,
  type FakePage,
  installFakePage,
  removeFakePage,
} from "./helpers/fake-page.js";

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
  drawRows?: DrawRows,
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
  const toasts = createGuiToasts(ctx, data, settingsOf, drawRows);
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

  describe("on a page", () => {
    let page: FakePage;
    beforeEach(() => {
      page = installFakePage();
    });
    afterEach(() => {
      removeFakePage();
    });

    /** An app toast as OpenCode draws one: its title and description in its content. */
    function appToast(description: string) {
      const toast = new FakeElement("li", { name: "toast", attributes: { class: "toast-v2" } });
      const content = new FakeElement("div", {
        name: "content",
        attributes: { "data-content": "" },
      });
      const title = new FakeElement("div", { name: "title", attributes: { "data-title": "" } });
      const text = new FakeElement("div", {
        name: "description",
        attributes: { "data-description": "" },
      });
      text.text = description;
      toast.append(content.append(title, text));
      return { toast, content, text };
    }

    /** Draws each toast's rows as an element the test can find, with a cleanup it can count. */
    function drawer() {
      const drawn: Array<{
        view: PanelView;
        settings: RowSettings;
        element: FakeElement;
        dispose: ReturnType<typeof vi.fn>;
      }> = [];
      const draw = vi.fn((view: PanelView, settings: RowSettings) => {
        const element = new FakeElement("div", { name: "rows" });
        const dispose = vi.fn();
        drawn.push({ view, settings, element, dispose });
        return { element: element as unknown as Element, dispose };
      });
      return { draw: draw as unknown as DrawRows, drawn };
    }

    const both = () =>
      snapshot([provider("claude", "Claude", 80), provider("copilot", "Copilot", 40)], REPLY_TOAST);

    /** A turn's toast in session "a", which OpenCode draws on the page when `onPage`. */
    async function turnToast(onPage = true) {
      const rows = drawer();
      const shown = both();
      const app = start({ "/a": shown }, undefined, rows.draw);
      const toasts: Array<ReturnType<typeof appToast>> = [];
      app.show.mockImplementation((toast: { description: string }) => {
        if (!onPage) return;
        const drawn = appToast(toast.description);
        toasts.push(drawn);
        page.document.body.append(drawn.toast);
      });
      app.emit("session.execution.succeeded", "a");
      await app.answer();
      return { app, rows, toasts, shown };
    }

    it("draws the panel's rows after our toast's text and hides the text", async () => {
      const { app, rows, toasts, shown } = await turnToast();
      page.frames(1);

      expect(rows.drawn).toHaveLength(1);
      const [drawn] = rows.drawn;
      expect(drawn?.view.groups.map((group) => group.name)).toEqual(["Claude", "Copilot"]);
      expect(drawn?.view.groups[0]?.rows[0]).toMatchObject({
        name: "7d",
        percent: 80,
        value: "80% left",
        reset: expect.stringMatching(/\S/),
      });
      expect(drawn?.settings.colors).toEqual(surfaceSettings(shown).colors);
      const [toast] = toasts;
      expect(toast?.content.children).toEqual([
        toast?.content.children[0],
        toast?.text,
        drawn?.element,
      ]);
      expect(toast?.text.hasAttribute("data-oq-rows")).toBe(true);
      // The text stays for assistive tech, and as the description OpenCode keeps.
      expect(toast?.text.textContent).toBe(app.show.mock.calls[0]?.[0].description);
      expect(page.pendingFrames()).toBe(0);
    });

    it("keeps the sentences when the toast isn't found on the page", async () => {
      const { app, rows } = await turnToast(false);
      page.frames(60);

      expect(rows.drawn).toHaveLength(0);
      expect(page.pendingFrames()).toBe(0);
      expect(String(app.show.mock.calls[0]?.[0].description)).toMatch(/^Claude: .*\nCopilot: /);
    });

    it("leaves another toast alone", async () => {
      const other = appToast("Saved\nall settings");
      page.document.body.append(other.toast);
      const { rows, toasts } = await turnToast();
      page.frames(1);

      expect(rows.drawn).toHaveLength(1);
      expect(toasts[0]?.content.children).toContain(rows.drawn[0]?.element);
      expect(other.content.children).toEqual([other.content.children[0], other.text]);
      expect([...other.text.attributes.keys()]).toEqual(["data-description"]);
    });

    it("takes the rows out once the toast leaves the page", async () => {
      const { rows, toasts } = await turnToast();
      page.frames(1);
      expect(page.observing()).toBe(1);

      toasts[0]?.toast.remove();
      page.flushMutations();

      expect(rows.drawn[0]?.dispose).toHaveBeenCalledTimes(1);
      expect(rows.drawn[0]?.element.isConnected).toBe(false);
      expect(page.observing()).toBe(0);
    });

    it("takes the rows out and shows the text again when the plugin goes away", async () => {
      const { app, rows, toasts } = await turnToast();
      page.frames(1);

      app.dispose();

      expect(rows.drawn[0]?.dispose).toHaveBeenCalledTimes(1);
      expect(toasts[0]?.content.children).toEqual([
        toasts[0]?.content.children[0],
        toasts[0]?.text,
      ]);
      expect(toasts[0]?.text.hasAttribute("data-oq-rows")).toBe(false);
      expect(page.observing()).toBe(0);
    });

    it("keeps a toast without a snapshot as text, with its line breaks", () => {
      const notices: ResetNotice[] = ["claude", "copilot"].map((providerId) => ({
        id: `${providerId}-weekly`,
        rowId: `${providerId}.weekly`,
        providerId,
        label: "Weekly",
        window: "week",
        percentRemaining: 100,
        atMs: Date.now() + 60_000,
      }));
      const shown = snapshot(
        [provider("claude", "Claude", 100), provider("copilot", "Copilot", 100)],
        { "toast.resetNotice": "all" },
      );
      const rows = drawer();
      const app = start({ "/a": shown }, undefined, rows.draw);
      let text: FakeElement | undefined;
      app.show.mockImplementation((toast: { description: string }) => {
        const drawn = appToast(toast.description);
        text = drawn.text;
        page.document.body.append(drawn.toast);
      });
      app.toasts.receive({ ...shown, resetNotices: notices }, "/a");
      page.frames(1);

      expect(app.show).toHaveBeenCalledTimes(1);
      expect(rows.drawn).toHaveLength(0);
      expect(text?.hasAttribute("data-oq-lines")).toBe(true);
      expect(text?.hasAttribute("data-oq-rows")).toBe(false);
    });
  });
});
