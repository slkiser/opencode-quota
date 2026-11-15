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

/** One timer at a time: a newer start replaces the older timer, and stop clears it. */
function oneTimer() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  return {
    start(ms: number, run: () => void): void {
      stop();
      timer = setTimeout(() => {
        timer = undefined;
        run();
      }, ms);
    },
    stop,
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
    stop: timer.stop,
  };
}

/** Save of the draft, with "Saved" for a while after it ends well. */
export function createSave(saveDraft: () => Promise<void>) {
  const [state, setState] = createSignal<SaveState>({ state: "idle" });
  const timer = oneTimer();
  const become = (next: SaveState) => {
    timer.stop();
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
    stop: timer.stop,
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
