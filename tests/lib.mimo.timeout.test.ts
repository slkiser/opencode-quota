import { afterEach, describe, expect, it, vi } from "vitest";

import { queryMimoDashboard } from "../src/lib/mimo.js";

const cookie = "api-platform_serviceToken=service-secret; userId=user-secret";

function jsonResponse(value: unknown): Response {
  return Response.json(value);
}

describe("MiMo end-to-end body timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("cancels and releases a stalled reader while preserving sanitized partial success", async () => {
    vi.useFakeTimers();
    const cancel = vi.spyOn(ReadableStreamDefaultReader.prototype, "cancel");
    const releaseLock = vi.spyOn(ReadableStreamDefaultReader.prototype, "releaseLock");

    vi.stubGlobal(
      "fetch",
      vi.fn((url: string | URL | Request, init?: RequestInit) => {
        const endpoint = String(url);
        if (endpoint.endsWith("/tokenPlan/usage")) {
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              init?.signal?.addEventListener("abort", () => {
                controller.error(new Error(`stalled body exposed ${cookie}`));
              });
            },
          });
          return Promise.resolve(new Response(body));
        }
        if (endpoint.endsWith("/tokenPlan/detail")) {
          return Promise.resolve(
            jsonResponse({
              code: 0,
              data: { planName: "Standard", planCode: "standard_monthly", expired: false },
            }),
          );
        }
        return Promise.resolve(
          jsonResponse({
            code: 0,
            data: {
              balance: "50.00",
              cashBalance: "30.00",
              giftBalance: "20.00",
              currency: "USD",
            },
          }),
        );
      }),
    );

    const pending = queryMimoDashboard(cookie, { requestTimeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    await vi.advanceTimersByTimeAsync(0);

    expect(result).toEqual({
      usage: {
        state: "error",
        error: "Xiaomi MiMo usage request failed: Request timeout after 1s",
      },
      detail: {
        state: "success",
        data: {
          planName: "Standard",
          planCode: "standard_monthly",
          expired: false,
        },
      },
      balance: {
        state: "success",
        data: {
          total: 50,
          cash: 30,
          gift: 20,
          currency: "USD",
        },
      },
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(3);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(cookie);
    expect(serialized).not.toContain("service-secret");
    expect(serialized).not.toContain("user-secret");
    expect(serialized).not.toContain("stalled body exposed");
  });
});
