export type HostSteer = {
    sessionID: string;
    inboxID: string;
    text: string;
};
export type EarlySteer = HostSteer & {
    injectionId: string;
    /** The Cursor Run (`CursorSession.sessionId`) it was injected into, or the Run resumed from its checkpoint. */
    run: string;
    delivered: boolean;
    /** A checkpoint arrived after Cursor delivered it, so a Run resumed from that checkpoint holds it. */
    checkpointed: boolean;
    /** Its Run reached `turn_ended` after delivering it, so the model has answered it. */
    answered: boolean;
    /** OpenCode's own copy came after the step's tool results and was left out of the continuation. */
    promoted?: boolean;
    /** Prompt boundary at which the host supplied its copy; distinct later replies do not match it. */
    hostTurn?: string;
};
/** undefined when another plugin copy already announced the steer. */
export declare function announceHostSteer(steer: HostSteer): boolean | undefined;
/** Remember a queued message, so a later switch to `steer` can announce it. */
export declare function rememberQueuedSteer(steer: HostSteer): void;
export declare function takeQueuedSteer(inboxID: string): HostSteer | undefined;
export declare function listenForHostSteers(sessionID: string, listener: (steer: HostSteer) => boolean): () => void;
/** false when there is no room to track it; OpenCode's own copy then runs as usual. */
export declare function recordEarlySteer(steer: EarlySteer): boolean;
export declare function isEarlySteerTracked(sessionID: string, injectionId: string): boolean;
/** An injection Cursor never accepted. A promoted one stays, to be sent at `turn_ended`. */
export declare function forgetUndeliveredEarlySteer(sessionID: string, injectionId: string): void;
/** The host withdrew the message, so no copy of it will come. */
export declare function forgetEarlySteerOfInbox(sessionID: string, inboxID: string): void;
/** true when the injection is an early steer. */
export declare function markEarlySteerDelivered(sessionID: string | undefined, injectionId: string | undefined): boolean;
export declare function markEarlySteersCheckpointed(sessionID: string | undefined, run: string): void;
/**
 * At `turn_ended`: a delivered steer is answered and waits for OpenCode's copy; one Cursor never took is
 * forgotten, so OpenCode's copy runs as an ordinary message. A promoted one has no copy left to come:
 * one Cursor never took is returned for a follow-up Run and stays, as sent, until a checkpoint holds it.
 * Answered receipts survive retries and are retired when a later Run finishes.
 */
export declare function settleEarlySteers(sessionID: string | undefined, run: string): {
    answered: number;
    undelivered: EarlySteer[];
    leftToHost: number;
};
/**
 * A failed Run's steers: those its checkpoint holds go to the Run resumed from it (`to`), and so does a
 * promoted one it does not hold, to be sent at that Run's `turn_ended`. The rest are forgotten, so
 * OpenCode's own copy of each runs as an ordinary message. A rebase (`to` undefined) seeds from host
 * history, which already holds a promoted copy.
 */
export declare function handOverEarlySteers(sessionID: string | undefined, from: string, to: string | undefined): void;
/** The host may add `<system-reminder>` parts to a promoted copy; any other difference is another message. */
export declare function carriesSteer(message: string, text: string): boolean;
/** The record each message carries, or nothing unless every message carries one. */
export declare function matchEarlySteers(sessionID: string | undefined, messages: readonly string[], accept: (record: EarlySteer) => boolean): EarlySteer[];
export declare function forgetEarlySteerRecords(sessionID: string, records: readonly EarlySteer[]): void;
/**
 * A steer of a Run that ended without answering it (a stop, a failed recovery) that only host history
 * holds reliably: OpenCode placed it in its history (a checkpoint may hold it too, and resuming would
 * then send it twice), or a checkpoint holds it while OpenCode's copy is still to come.
 */
export declare function needsHostHistory(sessionID: string | undefined, openRun: string | undefined): boolean;
/** Keep answered receipts until the new turn succeeds, so a host retry still omits its copies. */
export declare function clearUnansweredEarlySteers(sessionID: string | undefined): void;
/** Private restart metadata, saved atomically with the checkpoint it describes. */
export declare function serializeEarlySteers(sessionID: string): string | undefined;
export declare function restoreEarlySteers(sessionID: string, encoded: string | undefined): void;
export declare function forgetEarlySteers(sessionID: string): void;
export declare function resetHostSteersForTests(): void;
