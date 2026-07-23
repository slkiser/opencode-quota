/**
 * HTTP utilities for provider API calls.
 */

import { REQUEST_TIMEOUT_MS } from "./types.js";

export type FetchWithTimeoutOptions<T> = {
  request: Omit<RequestInit, "signal">;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  consume: (response: Response, timeoutSignal: AbortSignal) => Promise<T> | T;
};

/**
 * Fetch and consume a response within one timeout.
 *
 * The response consumer must complete all status handling, body reads, and parsing
 * before returning so the request signal remains active for the full transaction.
 *
 * @throws Error with message "Request timeout after Xs" if the transaction times out
 */
export async function fetchWithTimeout<T>(
  url: string,
  options: FetchWithTimeoutOptions<T>,
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timeoutErrorMessage = `Request timeout after ${Math.round(timeoutMs / 1000)}s`;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error(timeoutErrorMessage));
    }, timeoutMs);
  });

  try {
    const transaction = (async () => {
      const fetchFn = options.fetchFn ?? globalThis.fetch;
      const response = await fetchFn(url, {
        ...options.request,
        signal: controller.signal,
      });
      return await options.consume(response, controller.signal);
    })();
    return await Promise.race([transaction, timeout]);
  } catch (err) {
    if (timedOut) {
      throw new Error(timeoutErrorMessage);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}
