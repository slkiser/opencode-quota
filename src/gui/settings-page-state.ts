/**
 * The Settings page's state besides the draft: what Save is doing, the short notes after Save and
 * Copy, and the Plugin section's notices and setup check, each a value with a `state` tag.
 */
import { createSignal } from "solid-js";
import type { Notice } from "../rpc.js";
import { rpcErrorMessage } from "../tui/client.js";
import type { GuiQuota } from "./bridge.js";

/** How long "Saved" shows after Save. */
const SAVED_NOTE_MS = 3_000;

/** An answer the page asks the server for. */
export type Load<T> =
  | { state: "loading" }
  | { state: "loaded"; value: T }
  | { state: "failed"; message: string };

export type SaveState =
  | { state: "idle" }
  | { state: "saving" }
  | { state: "saved" }
  | { state: "failed"; message: string };

const LOADING = { state: "loading" } as const;
const failed = (error: unknown) => ({ state: "failed", message: rpcErrorMessage(error) }) as const;

type TimerState =
  | { state: "idle" }
  | { state: "running"; timer: ReturnType<typeof setTimeout> }
  | { state: "closed" };

/**
 * One timer at a time: a newer start replaces the older timer and cancel clears it. After close,
 * starts do nothing, so a Save or Copy that ends after the page closed starts no timer.
 */
function oneTimer() {
  let current: TimerState = { state: "idle" };
  const cancel = () => {
    if (current.state !== "running") return;
    clearTimeout(current.timer);
    current = { state: "idle" };
  };
  return {
    start(ms: number, run: () => void): void {
      if (current.state === "closed") return;
      cancel();
      const timer = setTimeout(() => {
        current = { state: "idle" };
        run();
      }, ms);
      current = { state: "running", timer };
    },
    cancel,
    close(): void {
      cancel();
      current = { state: "closed" };
    },
  };
}

/** A note shown for `ms` after each `show`; a newer show starts the time again. */
export function createNote(ms: number) {
  const [shown, setShown] = createSignal(false);
  const timer = oneTimer();
  return {
    shown,
    show(): void {
      setShown(true);
      timer.start(ms, () => setShown(false));
    },
    /** The page closed. */
    stop: timer.close,
  };
}

/** Save of the draft, with "Saved" for a while after it ends well. */
export function createSave(saveDraft: () => Promise<void>) {
  const [state, setState] = createSignal<SaveState>({ state: "idle" });
  const timer = oneTimer();
  const become = (next: SaveState) => {
    timer.cancel();
    setState(next);
  };
  return {
    state,
    async save(): Promise<void> {
      become({ state: "saving" });
      try {
        await saveDraft();
        become({ state: "saved" });
        timer.start(SAVED_NOTE_MS, () => setState({ state: "idle" }));
      } catch (error) {
        become(failed(error));
      }
    },
    /** The draft went back to the saved settings: a failed save's message goes. */
    discarded(): void {
      if (state().state === "failed") become({ state: "idle" });
    },
    /** The page closed. */
    stop: timer.close,
  };
}

/** The Plugin section's notices and the setup check of the session shown. */
export function createPluginChecks(data: Pick<GuiQuota, "notices" | "status">) {
  const [notices, setNotices] = createSignal<Load<Notice[]>>(LOADING);
  const [status, setStatus] = createSignal<Load<string>>(LOADING);
  return {
    notices,
    status,
    async loadNotices(): Promise<void> {
      try {
        setNotices({ state: "loaded", value: await data.notices() });
      } catch (error) {
        setNotices(failed(error));
      }
    },
    /** Asks for the setup check of `sessionID`; the stop it returns drops a late answer. */
    checkStatus(sessionID: string | undefined): () => void {
      let current = true;
      setStatus(LOADING);
      void data.status(sessionID).then(
        (value) => {
          if (current) setStatus({ state: "loaded", value });
        },
        (error: unknown) => {
          if (current) setStatus(failed(error));
        },
      );
      return () => {
        current = false;
      };
    },
  };
}
