/**
 * `openCodeSessionId` undefined: every session (the host is shutting down).
 * `at`: when the host stopped, on this process's clock.
 */
export type HostInterruptListener = (openCodeSessionId: string | undefined, reason: string, at: number) => void | Promise<void>;
export declare function onHostInterrupt(listener: HostInterruptListener): () => void;
/**
 * The host stopped this session's execution (OpenCode 2 never aborts `doStream`
 * for it). `reason: "shutdown"` keeps the turn for the next server start: its
 * state is saved, nothing is cancelled. Resolves once every listener settled.
 */
export declare function notifyHostInterrupt(openCodeSessionId: string | undefined, reason: string, at?: number): Promise<void>;
