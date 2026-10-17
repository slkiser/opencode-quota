/**
 * HTTP for provider API calls: `requestJson` asks for one JSON reply within a timeout and a
 * size cap, and says why it got none, with the caller's own secrets redacted.
 */

import { type ErrorFacts, RETRY_WAIT_MAX_MS } from "../core/errors.js";
import { secretValuesRedactor } from "../core/redact.js";
import type { QuotaErrorCode } from "../core/types.js";
import { sanitizeDisplayText } from "./display-sanitize.js";

/** Request timeout in milliseconds. */
export const REQUEST_TIMEOUT_MS = 5000;

/** Thrown by `fetchWithTimeout` at the deadline; its message never holds the URL. */
class RequestTimeoutError extends Error {}

function timeoutMessage(timeoutMs: number): string {
  return `Request timeout after ${Math.round(timeoutMs / 1000)}s`;
}

type FetchWithTimeoutOptions<T> = {
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
  const timeoutErrorMessage = timeoutMessage(timeoutMs);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new RequestTimeoutError(timeoutErrorMessage));
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
      throw new RequestTimeoutError(timeoutErrorMessage);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Larger than any quota reply; a reply past it is not read further. */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Why a request gave no JSON. `http`: a reply that is not 2xx (a redirect too, with
 * `redirect: "manual"`); `timeout`; `network`: no reply; `too_large`: a reply over `maxBytes`;
 * `invalid_json`: a 2xx reply that is not JSON.
 */
export type RequestFailure = {
  kind: "http" | "timeout" | "network" | "too_large" | "invalid_json";
  /**
   * The error code: 401 is `login_expired`, 429 `rate_limited`, any other non-2xx
   * `provider_error`; `timeout`; `network`; a reply too large or not JSON `bad_response`.
   */
  code: QuotaErrorCode;
  /** When a non-2xx reply's Retry-After says to try again. */
  retryAtMs?: number;
  /** The reply's status and headers, whenever a reply arrived. */
  status?: number;
  headers?: Headers;
  /**
   * For `http`, the reply body (empty when it could not be read); else the error message.
   * Control characters removed and the caller's secrets replaced by "[redacted]"; not cut.
   */
  detail: string;
};

export type JsonReply =
  | { ok: true; status: number; headers: Headers; json: unknown }
  | { ok: false; failure: RequestFailure };

type RequestJsonOptions = {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string | URLSearchParams;
  redirect?: RequestInit["redirect"];
  /** Values never shown in `detail`: the key, token or cookie the request carries. */
  secrets?: ReadonlyArray<string | undefined>;
  timeoutMs?: number;
  maxBytes?: number;
  /** An empty or blank 2xx body reads as JSON null instead of `invalid_json`. */
  blankAsNull?: boolean;
};

class TooLargeError extends Error {}

function failureCode(kind: RequestFailure["kind"], status: number | undefined): QuotaErrorCode {
  switch (kind) {
    case "http":
      return status === 401 ? "login_expired" : status === 429 ? "rate_limited" : "provider_error";
    case "timeout":
      return "timeout";
    case "network":
      return "network";
    case "too_large":
    case "invalid_json":
      return "bad_response";
  }
}

/**
 * A Retry-After header as a wait: delta-seconds or an HTTP date, at most `RETRY_WAIT_MAX_MS`;
 * none when absent, past or unreadable.
 */
export function parseRetryAfterMs(
  value: string | null,
  nowMs: number = Date.now(),
): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;

  const durationMs = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/u.test(trimmed)
    ? Number(trimmed) * 1_000
    : Date.parse(trimmed) - nowMs;
  return Number.isFinite(durationMs) && durationMs > 0
    ? Math.min(durationMs, RETRY_WAIT_MAX_MS)
    : undefined;
}

/**
 * The facts the error vocabulary keeps of a failure: its code, the HTTP status of a non-2xx
 * reply, and its Retry-After. `code` replaces the failure's own when the caller's words mean
 * another (a 3xx that means "sign in again").
 */
export function failureFacts(
  failure: RequestFailure,
  code: QuotaErrorCode = failure.code,
): ErrorFacts {
  return {
    code,
    ...(failure.kind === "http" && failure.status !== undefined ? { status: failure.status } : {}),
    ...(failure.retryAtMs !== undefined ? { retryAtMs: failure.retryAtMs } : {}),
  };
}

/** A failed request as a thrown error, for callers that throw; its facts stay with it. */
export class RequestFailedError extends Error {
  constructor(
    message: string,
    readonly facts: ErrorFacts,
  ) {
    super(message);
  }
}

/** The facts of a thrown request failure; none for any other error. */
export function thrownFacts(error: unknown): ErrorFacts | undefined {
  return error instanceof RequestFailedError ? error.facts : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The body as text; throws TooLargeError past `maxBytes`, declared or read. */
async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const tooLarge = new TooLargeError(`response exceeded ${maxBytes} bytes`);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw tooLarge;
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let byteLength = 0;
  try {
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      byteLength += next.value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel().catch(() => {});
        throw tooLarge;
      }
      text += decoder.decode(next.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

/**
 * One JSON request: the parsed 2xx reply, or why there is none. Never throws. A reply whose
 * body stalls past the deadline is a `timeout` that still has its status and headers.
 */
export async function requestJson(
  url: string,
  options: RequestJsonOptions = {},
): Promise<JsonReply> {
  const secrets = (options.secrets ?? []).filter((secret): secret is string => Boolean(secret));
  const redact = secretValuesRedactor(secrets);
  const clean = (text: string) => redact(sanitizeDisplayText(text));
  const fail = (failure: Omit<RequestFailure, "code" | "retryAtMs">): JsonReply => {
    const retryAfterMs =
      failure.kind === "http"
        ? parseRetryAfterMs(failure.headers?.get("Retry-After") ?? null)
        : undefined;
    return {
      ok: false,
      failure: {
        ...failure,
        code: failureCode(failure.kind, failure.status),
        ...(retryAfterMs === undefined ? {} : { retryAtMs: Date.now() + retryAfterMs }),
      },
    };
  };
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  let reply: { status: number; headers: Headers } | undefined;

  try {
    return await fetchWithTimeout<JsonReply>(url, {
      request: {
        ...(options.method ? { method: options.method } : {}),
        ...(options.headers ? { headers: options.headers } : {}),
        ...(options.body !== undefined ? { body: options.body } : {}),
        ...(options.redirect ? { redirect: options.redirect } : {}),
      },
      timeoutMs: options.timeoutMs,
      consume: async (response) => {
        const received = { status: response.status, headers: response.headers };
        reply = received;
        let text: string;
        try {
          text = await readBoundedText(response, maxBytes);
        } catch (error) {
          if (error instanceof TooLargeError) {
            return fail({ kind: "too_large", ...received, detail: error.message });
          }
          if (!response.ok) return fail({ kind: "http", ...received, detail: "" });
          throw error;
        }
        if (!response.ok) return fail({ kind: "http", ...received, detail: clean(text) });
        if (options.blankAsNull && text.trim() === "") return { ok: true, ...received, json: null };
        try {
          return { ok: true, ...received, json: JSON.parse(text) as unknown };
        } catch (error) {
          return fail({ kind: "invalid_json", ...received, detail: clean(errorText(error)) });
        }
      },
    });
  } catch (error) {
    const kind = error instanceof RequestTimeoutError ? "timeout" : "network";
    const received = reply ? { status: reply.status, headers: reply.headers } : {};
    return fail({ kind, ...received, detail: clean(errorText(error)) });
  }
}
