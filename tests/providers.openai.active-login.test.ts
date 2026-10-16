// The OpenAI provider through the real credential reader; only the network is faked.
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { rowsFromProviderResult } from "../src/core/rows.js";
import {
  bindCredentialSource,
  createIntegrationCredentialSource,
  notifyCredentialsChanged,
} from "../src/lib/opencode-auth.js";
import { openaiProvider } from "../src/providers/openai.js";
import { createFakeIntegration } from "./helpers/fake-integration.js";

let unbind: (() => void) | undefined;

/**
 * `list()` shows the `openai` integration with no connections, yet
 * `connection.active("openai")` still returns a valid OAuth sign-in.
 */
function bindActiveLoginMissingFromList() {
  const integration = createFakeIntegration([
    {
      integrationId: "openai",
      id: "cred_active",
      label: "default",
      registered: true,
      method: "oauth",
      value: { type: "oauth", access: "a.b.c", refresh: "r", expires: Date.now() + 3_600_000 },
    },
  ]);
  integration.list.mockResolvedValue({
    location: { directory: "/tmp/opencode-quota-fake-location" },
    data: [{ id: "openai", name: "openai", methods: [], connections: [] }],
  } as never);
  unbind = bindCredentialSource(createIntegrationCredentialSource(integration as never));
}

afterEach(() => {
  unbind?.();
  notifyCredentialsChanged();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("openai provider with an empty connection list", () => {
  it("queries the active sign-in OpenCode still reports", async () => {
    bindActiveLoginMissingFromList();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: 20,
                limit_window_seconds: 18_000,
                reset_after_seconds: 60,
              },
            },
          }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const fetched = rowsFromProviderResult(
      "openai",
      await openaiProvider.fetch({ config: {} } as never),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://chatgpt.com/backend-api/wham/usage",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer a.b.c" }),
      }),
    );
    expect(fetched.error).toBeUndefined();
    expect(fetched.rows).toEqual([
      expect.objectContaining({
        id: "openai.five_hour",
        account: "Plus",
        percentRemaining: 80,
        windowStartedAt: expect.any(String),
      }),
    ]);
  });

  it("forwards requestTimeoutMs to that request", async () => {
    vi.useFakeTimers();
    bindActiveLoginMissingFromList();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ),
    );

    const pending = openaiProvider.fetch({ config: { requestTimeoutMs: 12_000 } } as never);
    await vi.advanceTimersByTimeAsync(12_000);
    const fetched = rowsFromProviderResult("openai", await pending);

    expect(fetched).toMatchObject({ rows: [], error: { code: "timeout" } });
    expect(fetched.debug).toContainEqual({
      key: "error",
      value: "OpenAI: Request timeout after 12s",
    });
  });
});
