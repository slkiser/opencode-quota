/**
 * Quota toasts in the GUI window, through `ctx.toast.show`. When to toast, and what, is the
 * TUI's (`../tui/toasts.ts`, `../tui/turn-events.ts`): after a reply, a compaction or an
 * answered question as `toast.*` asks, once per folder when every provider fails, and for limit resets;
 * never for a subagent's session. Each step also asks the server for a refresh it skips when
 * not due, as the TUI does.
 *
 * As each TUI toasts for the turns it hears, each window toasts only for the sessions of its
 * own tabs, and announces only the resets it sees after it started, each once. A turn's toast
 * follows the settings of its session's folder, and a reset notice the settings its folder has
 * when it shows. A reset notice also sends a system notification
 * while no app window has focus; its id is the notice's, so of several windows only the first
 * sends it.
 *
 * A quota toast's text is the TUI toast's rows and words as a sentence per provider
 * (`toastSentences`), each on its own line: what assistive tech reads. The toast is found on
 * screen by that text (an app toast's description, `.toast-v2 [data-description]`, with exactly
 * that text as the app cuts it, and no rows yet) within 60 frames. Then the text is hidden from sight and the open
 * Quota panel's rows for the toast's providers show under the title instead (`toast-rows.tsx`),
 * in the panel's columns and colors; they are taken out, their Solid root ended, once the toast
 * or its text leaves the page, or the plugin goes away. The app measures a toast before its rows
 * are drawn, so the window's CSS lets a toast with rows take its own height when the stack expands;
 * the toasts above it still sit where the measured height puts them. A toast not found keeps its text. The
 * text of a toast without rows (a reset notice) keeps its line breaks (`data-oq-lines`), which
 * the app would collapse. The window's own words (the titles) come from the catalog.
 *
 * When the window's server restarts or the plugin goes away, the refreshes still waiting stop
 * keeping their folders loaded and their answers are dropped; once the plugin is gone it shows
 * no more toasts.
 */
import type { Context } from "@opencode/plugin/gui";
import { createEffect, onCleanup } from "solid-js";
import type { QuotaSnapshot } from "../core/types.js";
import type { Settings } from "../settings/schema.js";
import { reportFailure } from "../tui/client.js";
import {
  createToasts,
  resetMessage,
  type ToastOptions,
  type Toasts,
  wantsResetNotice,
} from "../tui/toasts.js";
import { listenForTurns } from "../tui/turn-events.js";
import { toastSentences } from "../view/text.js";
import type { GuiQuota } from "./bridge.js";
import { surfaceSettings } from "./surface-settings.js";
import { type PanelView, type RowSettings, toastView } from "./surfaces-model.js";
import { type DrawnRows, drawToastRows } from "./toast-rows.js";

/** Columns of a toast as wide as the TUI's widest (`toastRoom`: 51 columns of text). */
const TOAST_COLUMNS = 200;

/** Frames to look for a toast's text on screen: a second at 60 Hz, half that at 120 Hz. */
const MARK_FRAMES = 60;

/** The most characters of a description the app keeps; it cuts the rest and adds "…". */
const DESCRIPTION_LIMIT = 2000;

/** On a toast's description: the window's CSS keeps its line breaks. */
const LINES_ATTR = "data-oq-lines";
/** On a toast's description: our rows stand in for it, so the window's CSS hides it from sight. */
const ROWS_ATTR = "data-oq-rows";

/** Draws a quota toast's rows (`drawToastRows`). */
export type DrawRows = (view: PanelView, settings: RowSettings) => DrawnRows;

/** Rows drawn in a toast on screen, after the description they stand in for. */
type PlacedRows = { description: Element; rows: DrawnRows };

const VARIANTS: Record<ToastOptions["variant"], "default" | "success" | "error"> = {
  info: "default",
  success: "success",
  warning: "default",
  error: "error",
};

type ServerData = {
  on: (type: string, handler: (event: unknown) => void) => () => void;
  session: { get: (sessionID: string) => { parentID?: string } | undefined };
};

export type GuiToasts = {
  /** Every snapshot the bridge takes, with its folder: its new reset notices. */
  receive(snapshot: QuotaSnapshot, directory: string | undefined): void;
};

/**
 * `settingsOf`: the toast settings of a snapshot (the Settings page's unsaved changes on top while
 * it is open); `surfaceSettings` without one.
 */
export function createGuiToasts(
  ctx: Context,
  data: GuiQuota,
  settingsOf: (snapshot: QuotaSnapshot | undefined) => Settings = surfaceSettings,
  drawRows: DrawRows = (view, settings) => drawToastRows(ctx, view, settings),
): GuiToasts {
  const startedAtMs = Date.now();
  /** The folder each session's last turn event named. */
  const folders = new Map<string, string | undefined>();
  /** Reset notices this window has looked at for a system notification. */
  const notified = new Set<string>();
  /** The settings of a toast that shows no snapshot of its own: the latest any folder sent. */
  let latest: QuotaSnapshot | undefined;
  /** The folder of each snapshot received: a waiting reset notice follows its folder's latest. */
  const folderOf = new WeakMap<QuotaSnapshot, { directory: string | undefined }>();
  const newest = (snapshot: QuotaSnapshot): QuotaSnapshot => {
    const folder = folderOf.get(snapshot);
    return (folder && data.snapshot(folder.directory)) || snapshot;
  };
  let disposed = false;
  /** The watches that keep a folder loaded while a refresh waits. */
  const holds = new Set<() => void>();
  /** Counts the cleanups; a refresh that started before one drops its answer. */
  let generation = 0;

  /** Keeps the folder loaded, though it may have no surface on screen, until the release. */
  const hold = (directory: string | undefined, sessionID: string | undefined) => {
    const stop = data.watch(directory, sessionID);
    const release = () => {
      if (holds.delete(release)) stop();
    };
    holds.add(release);
    return release;
  };
  const releaseHolds = () => {
    generation += 1;
    for (const release of holds) release();
  };

  /** The rows in toasts on screen, and the watch that takes them out once their toast goes. */
  const placed = new Set<PlacedRows>();
  let watching: MutationObserver | undefined;

  const takeOut = (entry: PlacedRows) => {
    placed.delete(entry);
    entry.rows.dispose();
    entry.rows.element.remove();
    entry.description.removeAttribute(ROWS_ATTR);
  };
  /** Takes out the rows whose toast, or its text, left the page; stops watching after the last. */
  const sweep = () => {
    for (const entry of placed) {
      if (!entry.description.isConnected || !entry.rows.element.isConnected) takeOut(entry);
    }
    if (placed.size > 0) return;
    watching?.disconnect();
    watching = undefined;
  };
  const takeOutAll = () => {
    for (const entry of placed) takeOut(entry);
    sweep();
  };

  /**
   * Hands `found` the description of our toast once it is on screen: the app toast's
   * description with exactly `text`, as the app cuts it, and no rows of ours. Looks for
   * MARK_FRAMES frames.
   */
  const findDescription = (text: string, found: (description: Element) => void) => {
    if (!text || typeof document === "undefined") return;
    const shown = text.length > DESCRIPTION_LIMIT ? `${text.slice(0, DESCRIPTION_LIMIT)}…` : text;
    let frames = 0;
    const find = () => {
      if (disposed) return;
      for (const node of document.querySelectorAll(".toast-v2 [data-description]")) {
        if (node.textContent === shown && !node.hasAttribute(ROWS_ATTR)) return found(node);
      }
      frames += 1;
      if (frames < MARK_FRAMES) requestAnimationFrame(find);
    };
    requestAnimationFrame(find);
  };

  /** Draws the rows after `description`, which the window's CSS then hides from sight. */
  const placeRows = (description: Element, view: PanelView, settings: RowSettings) => {
    let rows: DrawnRows;
    try {
      rows = drawRows(view, settings);
    } catch (error) {
      reportFailure(error);
      return;
    }
    description.after(rows.element);
    description.setAttribute(ROWS_ATTR, "");
    placed.add({ description, rows });
    if (watching) return;
    watching = new MutationObserver(sweep);
    watching.observe(document.body, { childList: true, subtree: true });
  };

  const builtin = () => {
    const servers = ctx.servers;
    if (!servers) return undefined;
    return servers
      .list()
      .map((id) => servers.get(id))
      .find((server) => server?.builtin);
  };
  const serverData = () => builtin()?.data as unknown as ServerData | undefined;
  /** A session of one of this window's tabs, on the app's own server. */
  const inWindow = (sessionID: string) =>
    (ctx.sessions?.list() ?? []).some(
      (session) => session.id === sessionID && session.server.builtin,
    );
  const isChildSession = (sessionID: string) => {
    try {
      return Boolean(serverData()?.session.get(sessionID)?.parentID);
    } catch {
      return false;
    }
  };

  const toasts: Toasts = createToasts({
    show(toast, _lines, input) {
      if (disposed || !ctx.toast) return undefined;
      // Each reset notice is a sentence on its own line, as each provider's row sentence is.
      const description = input ? toastSentences(input).join("\n") : toast.message;
      ctx.toast.show({
        // Reset notices are the only quota toasts with a title, and the only "success" ones.
        title: ctx.t(toast.variant === "success" ? "toast.resetTitle" : "toast.title"),
        description,
        variant: VARIANTS[toast.variant],
        duration: toast.duration,
      });
      if (input) {
        const view = toastView(input);
        const settings = { colors: input.colors, layout: input.layout };
        findDescription(description, (node) => {
          node.setAttribute(LINES_ATTR, "");
          placeRows(node, view, settings);
        });
      } else if (description.includes("\n")) {
        findDescription(description, (node) => node.setAttribute(LINES_ATTR, ""));
      }
      return undefined;
    },
    display: (snapshot) => settingsOf(snapshot ? newest(snapshot) : latest),
    terminalWidth: () => TOAST_COLUMNS,
    quota: {
      snapshot: (sessionID) => data.snapshot(sessionID && folders.get(sessionID), sessionID),
      async refresh(reason, sessionID) {
        const directory = sessionID ? folders.get(sessionID) : undefined;
        const started = generation;
        const release = hold(directory, sessionID);
        try {
          await data.refresh(directory, sessionID, reason);
          if (started !== generation || data.failure(directory)) return undefined;
          return data.snapshot(directory, sessionID);
        } finally {
          release();
        }
      },
    },
    isChildSession,
    // Each folder has its own providers' outage: one folder's alert never hides another's.
    allFailKey: (sessionID) => folders.get(sessionID) ?? "",
  });

  /** A system notification for each reset notice the toasts will show, while no window has focus. */
  function notifyResets(snapshot: QuotaSnapshot): void {
    const settings = settingsOf(snapshot);
    for (const notice of snapshot.resetNotices) {
      if (notified.has(notice.id)) continue;
      notified.add(notice.id);
      if (notice.atMs < startedAtMs || !wantsResetNotice(settings, notice)) continue;
      if (typeof document !== "undefined" && document.hasFocus()) continue;
      const message = resetMessage(notice, snapshot, settings, Date.now());
      if (!message || !ctx.attention) continue;
      void ctx.attention.notify({
        title: ctx.t("toast.resetTitle"),
        message,
        id: `opencode-quota.reset.${notice.id}`,
      });
    }
  }

  // The turn events of the app's own server, again when it restarts with new data.
  createEffect(() => {
    const server = serverData();
    if (!server || typeof server.on !== "function") return;
    const remember = (sessionID: string, event: { location?: { directory?: string } }) => {
      folders.set(sessionID, event.location?.directory);
    };
    let stop: () => void;
    try {
      stop = listenForTurns(
        (type, handler) => server.on(type, handler as (event: unknown) => void),
        {
          afterTurn(trigger, sessionID, event) {
            if (!inWindow(sessionID)) return;
            remember(sessionID, event);
            void toasts.afterTurn(trigger, sessionID).catch(reportFailure);
          },
          stepEnded(sessionID, event) {
            if (!inWindow(sessionID) || isChildSession(sessionID)) return;
            remember(sessionID, event);
            const directory = folders.get(sessionID);
            const release = hold(directory, sessionID);
            void data.refresh(directory, sessionID, "turn").finally(release);
          },
        },
      );
    } catch (error) {
      reportFailure(error);
      return;
    }
    onCleanup(() => {
      stop();
      releaseHolds();
      toasts.cancel();
    });
  });
  onCleanup(() => {
    disposed = true;
    releaseHolds();
    toasts.cancel();
    takeOutAll();
  });

  return {
    receive(snapshot, directory) {
      if (disposed) return;
      latest = snapshot;
      folderOf.set(snapshot, { directory });
      notifyResets(snapshot);
      toasts.showResetNotices(snapshot);
    },
  };
}
