/**
 * Quota toasts (§4.4). OpenCode shows one toast at a time, so quota takes a turn only when
 * the display settings say so: after compaction and when every provider fails by default;
 * after each reply, after a question, and on a limit reset only when turned on. A quota toast
 * shows its rows in the grouped or detailed layout (`toast.layout`), with bars in the sidebar's
 * bar shape; the host colors them where OpenCode can draw that (`toast-colors.tsx`). It has no
 * title: its rows say what it is. Every quota toast is made here, the Toast page's preview too.
 *
 * The Toast page's preview stays open while the page shows, until another toast replaces it. The
 * plugin API can only show a toast, for a duration; quota tells whether its toast is still on
 * screen from the toast's colored spans (`toast-colors.tsx`). The preview first shows like any
 * quota toast; while a copy of it is on screen, a new copy that lasts 3 s replaces it every
 * second. Leaving the page stops that and closes the preview: a copy that lasts 1 ms replaces it,
 * unless another toast already did. Without the spans the preview shows for `toast.seconds`, as
 * other quota toasts do.
 *
 * Once another toast replaces the preview, or a copy runs out before the next one comes (the TUI
 * stalled for over 2 s), the preview does not come back by itself: quota can't tell a copy that
 * is gone from one OpenCode holds back, and a new copy would cut the other toast short. A change
 * on the page, or Show toast, shows it again.
 *
 * While the mouse is on a toast, OpenCode pauses it and holds back the toasts shown meanwhile,
 * the closing copy too. Quota then adds no copy, a change on the page included, until its
 * held-back one shows. OpenCode shows each held-back toast in turn for its whole duration, and
 * the plugin API can't take one back. So once the mouse moves away, a closed preview ends within
 * about 6 s: the paused copy's rest, then the held-back copy. A copy held back behind another
 * toast, such as a reset notice that came while the mouse was on the preview, brings the preview
 * back after that toast; it shows then even when the page closed meanwhile, for 3 s, or for
 * `toast.seconds` when it is the preview's first toast.
 *
 * Reset notices that arrive together show as one toast. While a turn's toast is being made,
 * they wait and show after it, so the turn's toast does not replace them at once; each follows
 * the settings as they are when it shows. When the TUI leaves its server, waiting notices are
 * dropped unshown, so a later snapshot can bring them.
 */
import type { QuotaSnapshot, ResetNotice } from "../core/types.js";
import { WINDOWS } from "../core/windows.js";
import { levelOf } from "../view/format.js";
import { rowFacts } from "../view/row-facts.js";
import { visibleRow } from "../view/select.js";
import { type Line, lineText, type ToastInput, toastInput, toastLines } from "../view/text.js";
import type { QuotaClient } from "./client.js";
import type { DisplaySettings } from "./display.js";
import type { DrawnToast } from "./toast-colors.js";

/** The title of quota's one-line toasts (a hint, a wrong range); quota toasts have none. */
export const TOAST_TITLE = "OpenCode Quota";

export type ToastOptions = {
  variant: "info" | "success" | "warning" | "error";
  title?: string;
  message: string;
  duration: number;
};

export type TurnEnd = "reply" | "compaction" | "question";

export type ToastHost = {
  /**
   * Shows a toast. A quota toast brings its `lines` too, and a turn's the `input` they were laid
   * out from; its message is their plain text. Returns the toast when it can tell whether it is
   * still on screen.
   */
  show: (toast: ToastOptions, lines?: Line[], input?: ToastInput) => DrawnToast | undefined;
  /** The settings a toast follows: those of `snapshot`, the one it shows, when given. */
  display: (snapshot?: QuotaSnapshot) => DisplaySettings;
  /** The terminal's columns, which a toast's width follows. */
  terminalWidth: () => number;
  quota: Pick<QuotaClient, "refresh" | "snapshot">;
  /** Subagent (child) sessions never show quota toasts. */
  isChildSession: (sessionID: string) => boolean;
  /**
   * Which "every provider fails" toast a session's turn counts toward (each shows once until
   * some provider of its key answers again); without it, one for all sessions.
   */
  allFailKey?: (sessionID: string) => string;
  now?: () => number;
};

export type Toasts = {
  /**
   * A turn ended in `sessionID`: refresh quota, then show the toast the settings ask for,
   * then the reset notices that arrived meanwhile.
   */
  afterTurn(trigger: TurnEnd, sessionID: string): Promise<void>;
  /** Shows the reset notices of a snapshot that this TUI has not shown yet, in one toast. */
  showResetNotices(snapshot: QuotaSnapshot): void;
  /**
   * The Toast page's preview: the toast a turn would show in `sessionID` now. It replaces the
   * page's earlier preview and stays open until `closePreview` or another toast (see above).
   */
  preview(sessionID: string): void;
  /**
   * The Toast page closed: closes its preview, when that is still the toast on screen. A copy
   * that OpenCode holds back still shows (see above).
   */
  closePreview(): void;
  /** The TUI left its server: drops the notices still waiting, as not shown. */
  cancel(): void;
};

/** While the Toast page shows, a new copy of its preview comes this often (see above)... */
const PREVIEW_STEP_MS = 1000;
/** ...and lasts this long: past the next copy, and short once the page closes. */
const PREVIEW_COPY_MS = 3000;
/** A copy of the preview shown this long replaces it and closes right away. */
const PREVIEW_CLOSE_MS = 1;

/** The Toast page's preview while the page shows. */
type Preview = {
  toast: ToastOptions;
  lines: Line[];
  /** The copy last seen on screen. */
  shown: DrawnToast | undefined;
  /**
   * The copy shown last, until it is seen on screen: OpenCode can hold it back, or another toast
   * replaced it (see above).
   */
  next: DrawnToast | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
};

/** What a toast without a title keeps right of its text: OpenCode's close "x", 2 columns in. */
const CLOSE_ROOM = 3;

/**
 * The columns of a quota toast's text: OpenCode's toast is at most 60 columns and 6 fewer than
 * the terminal, inside a border and 2 columns of padding on each side; a toast without a title
 * has its close "x" beside the text.
 */
export function toastRoom(terminalWidth: number): number {
  return Math.min(60, terminalWidth - 6) - 6 - CLOSE_ROOM;
}

function wantsTurnToast(display: DisplaySettings, trigger: TurnEnd, anyLow: boolean): boolean {
  if (trigger === "compaction") return display.toast.afterCompaction;
  if (trigger === "question") return display.toast.afterQuestion;
  return display.toast.afterReply === "always" || (display.toast.afterReply === "low" && anyLow);
}

/** `toast.resetNotice` asks for a notice of this reset: every reset, or only weekly ones. */
export function wantsResetNotice(display: DisplaySettings, notice: ResetNotice): boolean {
  if (!display.toast.show) return false;
  const setting = display.toast.resetNotice;
  return setting === "all" || (setting === "weekly" && notice.window === "week");
}

/**
 * "Weekly quota reset: Claude (work) Weekly is available again (100% left).": the row under its
 * toast name, else its label, with the percent it had at the reset in the percent words.
 * The row is the notice's account's: several accounts can share a row id. Undefined when the
 * provider no longer has the row.
 */
export function resetMessage(
  notice: ResetNotice,
  snapshot: QuotaSnapshot,
  display: DisplaySettings,
  nowMs: number,
): string | undefined {
  const provider = snapshot.providers.find((item) => item.providerId === notice.providerId);
  const row = provider?.rows.find(
    (item) => item.id === notice.rowId && item.account === notice.account,
  );
  if (!provider || !row) return undefined;
  const item = visibleRow(
    { ...row, percentRemaining: notice.percentRemaining },
    display.toast.names,
  );
  const place = { words: display.words, nowMs, names: "label", percent: "words" } as const;
  const facts = rowFacts(item, { rows: [item] }, place);
  const title = notice.account ? `${provider.label} (${notice.account})` : provider.label;
  return `${WINDOWS[notice.window].label} quota reset: ${title} ${facts.name} is available again (${facts.value}).`;
}

export function createToasts(host: ToastHost): Toasts {
  const now = host.now ?? Date.now;
  /** Notices from before this TUI started were news to the TUI that saw them then. */
  const startedAtMs = now();
  const shownNotices = new Set<string>();
  /** The "every provider fails" toast shows once until some provider answers again, by key. */
  const allFailShown = new Set<string>();
  /** Turns whose toast is being made; reset notices wait for them. */
  let turnsRunning = 0;
  /** Reset notices to show, each with the snapshot it came in. */
  let waitingNotices: Array<{ notice: ResetNotice; snapshot: QuotaSnapshot }> = [];
  /** The Toast page's preview, until the page closes or a newer preview replaces it. */
  let preview: Preview | undefined;

  /** Shows the waiting reset notices the settings still ask for, worded as they are now. */
  function showNotices(): void {
    if (turnsRunning > 0 || waitingNotices.length === 0) return;
    const messages = waitingNotices.flatMap(({ notice, snapshot }) => {
      const display = host.display(snapshot);
      if (!wantsResetNotice(display, notice)) return [];
      const message = resetMessage(notice, snapshot, display, now());
      return message ? [message] : [];
    });
    waitingNotices = [];
    if (messages.length === 0) return;
    host.show({
      variant: "success",
      title: "Quota available",
      message: messages.join("\n"),
      duration: host.display().toast.seconds * 1000,
    });
  }

  /** Shows a quota toast of `input`'s lines; nothing when they have no text. */
  function showQuota(variant: ToastOptions["variant"], input: ToastInput, seconds: number): void {
    const lines = toastLines(input);
    const message = lines.map(lineText).join("\n");
    if (message) host.show({ variant, message, duration: seconds * 1000 }, lines, input);
  }

  /** A quota toast now: the Toast surface's rows, as wide as the toast's text. */
  function quotaInput(snapshot: QuotaSnapshot, display: DisplaySettings): ToastInput {
    return toastInput(snapshot, display, {
      nowMs: now(),
      width: toastRoom(host.terminalWidth()),
    });
  }

  /**
   * Shows a new copy of `open` while its last copy is on screen, then checks again in a second.
   * Until its newest copy is seen on screen it adds none: that copy may be held back or replaced
   * (see above).
   */
  function keepPreview(open: Preview): void {
    if (preview !== open) return;
    if (open.next?.onScreen()) {
      open.shown = open.next;
      open.next = undefined;
    }
    if (open.next === undefined) {
      if (!open.shown?.onScreen()) return;
      open.next = host.show({ ...open.toast, duration: PREVIEW_COPY_MS }, open.lines);
    }
    open.timer = setTimeout(() => keepPreview(open), PREVIEW_STEP_MS);
  }

  /** Closes the Toast page's preview when it is still on screen; another toast stays. */
  function closePreview(): void {
    const open = preview;
    preview = undefined;
    if (!open) return;
    clearTimeout(open.timer);
    if (!open.shown?.onScreen() && !open.next?.onScreen()) return;
    host.show({ ...open.toast, duration: PREVIEW_CLOSE_MS }, open.lines);
  }

  async function turnToast(trigger: TurnEnd, sessionID: string): Promise<void> {
    const snapshot = await host.quota.refresh("turn", sessionID);
    const display = host.display(snapshot);
    if (!snapshot || !display.toast.show) return;
    const input = quotaInput(snapshot, display);
    const allFail =
      snapshot.providers.length > 0 && snapshot.providers.every((provider) => provider.error);
    const allFailKey = host.allFailKey?.(sessionID) ?? "";
    if (!allFail) allFailShown.delete(allFailKey);
    const anyLow = input.groups.some((group) =>
      group.rows.some(
        ({ row }) =>
          row.percentRemaining !== undefined &&
          levelOf(row.percentRemaining, display.colors) !== "good",
      ),
    );
    if (wantsTurnToast(display, trigger, anyLow)) {
      showQuota("info", input, display.toast.seconds);
      return;
    }
    if (allFail && display.toast.whenAllFail && !allFailShown.has(allFailKey)) {
      allFailShown.add(allFailKey);
      const failing = input.groups.filter((group) => group.error);
      showQuota(
        "error",
        { ...input, groups: failing, sessionTokens: undefined },
        display.toast.seconds,
      );
    }
  }

  return {
    async afterTurn(trigger, sessionID) {
      if (host.isChildSession(sessionID)) return;
      turnsRunning += 1;
      try {
        await turnToast(trigger, sessionID);
      } finally {
        turnsRunning -= 1;
        showNotices();
      }
    },

    showResetNotices(snapshot) {
      const display = host.display(snapshot);
      for (const notice of snapshot.resetNotices) {
        if (shownNotices.has(notice.id)) continue;
        shownNotices.add(notice.id);
        if (!wantsResetNotice(display, notice) || notice.atMs < startedAtMs) continue;
        waitingNotices.push({ notice, snapshot });
      }
      showNotices();
    },

    preview(sessionID) {
      const snapshot = host.quota.snapshot(sessionID);
      const display = host.display(snapshot);
      const lines = snapshot && display.toast.show ? toastLines(quotaInput(snapshot, display)) : [];
      const message = lines.map(lineText).join("\n");
      if (!message) {
        closePreview();
        return;
      }
      const old = preview;
      clearTimeout(old?.timer);
      const toast: ToastOptions = {
        variant: "info",
        message,
        duration: display.toast.seconds * 1000,
      };
      const open: Preview = { toast, lines, shown: undefined, next: undefined, timer: undefined };
      if (old?.shown?.onScreen() && old.next !== undefined && !old.next.onScreen()) {
        // OpenCode holds back the old preview's last copy, and would hold this toast too: the new
        // preview waits for that copy, then replaces it.
        open.shown = old.shown;
        open.next = old.next;
      } else {
        open.next = host.show(toast, lines);
      }
      preview = open;
      // Inside a Solid update OpenCode draws the toast only when the update ends: after this call.
      queueMicrotask(() => keepPreview(open));
    },

    closePreview,

    cancel() {
      for (const { notice } of waitingNotices) shownNotices.delete(notice.id);
      waitingNotices = [];
    },
  };
}
