/**
 * Bound a complete async operation, not only fetch(). Response body readers can
 * ignore abort signals, so Promise.race remains the authoritative deadline.
 *
 * Rejects with `timeoutError()` before aborting so callers observe the domain
 * timeout error rather than a generic AbortError.
 */
export async function withAbortDeadline(timeoutMs, timeoutError, run) {
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
            reject(timeoutError());
            controller.abort();
        }, timeoutMs);
        timer.unref?.();
    });
    try {
        return await Promise.race([run(controller.signal), deadline]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
