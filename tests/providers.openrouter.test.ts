import { describe, expect, it, vi } from "vitest";

import { openRouterProvider } from "../src/providers/openrouter.js";
import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
} from "./helpers/provider-assertions.js";

vi.mock("../src/lib/openrouter.js", () => ({
  hasOpenRouterApiKeyConfigured: vi.fn(),
  queryOpenRouterQuota: vi.fn(),
}));

describe("OpenRouter provider", () => {
  it("returns attempted:false when not configured", async () => {
    const { queryOpenRouterQuota } = await import("../src/lib/openrouter.js");
    vi.mocked(queryOpenRouterQuota).mockResolvedValueOnce(null);

    expectNotAttempted(await openRouterProvider.fetch({} as any));
  });

  it("returns mapped budget data and forwards the timeout", async () => {
    const { queryOpenRouterQuota } = await import("../src/lib/openrouter.js");
    vi.mocked(queryOpenRouterQuota).mockResolvedValueOnce({
      success: true,
      entries: [
        {
          accounting: {
            resultType: "budget",
            acquisitionMethod: "remote_api",
            ownership: "maintained",
            authority: "provider_reported",
          },
          name: "OpenRouter budget",
          group: "OpenRouter",
          label: "Budget:",
          percentRemaining: 80,
          right: "$2.00/$10.00",
        },
      ],
    });

    const out = await openRouterProvider.fetch({
      config: { requestTimeoutMs: 3210 },
    } as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries[0]).toEqual(expect.objectContaining({ percentRemaining: 80 }));
    expect(out.presentation).toEqual({ singleWindowShowRight: true });
    expect(queryOpenRouterQuota).toHaveBeenCalledWith({ requestTimeoutMs: 3210 });
  });

  it("maps auth failures to a safe provider error", async () => {
    const { queryOpenRouterQuota } = await import("../src/lib/openrouter.js");
    vi.mocked(queryOpenRouterQuota).mockResolvedValueOnce({
      success: false,
      error: "HTTP 401",
    });

    expectAttemptedWithErrorLabel(await openRouterProvider.fetch({} as any), "OpenRouter");
  });

  it("auto-detects a trusted key and matches OpenRouter models", async () => {
    const { hasOpenRouterApiKeyConfigured } = await import("../src/lib/openrouter.js");
    vi.mocked(hasOpenRouterApiKeyConfigured).mockResolvedValueOnce(true);

    await expect(openRouterProvider.isAvailable({} as any)).resolves.toBe(true);
    expect(openRouterProvider.matchesCurrentModel?.("openrouter/anthropic/claude")).toBe(true);
    expect(openRouterProvider.matchesCurrentModel?.("openai/gpt-5")).toBe(false);
  });
});
