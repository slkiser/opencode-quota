/**
 * Quota toasts in the GUI window, through `ctx.toast.show`. When to toast, and what, is the
 * TUI's (`../tui/toasts.ts`, `../tui/turn-events.ts`): after a reply, a compaction or an
 * answered question as `toast.*` asks, once when every provider fails, and for limit resets;
 * never for a subagent's session. Each step also asks the server for a refresh it skips when
 * not due, as the TUI does.
 *
 * As each TUI toasts for the turns it hears, each window toasts only for the sessions of its
 * own tabs, and announces only the resets it sees after it started, each once. A reset notice
 * also sends a system notification while no app window has focus; its id is the notice's, so
 * of several windows only the first sends it.
 *
 * The toast's text is the TUI's toast text (`toast.layout`, `layout.bar` and the other words),
 * so it reads the same in both; the window's own words (the titles) come from the catalog.
 */
import type { Context } from "@opencode/plugin/gui";
import { createEffect, onCleanup } from "solid-js";
import type { QuotaSnapshot } from "../core/types.js";
import { reportFailure } from "../tui/client.js";
import {
  createToasts,
  resetMessage,
  type ToastOptions,
  type Toasts,
  wantsResetNotice,
} from "../tui/toasts.js";
import { listenForTurns } from "../tui/turn-events.js";
import type { GuiQuota } from "./bridge.js";
import { surfaceSettings } from "./surface-settings.js";

/** Columns of a toast as wide as the TUI's widest (`toastRoom`: 51 columns of text). */
const TOAST_COLUMNS = 200;

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
  /** Every snapshot the bridge takes: its new reset notices. */
  receive(snapshot: QuotaSnapshot): void;
};

export function createGuiToasts(ctx: Context, data: GuiQuota): GuiToasts {
  const startedAtMs = Date.now();
  /** The folder each session's last turn event named. */
  const folders = new Map<string, string | undefined>();
  /** Reset notices this window has looked at for a system notification. */
  const notified = new Set<string>();
  /** The snapshot the toasts take their settings from: the latest any folder sent. */
  let latest: QuotaSnapshot | undefined;

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
    show(toast) {
      ctx.toast?.show({
        // Reset notices are the only quota toasts with a title, and the only "success" ones.
        title: ctx.t(toast.variant === "success" ? "toast.resetTitle" : "toast.title"),
        description: toast.message,
        variant: VARIANTS[toast.variant],
        duration: toast.duration,
      });
      return undefined;
    },
    display: () => surfaceSettings(latest),
    terminalWidth: () => TOAST_COLUMNS,
    quota: {
      snapshot: (sessionID) => data.snapshot(sessionID && folders.get(sessionID), sessionID),
      async refresh(reason, sessionID) {
        const directory = sessionID ? folders.get(sessionID) : undefined;
        // The folder may have no surface on screen; it runs while this refresh waits.
        const stop = data.watch(directory, sessionID);
        try {
          await data.refresh(directory, sessionID, reason);
          return data.failure(directory) ? undefined : data.snapshot(directory, sessionID);
        } finally {
          stop();
        }
      },
    },
    isChildSession,
  });

  /** A system notification for each reset notice the toasts will show, while no window has focus. */
  function notifyResets(snapshot: QuotaSnapshot): void {
    const settings = surfaceSettings(snapshot);
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
            const stopWatch = data.watch(directory, sessionID);
            void data.refresh(directory, sessionID, "turn").finally(stopWatch);
          },
        },
      );
    } catch (error) {
      reportFailure(error);
      return;
    }
    onCleanup(() => {
      stop();
      toasts.cancel();
    });
  });

  return {
    receive(snapshot) {
      latest = snapshot;
      notifyResets(snapshot);
      toasts.showResetNotices(snapshot);
    },
  };
}
