import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchWithTimeout } from "../src/lib/http.js";
import { REQUEST_TIMEOUT_MS } from "../src/lib/types.js";

function createPendingFetch() {
  return vi.fn((_url: string | URL | Request, options?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => {
        reject(new Error("fetch aborted"));
      });
    });
  });
}

describe("fetchWithTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("defaults provider requests to a 5 second timeout", () => {
    expect(REQUEST_TIMEOUT_MS).toBe(5000);
  });

  it("times out before headers using an explicit timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", createPendingFetch());

    const request = fetchWithTimeout("https://example.test/quota", {
      request: {},
      timeoutMs: 12000,
      consume: (response) => response.json(),
    });
    const assertion = expect(request).rejects.toThrow("Request timeout after 12s");

    await vi.advanceTimersByTimeAsync(12000);
    await assertion;
  });

  it("reports the default pre-header timeout in seconds", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", createPendingFetch());

    const request = fetchWithTimeout("https://example.test/quota", {
      request: {},
      consume: (response) => response.json(),
    });
    const assertion = expect(request).rejects.toThrow("Request timeout after 5s");

    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await assertion;
  });

  it("times out while consuming a stalled response body", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string | URL | Request, options?: RequestInit) => {
        requestSignal = options?.signal ?? undefined;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            requestSignal?.addEventListener("abort", () => {
              controller.error(new Error("body aborted"));
            });
          },
        });
        return Promise.resolve(new Response(body));
      }),
    );

    const request = fetchWithTimeout("https://example.test/quota", {
      request: {},
      timeoutMs: 3000,
      consume: (response) => response.text(),
    });
    const assertion = expect(request).rejects.toThrow("Request timeout after 3s");

    await vi.advanceTimersByTimeAsync(3000);
    await assertion;
    expect(requestSignal?.aborted).toBe(true);
  });

  it("rejects at the deadline when an injected fetch ignores abort", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const fetchFn = vi.fn((_url: string | URL | Request, options?: RequestInit) => {
      requestSignal = options?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    });

    const request = fetchWithTimeout("https://example.test/quota", {
      request: {},
      timeoutMs: 2000,
      fetchFn,
      consume: (response) => response.text(),
    });
    const assertion = expect(request).rejects.toThrow("Request timeout after 2s");

    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    expect(requestSignal?.aborted).toBe(true);
  });

  it("rejects at the deadline when the consumer ignores abort", async () => {
    vi.useFakeTimers();
    let consumerSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("ok"))),
    );

    const request = fetchWithTimeout("https://example.test/quota", {
      request: {},
      timeoutMs: 2000,
      consume: (_response, signal) => {
        consumerSignal = signal;
        return new Promise<string>(() => undefined);
      },
    });
    const assertion = expect(request).rejects.toThrow("Request timeout after 2s");

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    expect(consumerSignal?.aborted).toBe(true);
  });

  it("keeps the timeout authoritative when fetch resolves after the deadline", async () => {
    vi.useFakeTimers();
    let resolveFetch!: (response: Response) => void;
    const fetchFn = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const consume = vi.fn((response: Response) => response.text());

    const request = fetchWithTimeout("https://example.test/quota", {
      request: {},
      timeoutMs: 1000,
      fetchFn,
      consume,
    });
    const assertion = expect(request).rejects.toThrow(/^Request timeout after 1s$/);

    await vi.advanceTimersByTimeAsync(1000);
    await assertion;

    resolveFetch(new Response("late success"));
    await vi.advanceTimersByTimeAsync(0);

    expect(consume).toHaveBeenCalledOnce();
    await expect(request).rejects.toThrow(/^Request timeout after 1s$/);
  });

  it("keeps the timeout authoritative without an unhandled late fetch rejection", async () => {
    vi.useFakeTimers();
    let rejectFetch!: (error: Error) => void;
    const fetchFn = vi.fn(
      () =>
        new Promise<Response>((_resolve, reject) => {
          rejectFetch = reject;
        }),
    );
    const consume = vi.fn((response: Response) => response.text());
    const unhandledRejection = vi.fn();
    process.on("unhandledRejection", unhandledRejection);

    try {
      const request = fetchWithTimeout("https://example.test/quota", {
        request: {},
        timeoutMs: 1000,
        fetchFn,
        consume,
      });
      const assertion = expect(request).rejects.toThrow(/^Request timeout after 1s$/);

      await vi.advanceTimersByTimeAsync(1000);
      await assertion;

      rejectFetch(new Error("late private rejection"));
      await vi.advanceTimersByTimeAsync(0);

      expect(consume).not.toHaveBeenCalled();
      expect(unhandledRejection).not.toHaveBeenCalled();
      await expect(request).rejects.toThrow(/^Request timeout after 1s$/);
    } finally {
      process.off("unhandledRejection", unhandledRejection);
    }
  });

  it("returns successfully consumed and parsed data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json({ remaining: 42 }))),
    );

    await expect(
      fetchWithTimeout("https://example.test/quota", {
        request: {},
        consume: (response) => response.json() as Promise<{ remaining: number }>,
      }),
    ).resolves.toEqual({ remaining: 42 });
  });

  it("clears the timer after success without later aborting the request signal", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string | URL | Request, options?: RequestInit) => {
        requestSignal = options?.signal ?? undefined;
        return Promise.resolve(new Response("ok"));
      }),
    );

    await expect(
      fetchWithTimeout("https://example.test/quota", {
        request: {},
        timeoutMs: 1000,
        consume: (response) => response.text(),
      }),
    ).resolves.toBe("ok");

    await vi.advanceTimersByTimeAsync(1000);
    expect(requestSignal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates a non-timeout consumer error unchanged", async () => {
    const parseError = new Error("invalid response shape");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("{}"))),
    );

    await expect(
      fetchWithTimeout("https://example.test/quota", {
        request: {},
        consume: () => {
          throw parseError;
        },
      }),
    ).rejects.toBe(parseError);
  });

  it("keeps timeout diagnostics static and free of request content", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", createPendingFetch());
    const secretUrl = "https://example.test/quota?token=secret-canary";

    const request = fetchWithTimeout(secretUrl, {
      request: {},
      timeoutMs: 1000,
      consume: (response) => response.text(),
    });
    const assertion = expect(request).rejects.toThrow(/^Request timeout after 1s$/);

    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    await expect(request).rejects.not.toThrow("secret-canary");
  });
});
