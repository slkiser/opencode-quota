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
  resolveOpenRouterApiKey: vi.fn(),
}));

async function mockResolvedKey(
  overrides: Partial<{
    key: string;
    source: string;
    checkedPaths: string[];
    authPaths: string[];
  }> = {},
): Promise<void> {
  const { resolveOpenRouterApiKey } = await import("../src/lib/openrouter.js");
  vi.mocked(resolveOpenRouterApiKey).mockResolvedValue({
    key: overrides.key,
    source: overrides.source ?? null,
    checkedPaths: overrides.checkedPaths ?? [],
    authPaths: overrides.authPaths ?? [],
  });
}

describe("OpenRouter provider", () => {
  it("returns attempted:false when not configured", async () => {
    const { queryOpenRouterQuota } = await import("../src/lib/openrouter.js");
    await mockResolvedKey({ source: null, checkedPaths: ["/tmp/opencode.json"] });
    vi.mocked(queryOpenRouterQuota).mockResolvedValueOnce(null);

    const out = await openRouterProvider.fetch({} as any);
    expectNotAttempted(out);
    expect(out.statusDetails).toEqual([
      { key: "api_key_configured", value: "false" },
      { key: "api_key_source", value: "(none)" },
      { key: "api_key_checked_paths", value: "/tmp/opencode.json" },
      { key: "api_key_auth_paths", value: "(none)" },
    ]);
  });

  it("returns mapped budget data and forwards the timeout", async () => {
    const { queryOpenRouterQuota } = await import("../src/lib/openrouter.js");
    await mockResolvedKey({
      key: "sk-or-test",
      source: "env",
      checkedPaths: ["env:OPENROUTER_API_KEY"],
      authPaths: ["/tmp/auth.json"],
    });
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
    expect(out.statusDetails).toEqual([
      { key: "api_key_configured", value: "true" },
      { key: "api_key_source", value: "env" },
      { key: "api_key_checked_paths", value: "env:OPENROUTER_API_KEY" },
      { key: "api_key_auth_paths", value: "/tmp/auth.json" },
    ]);
    expect(queryOpenRouterQuota).toHaveBeenCalledWith({ requestTimeoutMs: 3210 });
  });

  it("maps auth failures to a safe provider error", async () => {
    const { queryOpenRouterQuota } = await import("../src/lib/openrouter.js");
    await mockResolvedKey({
      key: "sk-or-test",
      source: "auth.json",
      checkedPaths: ["env:OPENROUTER_API_KEY", "/tmp/opencode.json"],
      authPaths: ["/tmp/auth.json"],
    });
    vi.mocked(queryOpenRouterQuota).mockResolvedValueOnce({
      success: false,
      error: "HTTP 401",
    });

    const out = await openRouterProvider.fetch({} as any);
    expectAttemptedWithErrorLabel(out, "OpenRouter");
    expect(out.statusDetails).toEqual([
      { key: "api_key_configured", value: "true" },
      { key: "api_key_source", value: "auth.json" },
      { key: "api_key_checked_paths", value: "env:OPENROUTER_API_KEY | /tmp/opencode.json" },
      { key: "api_key_auth_paths", value: "/tmp/auth.json" },
    ]);
  });

  it("auto-detects a trusted key and matches OpenRouter models", async () => {
    const { hasOpenRouterApiKeyConfigured } = await import("../src/lib/openrouter.js");
    vi.mocked(hasOpenRouterApiKeyConfigured).mockResolvedValueOnce(true);

    await expect(openRouterProvider.isAvailable({} as any)).resolves.toBe(true);
    expect(openRouterProvider.matchesCurrentModel?.("openrouter/anthropic/claude")).toBe(true);
    expect(openRouterProvider.matchesCurrentModel?.("openai/gpt-5")).toBe(false);
  });
});
