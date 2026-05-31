import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  gatewayEnvVarName,
  getGatewayKeyDiagnostics,
  hasGatewayApiKey,
  resolveGatewayApiKey,
  resolveGatewayBaseURL,
} from "../src/lib/openai-compatible-config.js";

vi.mock("../src/lib/opencode-auth.js", () => ({
  readAuthFile: vi.fn(),
  getAuthPaths: vi.fn(() => []),
}));

describe("openai-compatible gateway config", () => {
  const originalEnv = process.env;
  const originalCwd = process.cwd();
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "oq-gw-"));
    process.env = { ...originalEnv, XDG_CONFIG_HOME: tempDir };
    process.chdir(tempDir);
    delete process.env.APIGEE_API_KEY;
    const { readAuthFile } = await import("../src/lib/opencode-auth.js");
    (readAuthFile as any).mockResolvedValue(null);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env = originalEnv;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("derives a conventional env var name from the provider id", () => {
    expect(gatewayEnvVarName("apigee")).toBe("APIGEE_API_KEY");
    expect(gatewayEnvVarName("my-gateway")).toBe("MY_GATEWAY_API_KEY");
    expect(gatewayEnvVarName("acme.llm")).toBe("ACME_LLM_API_KEY");
  });

  it("resolves the key from the gateway env var", async () => {
    process.env.APIGEE_API_KEY = "env-key";
    await expect(resolveGatewayApiKey("apigee")).resolves.toEqual({ key: "env-key", source: "env" });
  });

  it("resolves the key from trusted global OpenCode config", async () => {
    mkdirSync(join(tempDir, "opencode"), { recursive: true });
    writeFileSync(
      join(tempDir, "opencode", "opencode.json"),
      JSON.stringify({ provider: { apigee: { options: { apiKey: "config-key" } } } }),
    );
    await expect(resolveGatewayApiKey("apigee")).resolves.toEqual({
      key: "config-key",
      source: "opencode.json",
    });
  });

  it("returns no key when nothing is configured", async () => {
    await expect(hasGatewayApiKey("apigee")).resolves.toBe(false);
    await expect(resolveGatewayApiKey("apigee")).resolves.toBeNull();
  });

  it("baseURL: explicit override wins", async () => {
    await expect(resolveGatewayBaseURL("apigee", "https://gw/llm/v1")).resolves.toBe(
      "https://gw/llm/v1",
    );
  });

  it("baseURL: falls back to provider.<id>.options.baseURL from global config", async () => {
    mkdirSync(join(tempDir, "opencode"), { recursive: true });
    writeFileSync(
      join(tempDir, "opencode", "opencode.json"),
      JSON.stringify({ provider: { apigee: { options: { baseURL: "https://gw/llm/v1" } } } }),
    );
    await expect(resolveGatewayBaseURL("apigee")).resolves.toBe("https://gw/llm/v1");
  });

  it("baseURL: null when neither override nor config is present", async () => {
    await expect(resolveGatewayBaseURL("apigee")).resolves.toBeNull();
  });

  it("diagnostics: reports configured + source when a key resolves", async () => {
    process.env.APIGEE_API_KEY = "env-key";
    const diag = await getGatewayKeyDiagnostics("apigee");
    expect(diag.configured).toBe(true);
    expect(diag.source).toBe("env");
  });

  it("diagnostics: reports not-configured when no key is present", async () => {
    const diag = await getGatewayKeyDiagnostics("apigee");
    expect(diag.configured).toBe(false);
    expect(diag.source).toBeNull();
  });
});
