import { afterEach, describe, expect, it, vi } from "vitest";

import {
  hasOpenRouterApiKeyConfigured,
  queryOpenRouterQuota,
  resolveOpenRouterApiKey,
  resolveOpenRouterAuthIdentity,
} from "../src/lib/openrouter.js";
import {
  fetchRemoteQuotaProvider,
  type QuotaProviderAuthResolution,
  type QuotaProviderAuthSource,
  resolveQuotaProviderApiKey,
} from "../src/lib/quota-providers-remote.js";
import { deriveResolvedAuthIdentity } from "../src/lib/resolved-auth-identity.js";

vi.mock("../src/lib/quota-providers-remote.js", () => ({
  fetchRemoteQuotaProvider: vi.fn(),
  resolveQuotaProviderApiKey: vi.fn(),
}));

vi.mock("../src/lib/resolved-auth-identity.js", () => ({
  deriveResolvedAuthIdentity: vi.fn(async () => `rai1_${"a".repeat(43)}`),
}));

const OPENROUTER_KEY_SOURCE = {
  id: "openrouter",
  providerId: "openrouter",
  label: "OpenRouter",
  mode: "remote-api",
  url: "https://openrouter.ai/api/v1/key",
  apiKeyEnv: "OPENROUTER_API_KEY",
  format: "openrouter-key-v1",
} as const;

const SECRET_CANARY = "openrouter-secret-canary";
const CREDENTIAL_SOURCES: QuotaProviderAuthSource[] = [
  "env",
  "opencode.json",
  "opencode.jsonc",
  "opencode.db",
];

function resolvedAuth(
  overrides: Partial<QuotaProviderAuthResolution> = {},
): QuotaProviderAuthResolution {
  return {
    source: null,
    checkedPaths: [],
    credentialDatabasePaths: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("OpenRouter quota", () => {
  it("derives cache identity from the winning trusted key without exposing it", async () => {
    vi.mocked(resolveQuotaProviderApiKey).mockResolvedValueOnce({
      key: SECRET_CANARY,
      source: "env",
      checkedPaths: [],
      credentialDatabasePaths: [],
    });

    const identity = await resolveOpenRouterAuthIdentity();

    expect(deriveResolvedAuthIdentity).toHaveBeenCalledWith({
      providerId: "openrouter",
      principal: { kind: "credential", value: SECRET_CANARY },
    });
    expect(identity).not.toContain(SECRET_CANARY);
  });

  it("uses the standard OpenRouter credential sources and key endpoint", async () => {
    await resolveOpenRouterApiKey();

    expect(resolveQuotaProviderApiKey).toHaveBeenCalledWith(OPENROUTER_KEY_SOURCE);
  });

  it.each(
    CREDENTIAL_SOURCES,
  )("queries with the exact %s resolution and does not look up credentials again", async (source) => {
    const resolved = resolvedAuth({
      key: SECRET_CANARY,
      source,
      checkedPaths: [`source:${source}`],
      credentialDatabasePaths: ["/tmp/opencode.db"],
    });
    vi.mocked(fetchRemoteQuotaProvider).mockResolvedValueOnce({
      success: true,
      entries: [],
    });

    await queryOpenRouterQuota({ requestTimeoutMs: 1234, resolved });

    expect(resolveQuotaProviderApiKey).not.toHaveBeenCalled();
    expect(fetchRemoteQuotaProvider).toHaveBeenCalledTimes(1);
    expect(fetchRemoteQuotaProvider).toHaveBeenCalledWith(
      OPENROUTER_KEY_SOURCE,
      SECRET_CANARY,
      1234,
    );
  });

  it("does not make a request when the passed resolution has no key", async () => {
    const resolved = resolvedAuth({
      source: null,
      checkedPaths: ["env:OPENROUTER_API_KEY", "/tmp/opencode.json"],
      credentialDatabasePaths: ["/tmp/opencode.db"],
    });

    await expect(queryOpenRouterQuota({ resolved })).resolves.toBeNull();
    expect(resolveQuotaProviderApiKey).not.toHaveBeenCalled();
    expect(fetchRemoteQuotaProvider).not.toHaveBeenCalled();
  });

  it("does not make a request when no trusted key exists", async () => {
    vi.mocked(resolveQuotaProviderApiKey).mockResolvedValue({
      source: null,
      checkedPaths: [],
      credentialDatabasePaths: [],
    });

    await expect(hasOpenRouterApiKeyConfigured()).resolves.toBe(false);
    await expect(resolveOpenRouterApiKey()).resolves.toEqual({
      source: null,
      checkedPaths: [],
      credentialDatabasePaths: [],
    });
    expect(fetchRemoteQuotaProvider).not.toHaveBeenCalled();
  });

  it("marks reused OpenRouter mapping entries as maintained", async () => {
    vi.mocked(fetchRemoteQuotaProvider).mockResolvedValue({
      success: true,
      entries: [
        {
          accounting: {
            resultType: "budget",
            acquisitionMethod: "remote_api",
            ownership: "user_configured",
            authority: "provider_reported",
          },
          name: "OpenRouter budget",
          percentRemaining: 80,
        },
      ],
    });

    await expect(
      queryOpenRouterQuota({
        resolved: resolvedAuth({ key: "secret", source: "env" }),
      }),
    ).resolves.toEqual({
      success: true,
      entries: [
        expect.objectContaining({
          accounting: expect.objectContaining({ ownership: "maintained" }),
        }),
      ],
    });
  });

  it.each([
    ["HTTP", "HTTP 401"],
    ["malformed", "Invalid openrouter-key-v1 response"],
    ["timeout", "Request timeout after 0s"],
    ["redirect", "Redirect rejected"],
    ["body-limit", "Response exceeded 262144 bytes"],
  ] as const)("returns the safe %s remote error unchanged", async (_name, error) => {
    vi.mocked(fetchRemoteQuotaProvider).mockResolvedValue({
      success: false,
      error,
    });

    const result = await queryOpenRouterQuota({
      resolved: resolvedAuth({ key: SECRET_CANARY, source: "env" }),
    });
    expect(result).toEqual({ success: false, error });
    expect(JSON.stringify(result)).not.toContain(SECRET_CANARY);
    expect(fetchRemoteQuotaProvider).toHaveBeenCalledTimes(1);
    expect(resolveQuotaProviderApiKey).not.toHaveBeenCalled();
  });
});
