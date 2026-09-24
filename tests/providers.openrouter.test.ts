import { describe, expect, it, vi } from "vitest";

import type { QuotaProviderAuthResolution } from "../src/lib/quota-providers-remote.js";
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

const SECRET_CANARY = "sk-or-secret-canary";

async function mockResolvedKey(
  overrides: Partial<QuotaProviderAuthResolution> = {},
): Promise<QuotaProviderAuthResolution> {
  const { resolveOpenRouterApiKey } = await import("../src/lib/openrouter.js");
  const resolved: QuotaProviderAuthResolution = {
    source: null,
    checkedPaths: [],
    credentialDatabasePaths: [],
    ...overrides,
  };
  vi.mocked(resolveOpenRouterApiKey).mockResolvedValue(resolved);
  return resolved;
}

function expectedStatusDetails(resolved: QuotaProviderAuthResolution) {
  return [
    { key: "api_key_configured", value: resolved.key ? "true" : "false" },
    { key: "api_key_source", value: resolved.source ?? "(none)" },
    {
      key: "api_key_checked_paths",
      value: resolved.checkedPaths.join(" | ") || "(none)",
    },
    {
      key: "api_key_credential_database_paths",
      value: resolved.credentialDatabasePaths.join(" | ") || "(none)",
    },
  ];
}

describe("OpenRouter provider", () => {
  it("returns attempted:false when not configured and still passes the no-key resolution", async () => {
    const { queryOpenRouterQuota, resolveOpenRouterApiKey } = await import(
      "../src/lib/openrouter.js"
    );
    const resolved = await mockResolvedKey({
      source: null,
      checkedPaths: ["env:OPENROUTER_API_KEY", "/tmp/opencode.json"],
      credentialDatabasePaths: ["/tmp/opencode.db"],
    });
    vi.mocked(queryOpenRouterQuota).mockResolvedValueOnce(null);

    const out = await openRouterProvider.fetch({} as any);
    expectNotAttempted(out);
    expect(out.statusDetails).toEqual(expectedStatusDetails(resolved));
    expect(JSON.stringify(out)).not.toContain(SECRET_CANARY);
    expect(resolveOpenRouterApiKey).toHaveBeenCalledTimes(1);
    expect(queryOpenRouterQuota).toHaveBeenCalledTimes(1);
    expect(queryOpenRouterQuota).toHaveBeenCalledWith({
      requestTimeoutMs: undefined,
      resolved,
    });
  });

  it.each([
    ["env", "env:OPENROUTER_API_KEY"],
    ["opencode.json", "/tmp/opencode.json"],
    ["opencode.jsonc", "/tmp/opencode.jsonc"],
    ["opencode.db", "/tmp/opencode.db"],
  ] as const)("attaches safe %s key diagnostics and forwards that resolution", async (source, path) => {
    const { queryOpenRouterQuota } = await import("../src/lib/openrouter.js");
    const resolved = await mockResolvedKey({
      key: SECRET_CANARY,
      source,
      checkedPaths: [path],
      credentialDatabasePaths: ["/tmp/opencode.db"],
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
    expect(out.statusDetails).toEqual(expectedStatusDetails(resolved));
    expect(JSON.stringify(out)).not.toContain(SECRET_CANARY);
    expect(queryOpenRouterQuota).toHaveBeenCalledTimes(1);
    expect(queryOpenRouterQuota).toHaveBeenCalledWith({
      requestTimeoutMs: 3210,
      resolved,
    });
  });

  it.each([
    ["HTTP", "HTTP 401"],
    ["malformed", "Invalid openrouter-key-v1 response"],
    ["timeout", "Request timeout after 0s"],
    ["redirect", "Redirect rejected"],
    ["body-limit", "Response exceeded 262144 bytes"],
  ] as const)("maps %s failures to a safe provider error", async (_name, error) => {
    const { queryOpenRouterQuota } = await import("../src/lib/openrouter.js");
    const resolved = await mockResolvedKey({
      key: SECRET_CANARY,
      source: "opencode.db",
      checkedPaths: ["env:OPENROUTER_API_KEY", "/tmp/opencode.json"],
      credentialDatabasePaths: ["/tmp/opencode.db"],
    });
    vi.mocked(queryOpenRouterQuota).mockResolvedValueOnce({
      success: false,
      error,
    });

    const out = await openRouterProvider.fetch({} as any);
    expectAttemptedWithErrorLabel(out, "OpenRouter");
    expect(out.errors[0]?.message).toBe(error);
    expect(out.statusDetails).toEqual(expectedStatusDetails(resolved));
    expect(JSON.stringify(out)).not.toContain(SECRET_CANARY);
    expect(queryOpenRouterQuota).toHaveBeenCalledTimes(1);
    expect(queryOpenRouterQuota).toHaveBeenCalledWith({
      requestTimeoutMs: undefined,
      resolved,
    });
  });

  it("auto-detects a trusted key and matches OpenRouter models", async () => {
    const { hasOpenRouterApiKeyConfigured } = await import("../src/lib/openrouter.js");
    vi.mocked(hasOpenRouterApiKeyConfigured).mockResolvedValueOnce(true);

    await expect(openRouterProvider.isAvailable({} as any)).resolves.toBe(true);
    expect(openRouterProvider.matchesCurrentModel?.("openrouter/anthropic/claude")).toBe(true);
    expect(openRouterProvider.matchesCurrentModel?.("openai/gpt-5")).toBe(false);
  });
});
