import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  readAuthFileCached: vi.fn(),
}));

vi.mock("../src/lib/opencode-auth.js", () => ({
  readAuthFileCached: authMocks.readAuthFileCached,
  getCredentialDatabasePaths: () => ["/test/opencode.db"],
}));
vi.mock("../src/lib/api-key-resolver.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api-key-resolver.js")>()),
  getGlobalOpencodeConfigCandidatePaths: () => [],
}));

import {
  resolveKimiCnAuth,
  resolveKimiCnAuthWithDiagnosticsCached,
  resolveKimiGlobalAuth,
  resolveKimiGlobalAuthWithDiagnosticsCached,
} from "../src/lib/kimi-auth.js";

describe("Kimi regional auth", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    for (const name of [
      "KIMI_GLOBAL_API_KEY",
      "KIMI_CN_API_KEY",
      "KIMI_API_KEY",
      "KIMI_CODE_API_KEY",
    ]) {
      delete process.env[name];
    }
    authMocks.readAuthFileCached.mockReset().mockResolvedValue(null);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("maps legacy database aliases exclusively to CN", () => {
    const auth = { kimi: { type: "api", key: "legacy-cn" } };
    expect(resolveKimiCnAuth(auth)).toEqual({
      state: "configured",
      apiKey: "legacy-cn",
      endpoint: "cn",
    });
    expect(resolveKimiGlobalAuth(auth)).toEqual({ state: "none" });
  });

  it("resolves independent regional credentials from the database with endpoint provenance", async () => {
    authMocks.readAuthFileCached.mockResolvedValue({
      "kimi-code-plan-global": { type: "api", key: "global-db" },
      "kimi-code-plan-cn": { type: "api", key: "cn-db" },
    });
    const global = await resolveKimiGlobalAuthWithDiagnosticsCached();
    const cn = await resolveKimiCnAuthWithDiagnosticsCached();
    expect(global.auth).toEqual({ state: "configured", apiKey: "global-db", endpoint: "global" });
    expect(cn.auth).toEqual({ state: "configured", apiKey: "cn-db", endpoint: "cn" });
    expect(global.diagnostics).toMatchObject({
      state: "configured",
      source: "opencode.db",
      endpoint: "global",
      credentialDatabasePaths: ["/test/opencode.db"],
    });
    expect(cn.diagnostics).toMatchObject({
      state: "configured",
      source: "opencode.db",
      endpoint: "cn",
    });
  });

  it("uses region-specific environment keys without crossing credentials", async () => {
    process.env.KIMI_GLOBAL_API_KEY = "global-env";
    process.env.KIMI_CN_API_KEY = "cn-env";
    const global = await resolveKimiGlobalAuthWithDiagnosticsCached();
    const cn = await resolveKimiCnAuthWithDiagnosticsCached();
    expect(global.auth).toEqual({ state: "configured", apiKey: "global-env", endpoint: "global" });
    expect(cn.auth).toEqual({ state: "configured", apiKey: "cn-env", endpoint: "cn" });
    expect(global.diagnostics).toMatchObject({
      source: "env:KIMI_GLOBAL_API_KEY",
      endpoint: "global",
    });
    expect(cn.diagnostics).toMatchObject({ source: "env:KIMI_CN_API_KEY", endpoint: "cn" });
    expect(authMocks.readAuthFileCached).not.toHaveBeenCalled();
  });
});
