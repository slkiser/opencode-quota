import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { describeError, providerError } from "../src/core/errors.js";
import {
  errorWords,
  failureFacts,
  fetchWithTimeout,
  parseRetryAfterMs,
  requestJson,
} from "../src/lib/http.js";

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

  it.each([
    { name: "an explicit timeout", timeoutMs: 12_000, seconds: 12 },
    { name: "the default timeout for provider requests", timeoutMs: undefined, seconds: 5 },
  ])(
    "times out before headers after $name, with a static message free of the URL",
    async ({ timeoutMs, seconds }) => {
      vi.useFakeTimers();
      vi.stubGlobal("fetch", createPendingFetch());

      const request = fetchWithTimeout("https://example.test/quota?token=secret-canary", {
        request: {},
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        consume: (response) => response.json(),
      });
      const message = new RegExp(`^Request timeout after ${seconds}s$`);
      const assertion = expect(request).rejects.toThrow(message);

      await vi.advanceTimersByTimeAsync(seconds * 1000);
      await assertion;
      await expect(request).rejects.not.toThrow("secret-canary");
    },
  );

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
});

describe("requestJson", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function answer(response: Response | Error) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (response instanceof Error) throw response;
        return response;
      }),
    );
  }

  it("returns the parsed reply with its status and headers", async () => {
    answer(Response.json({ remaining: 42 }, { headers: { "x-test": "1" } }));

    const reply = await requestJson("https://example.test/quota");

    expect(reply).toMatchObject({ ok: true, status: 200, json: { remaining: 42 } });
    expect(reply.ok && reply.headers.get("x-test")).toBe("1");
  });

  it.each([
    [
      "a non-2xx reply, its body cleaned and its secrets redacted",
      new Response("denied for sk-\u001b[31mlive-secret-value and short", {
        status: 503,
        headers: { "Retry-After": "30" },
      }),
      { kind: "http", status: 503, detail: "denied for [redacted] and [redacted]" },
    ],
    [
      "a 2xx reply that is not JSON",
      new Response("<html>"),
      { kind: "invalid_json", status: 200, detail: expect.stringContaining("JSON") },
    ],
    [
      "a reply declared larger than the cap",
      new Response("{}", { headers: { "content-length": "20" } }),
      { kind: "too_large", status: 200, detail: "response exceeded 10 bytes" },
    ],
    [
      "a reply read past the cap",
      new Response(JSON.stringify({ text: "x".repeat(20) })),
      { kind: "too_large", status: 200, detail: "response exceeded 10 bytes" },
    ],
    [
      "no reply, its error redacted",
      new Error("connect failed for short"),
      { kind: "network", detail: "connect failed for [redacted]" },
    ],
  ])("reports %s", async (_name, response, failure) => {
    answer(response);

    const reply = await requestJson("https://example.test/quota", {
      secrets: ["sk-live-secret-value", "short", undefined],
      maxBytes: failure.kind === "too_large" ? 10 : undefined,
    });

    expect(reply).toEqual({ ok: false, failure: expect.objectContaining(failure) });
  });

  it("reads a blank 2xx body as null only when asked", async () => {
    answer(new Response(" "));
    await expect(requestJson("https://example.test/quota", { blankAsNull: true })).resolves.toEqual(
      expect.objectContaining({ ok: true, json: null }),
    );
    answer(new Response(" "));
    await expect(requestJson("https://example.test/quota")).resolves.toMatchObject({
      ok: false,
      failure: { kind: "invalid_json" },
    });
  });

  function stalledBody(signal: AbortSignal | null | undefined) {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
      },
    });
  }

  it("times out a stalled 2xx body and keeps the reply's status and headers", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: string | URL | Request, options?: RequestInit) =>
          new Response(stalledBody(options?.signal), { headers: { "x-test": "1" } }),
      ),
    );

    const request = requestJson("https://example.test/quota", { timeoutMs: 2000 });
    await vi.advanceTimersByTimeAsync(2000);
    const reply = await request;

    expect(reply).toMatchObject({
      ok: false,
      failure: { kind: "timeout", status: 200, detail: "Request timeout after 2s" },
    });
    expect(!reply.ok && reply.failure.headers?.get("x-test")).toBe("1");
  });

  it("keeps a 401 whose body stalls past the deadline as a sign-in failure", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: string | URL | Request, options?: RequestInit) =>
          new Response(stalledBody(options?.signal), { status: 401 }),
      ),
    );

    const request = requestJson("https://example.test/quota", { timeoutMs: 2000 });
    await vi.advanceTimersByTimeAsync(2000);
    const reply = await request;

    expect(reply).toMatchObject({
      ok: false,
      failure: { kind: "http", code: "login_expired", status: 401, detail: "" },
    });
  });

  it("keeps the status and Retry-After of a 429 larger than the cap", async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
    answer(
      new Response("{}", {
        status: 429,
        headers: { "content-length": "20", "Retry-After": "45" },
      }),
    );

    const reply = await requestJson("https://example.test/quota", { maxBytes: 10 });

    expect(reply).toMatchObject({
      ok: false,
      failure: {
        kind: "http",
        code: "rate_limited",
        status: 429,
        retryAtMs: 1_045_000,
        detail: "",
      },
    });
  });

  it("still reads a non-2xx body's words when the body arrives", async () => {
    answer(new Response("account not subscribed", { status: 403 }));

    const reply = await requestJson("https://example.test/quota");
    if (reply.ok) throw new Error("expected a failure");

    expect(reply.failure).toMatchObject({ kind: "http", status: 403 });
    expect(providerError(reply.failure.detail, failureFacts(reply.failure)).code).toBe("no_plan");
  });
});

describe("errorWords", () => {
  it.each([
    ["Service Unavailable", ": Service Unavailable"],
    ["", ""],
    ["  ", ""],
  ])("adds the reply's words %j after a colon only when there are some", (words, suffix) => {
    expect(errorWords(words)).toBe(suffix);
  });
});

describe("parseRetryAfterMs", () => {
  const NOW_MS = Date.parse("2026-10-10T12:00:00.000Z");
  const DAY_MS = 24 * 60 * 60_000;

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([
    ["seconds", "120", 120_000],
    ["fractional seconds", "1.5", 1_500],
    ["a huge number of seconds, capped at a day", "99999999999", DAY_MS],
    ["an HTTP date ahead", "Sat, 10 Oct 2026 12:01:30 GMT", 90_000],
    ["an HTTP date days ahead, capped at a day", "Tue, 13 Oct 2026 12:00:00 GMT", DAY_MS],
    ["an HTTP date in the past", "Fri, 09 Oct 2026 12:00:00 GMT", undefined],
    ["zero", "0", undefined],
    ["a negative number", "-5", undefined],
    ["garbage", "soon", undefined],
    ["digits too long to be a number", "9".repeat(400), undefined],
    ["blank", "  ", undefined],
    ["no header", null, undefined],
  ])("reads %s", (_name, value, expected) => {
    expect(parseRetryAfterMs(value, NOW_MS)).toBe(expected);
  });

  it("shows a huge Retry-After as a wait of at most a day", async () => {
    vi.useFakeTimers({ now: NOW_MS, toFake: ["Date"] });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response("", { status: 429, headers: { "Retry-After": "99999999999" } }),
      ),
    );

    const reply = await requestJson("https://example.test/quota");
    if (reply.ok) throw new Error("expected a failure");
    const error = providerError("HTTP 429", failureFacts(reply.failure), NOW_MS);

    expect(error).toMatchObject({ code: "rate_limited", retryAtMs: NOW_MS + DAY_MS });
    expect(describeError(error, "Kimi", NOW_MS)).toBe("Rate limited, retry in 24h");
  });
});
