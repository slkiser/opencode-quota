/**
 * The session events after which quota toasts or refreshes, for the TUI and the GUI window: a
 * reply (`session.execution.succeeded`), a compaction, an answered question (the `question`
 * tool's call succeeded), and every step (each can use quota; the server skips a refresh that is
 * not due yet). Both read OpenCode's synced data events, `on(type, handler)`.
 */
import type { TurnEnd } from "./toasts.js";

export type SessionEvent = {
  location?: { directory?: string };
  data?: Record<string, unknown>;
};

export type TurnListeners = {
  /** A turn ended in `sessionID`. */
  afterTurn(trigger: TurnEnd, sessionID: string, event: SessionEvent): void;
  /** A step ended in `sessionID`. */
  stepEnded(sessionID: string, event: SessionEvent): void;
};

type On = (type: string, handler: (event: SessionEvent) => void) => () => void;

function eventSessionID(event: SessionEvent): string | undefined {
  const sessionID = event.data?.sessionID;
  return typeof sessionID === "string" && sessionID ? sessionID : undefined;
}

function eventToolCallID(event: SessionEvent): string | undefined {
  const id = event.data?.id;
  return typeof id === "string" ? id : undefined;
}

/** Listens to the turn events until the returned stop. */
export function listenForTurns(on: On, listeners: TurnListeners): () => void {
  const questionToolCalls = new Set<string>();
  const afterTurn = (event: SessionEvent, trigger: TurnEnd) => {
    const sessionID = eventSessionID(event);
    if (sessionID) listeners.afterTurn(trigger, sessionID, event);
  };
  const stops = [
    on("session.execution.succeeded", (event) => afterTurn(event, "reply")),
    on("session.compaction.ended", (event) => afterTurn(event, "compaction")),
    on("session.step.ended", (event) => {
      const sessionID = eventSessionID(event);
      if (sessionID) listeners.stepEnded(sessionID, event);
    }),
    on("session.tool.input.started", (event) => {
      const id = eventToolCallID(event);
      if (event.data?.name === "question" && id) questionToolCalls.add(id);
    }),
    on("session.tool.success", (event) => {
      const id = eventToolCallID(event);
      if (id && questionToolCalls.delete(id)) afterTurn(event, "question");
    }),
    on("session.tool.failed", (event) => {
      const id = eventToolCallID(event);
      if (id) questionToolCalls.delete(id);
    }),
  ];
  return () => {
    for (const stop of stops) stop();
    questionToolCalls.clear();
  };
}
