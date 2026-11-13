import { CursorLocalCancellationError, CursorRetryExhaustedError, CursorTransportError, offlineNetworkCode, } from "./errors.js";
/** How long one outage may hold a turn before it fails. */
export const OFFLINE_RETRY_WINDOW_MS = 3 * 60 * 60_000;
const OFFLINE_BASE_DELAY_MS = 500;
const OFFLINE_MAX_DELAY_MS = 30_000;
let testClock;
export function setOfflineClockForTests(clock) {
    testClock = clock;
}
export function startOfflineWait() {
    return { since: (testClock?.now ?? Date.now)(), attempts: 0 };
}
/**
 * Name-resolution/routing failures keep the outage window. Refused, reset or
 * silent connections keep the normal budget. The reopen tests reachability
 * through the Run's own origin and proxy, without a separate fixed-host probe.
 */
export function isOfflineFailure(error) {
    return offlineNetworkCode(error) !== undefined;
}
/** Full-jitter backoff, capped, matching the Run retry delay shape. */
export function offlineDelayMs(attempt, random = Math.random()) {
    const ceiling = Math.min(OFFLINE_MAX_DELAY_MS, OFFLINE_BASE_DELAY_MS * 2 ** Math.max(0, attempt));
    return Math.max(1, Math.floor(random * ceiling));
}
/**
 * Back off before the next attempt of this outage without spending the Run
 * retry budget. The abort signal cancels the wait; the window ending fails the turn.
 */
export async function waitOffline(wait, failure, signal) {
    const now = testClock?.now ?? Date.now;
    const sleep = testClock?.sleep ?? defaultSleep;
    const windowMs = testClock?.windowMs ?? OFFLINE_RETRY_WINDOW_MS;
    // Each call follows one failed attempt. A wait that exhausts the window
    // never opens another Run, so it must not count that unmade attempt.
    wait.attempts++;
    if (now() - wait.since >= windowMs)
        throw offlineWindowError(failure, wait, windowMs);
    await sleep(offlineDelayMs(wait.attempts - 1), signal);
    if (now() - wait.since >= windowMs)
        throw offlineWindowError(failure, wait, windowMs);
}
function offlineWindowError(failure, wait, windowMs) {
    const minutes = Math.max(1, Math.round(windowMs / 60_000));
    return new CursorRetryExhaustedError(wait.attempts, new CursorTransportError(`Cursor stayed unreachable for ${minutes} ${minutes === 1 ? "minute" : "minutes"}`, { transient: true, replaySafe: true, code: failure.code, cause: failure }));
}
// Not unref'd: a turn waiting for the network must keep the process alive.
function defaultSleep(delayMs, signal) {
    if (signal?.aborted)
        return Promise.reject(new CursorLocalCancellationError("Cursor retry cancelled"));
    return new Promise((resolve, reject) => {
        const timer = setTimeout(finish, delayMs);
        const onAbort = () => finish(new CursorLocalCancellationError("Cursor retry cancelled"));
        function finish(error) {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            if (error)
                reject(error);
            else
                resolve();
        }
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}
