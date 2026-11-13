import { type CursorProviderError } from "./errors.js";
/** How long one outage may hold a turn before it fails. */
export declare const OFFLINE_RETRY_WINDOW_MS: number;
export type OfflineClock = {
    now?: () => number;
    sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
    windowMs?: number;
};
export declare function setOfflineClockForTests(clock: OfflineClock | undefined): void;
/** One outage: its consecutive connectivity failures share a window and a growing backoff. */
export type OfflineWait = {
    since: number;
    attempts: number;
};
export declare function startOfflineWait(): OfflineWait;
/**
 * Name-resolution/routing failures keep the outage window. Refused, reset or
 * silent connections keep the normal budget. The reopen tests reachability
 * through the Run's own origin and proxy, without a separate fixed-host probe.
 */
export declare function isOfflineFailure(error: unknown): boolean;
/** Full-jitter backoff, capped, matching the Run retry delay shape. */
export declare function offlineDelayMs(attempt: number, random?: number): number;
/**
 * Back off before the next attempt of this outage without spending the Run
 * retry budget. The abort signal cancels the wait; the window ending fails the turn.
 */
export declare function waitOffline(wait: OfflineWait, failure: CursorProviderError, signal?: AbortSignal): Promise<void>;
