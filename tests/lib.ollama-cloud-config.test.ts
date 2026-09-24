import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: null as Record<string, unknown> | null,
  resolve: vi.fn(),
  has: vi.fn(),
  diagnostics: vi.fn(),
  getGlobalOpencodeConfigCandidatePaths: vi.fn(() => [
    { path: "/trusted/opencode.jsonc", isJsonc: true },
    { path: "/trusted/opencode.json", isJsonc: false },
  ]),
  getCredentialDatabasePaths: vi.fn(() => ["/trusted/opencode.db"]),
  readAuthFile: vi.fn(),
}));

vi.mock("../src/lib/api-key-resolver.js", () => ({
  createProviderApiKeyResolver: vi.fn((config: Record<string, unknown>) => {
    mocks.config = config;
    return {
      resolve: mocks.resolve,
      has: mocks.has,
      diagnostics: mocks.diagnostics,
    };
  }),
  getGlobalOpencodeConfigCandidatePaths: mocks.getGlobalOpencodeConfigCandidatePaths,
}));

vi.mock("../src/lib/opencode-auth.js", () => ({
  getCredentialDatabasePaths: mocks.getCredentialDatabasePaths,
  readAuthFile: mocks.readAuthFile,
}));

import {
  getOllamaCloudKeyDiagnostics,
  getOpencodeConfigCandidatePaths,
  hasOllamaCloudApiKey,
  resolveOllamaCloudApiKey,
} from "../src/lib/ollama-cloud-config.js";

describe("ollama-cloud API key config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses only the documented API key and trusted Ollama Cloud sources", () => {
    expect(mocks.config).toMatchObject({
      envVars: [{ name: "OLLAMA_API_KEY", source: "env:OLLAMA_API_KEY" }],
      providerKeys: ["ollama-cloud"],
      allowedEnvVars: ["OLLAMA_API_KEY"],
      configJsonSource: "opencode.json",
      configJsoncSource: "opencode.jsonc",
      getConfigCandidates: mocks.getGlobalOpencodeConfigCandidatePaths,
      auth: {
        readAuth: mocks.readAuthFile,
        getCredentialDatabasePaths: mocks.getCredentialDatabasePaths,
        authSource: "opencode.db",
      },
    });
    expect(JSON.stringify(mocks.config)).not.toContain("OLLAMA_USAGE_COOKIE");
    expect(JSON.stringify(mocks.config)).not.toContain("ollama-usage");
    expect(getOpencodeConfigCandidatePaths()).toEqual([
      { path: "/trusted/opencode.jsonc", isJsonc: true },
      { path: "/trusted/opencode.json", isJsonc: false },
    ]);
  });

  it("delegates resolution, availability, and safe diagnostics to the shared resolver", async () => {
    const resolved = { key: "secret-key", source: "env:OLLAMA_API_KEY" } as const;
    const diagnostics = {
      configured: true,
      source: "env:OLLAMA_API_KEY" as const,
      checkedPaths: ["env:OLLAMA_API_KEY"],
      credentialDatabasePaths: ["/trusted/opencode.db"],
    };
    mocks.resolve.mockResolvedValueOnce(resolved);
    mocks.has.mockResolvedValueOnce(true);
    mocks.diagnostics.mockResolvedValueOnce(diagnostics);

    await expect(resolveOllamaCloudApiKey()).resolves.toEqual(resolved);
    await expect(hasOllamaCloudApiKey()).resolves.toBe(true);
    await expect(getOllamaCloudKeyDiagnostics()).resolves.toEqual(diagnostics);
  });
});
