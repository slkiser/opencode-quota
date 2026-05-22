import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtimePathMocks = vi.hoisted(() => ({
  getOpencodeRuntimeDirCandidates: vi.fn(),
}));

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirCandidates: runtimePathMocks.getOpencodeRuntimeDirCandidates,
}));

const tempRoots: string[] = [];
const originalEnv = process.env;

function getConfigPath(configDir: string): string {
  return join(configDir, "opencode-quota", "anthropic-enterprise.json");
}

async function createConfigDirs(): Promise<[string, string]> {
  const root = await mkdtemp(join(tmpdir(), "anthropic-enterprise-config-"));
  tempRoots.push(root);

  const primaryDir = join(root, "config-primary");
  const fallbackDir = join(root, "config-fallback");

  await mkdir(join(primaryDir, "opencode-quota"), { recursive: true });
  await mkdir(join(fallbackDir, "opencode-quota"), { recursive: true });

  return [primaryDir, fallbackDir];
}

describe("anthropic-enterprise config resolution", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.ANTHROPIC_ENTERPRISE_ORG_ID;
    delete process.env.ANTHROPIC_ENTERPRISE_SESSION_KEY;
    delete process.env.ANTHROPIC_ENTERPRISE_ACCOUNT_ID;
  });

  afterEach(async () => {
    process.env = originalEnv;
    for (const root of tempRoots.splice(0, tempRoots.length)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns none when no env vars and no config file", async () => {
    const [primaryDir] = await createConfigDirs();
    runtimePathMocks.getOpencodeRuntimeDirCandidates.mockReturnValue({
      configDirs: [primaryDir],
    });

    const { resolveAnthropicEnterpriseConfig } = await import(
      "../src/lib/anthropic-enterprise-config.js"
    );
    await expect(resolveAnthropicEnterpriseConfig()).resolves.toEqual({ state: "none" });
  });

  it("resolves from env vars when both required vars are set", async () => {
    process.env.ANTHROPIC_ENTERPRISE_ORG_ID = "org-uuid-123";
    process.env.ANTHROPIC_ENTERPRISE_SESSION_KEY = "sk-session-abc";

    const { resolveAnthropicEnterpriseConfig } = await import(
      "../src/lib/anthropic-enterprise-config.js"
    );
    await expect(resolveAnthropicEnterpriseConfig()).resolves.toEqual({
      state: "configured",
      config: { orgId: "org-uuid-123", sessionKey: "sk-session-abc", accountId: undefined },
      source: "environment",
    });
  });

  it("includes accountId from env when set", async () => {
    process.env.ANTHROPIC_ENTERPRISE_ORG_ID = "org-uuid-123";
    process.env.ANTHROPIC_ENTERPRISE_SESSION_KEY = "sk-session-abc";
    process.env.ANTHROPIC_ENTERPRISE_ACCOUNT_ID = "acct-uuid-456";

    const { resolveAnthropicEnterpriseConfig } = await import(
      "../src/lib/anthropic-enterprise-config.js"
    );
    await expect(resolveAnthropicEnterpriseConfig()).resolves.toEqual({
      state: "configured",
      config: {
        orgId: "org-uuid-123",
        sessionKey: "sk-session-abc",
        accountId: "acct-uuid-456",
      },
      source: "environment",
    });
  });

  it("returns incomplete when only ORG_ID env var is set", async () => {
    process.env.ANTHROPIC_ENTERPRISE_ORG_ID = "org-uuid-123";

    const { resolveAnthropicEnterpriseConfig } = await import(
      "../src/lib/anthropic-enterprise-config.js"
    );
    await expect(resolveAnthropicEnterpriseConfig()).resolves.toEqual({
      state: "incomplete",
      source: "environment",
      missing: "ANTHROPIC_ENTERPRISE_SESSION_KEY",
    });
  });

  it("returns incomplete when only SESSION_KEY env var is set", async () => {
    process.env.ANTHROPIC_ENTERPRISE_SESSION_KEY = "sk-session-abc";

    const { resolveAnthropicEnterpriseConfig } = await import(
      "../src/lib/anthropic-enterprise-config.js"
    );
    await expect(resolveAnthropicEnterpriseConfig()).resolves.toEqual({
      state: "incomplete",
      source: "environment",
      missing: "ANTHROPIC_ENTERPRISE_ORG_ID",
    });
  });

  it("resolves from config file when env vars are absent", async () => {
    const [primaryDir] = await createConfigDirs();
    const configPath = getConfigPath(primaryDir);

    runtimePathMocks.getOpencodeRuntimeDirCandidates.mockReturnValue({
      configDirs: [primaryDir],
    });

    await writeFile(
      configPath,
      JSON.stringify({ orgId: "org-from-file", sessionKey: "sk-from-file" }),
    );

    const { resolveAnthropicEnterpriseConfig } = await import(
      "../src/lib/anthropic-enterprise-config.js"
    );
    await expect(resolveAnthropicEnterpriseConfig()).resolves.toEqual({
      state: "configured",
      config: { orgId: "org-from-file", sessionKey: "sk-from-file", accountId: undefined },
      source: configPath,
    });
  });

  it("includes accountId from config file when set", async () => {
    const [primaryDir] = await createConfigDirs();
    const configPath = getConfigPath(primaryDir);

    runtimePathMocks.getOpencodeRuntimeDirCandidates.mockReturnValue({
      configDirs: [primaryDir],
    });

    await writeFile(
      configPath,
      JSON.stringify({
        orgId: "org-from-file",
        sessionKey: "sk-from-file",
        accountId: "acct-from-file",
      }),
    );

    const { resolveAnthropicEnterpriseConfig } = await import(
      "../src/lib/anthropic-enterprise-config.js"
    );
    await expect(resolveAnthropicEnterpriseConfig()).resolves.toEqual({
      state: "configured",
      config: {
        orgId: "org-from-file",
        sessionKey: "sk-from-file",
        accountId: "acct-from-file",
      },
      source: configPath,
    });
  });

  it("returns incomplete from config file when sessionKey is missing", async () => {
    const [primaryDir] = await createConfigDirs();
    const configPath = getConfigPath(primaryDir);

    runtimePathMocks.getOpencodeRuntimeDirCandidates.mockReturnValue({
      configDirs: [primaryDir],
    });

    await writeFile(configPath, JSON.stringify({ orgId: "org-from-file" }));

    const { resolveAnthropicEnterpriseConfig } = await import(
      "../src/lib/anthropic-enterprise-config.js"
    );
    await expect(resolveAnthropicEnterpriseConfig()).resolves.toEqual({
      state: "incomplete",
      source: configPath,
      missing: "sessionKey",
    });
  });

  it("returns invalid when config file contains non-object JSON", async () => {
    const [primaryDir] = await createConfigDirs();
    const configPath = getConfigPath(primaryDir);

    runtimePathMocks.getOpencodeRuntimeDirCandidates.mockReturnValue({
      configDirs: [primaryDir],
    });

    await writeFile(configPath, "[]");

    const { resolveAnthropicEnterpriseConfig } = await import(
      "../src/lib/anthropic-enterprise-config.js"
    );
    await expect(resolveAnthropicEnterpriseConfig()).resolves.toEqual({
      state: "invalid",
      source: configPath,
      error: "Config file must contain a JSON object",
    });
  });

  it("returns invalid when config file contains malformed JSON", async () => {
    const [primaryDir] = await createConfigDirs();
    const configPath = getConfigPath(primaryDir);

    runtimePathMocks.getOpencodeRuntimeDirCandidates.mockReturnValue({
      configDirs: [primaryDir],
    });

    await writeFile(configPath, "{bad json");

    const { resolveAnthropicEnterpriseConfig } = await import(
      "../src/lib/anthropic-enterprise-config.js"
    );
    const result = await resolveAnthropicEnterpriseConfig();
    expect(result.state).toBe("invalid");
    if (result.state === "invalid") {
      expect(result.error).toContain("Failed to parse JSON:");
    }
  });

  it("falls through to fallback config dir when primary is missing", async () => {
    const [primaryDir, fallbackDir] = await createConfigDirs();
    const fallbackPath = getConfigPath(fallbackDir);

    runtimePathMocks.getOpencodeRuntimeDirCandidates.mockReturnValue({
      configDirs: [primaryDir, fallbackDir],
    });

    // No file in primaryDir, but fallback has one
    await writeFile(
      fallbackPath,
      JSON.stringify({ orgId: "org-fallback", sessionKey: "sk-fallback" }),
    );

    const { resolveAnthropicEnterpriseConfig } = await import(
      "../src/lib/anthropic-enterprise-config.js"
    );
    await expect(resolveAnthropicEnterpriseConfig()).resolves.toEqual({
      state: "configured",
      config: { orgId: "org-fallback", sessionKey: "sk-fallback", accountId: undefined },
      source: fallbackPath,
    });
  });

  it("stops at first invalid config file instead of falling through", async () => {
    const [primaryDir, fallbackDir] = await createConfigDirs();
    const primaryPath = getConfigPath(primaryDir);
    const fallbackPath = getConfigPath(fallbackDir);

    runtimePathMocks.getOpencodeRuntimeDirCandidates.mockReturnValue({
      configDirs: [primaryDir, fallbackDir],
    });

    await writeFile(primaryPath, "[]");
    await writeFile(
      fallbackPath,
      JSON.stringify({ orgId: "org-fallback", sessionKey: "sk-fallback" }),
    );

    const { resolveAnthropicEnterpriseConfig } = await import(
      "../src/lib/anthropic-enterprise-config.js"
    );
    await expect(resolveAnthropicEnterpriseConfig()).resolves.toEqual({
      state: "invalid",
      source: primaryPath,
      error: "Config file must contain a JSON object",
    });
  });

  it("env vars take precedence over config file", async () => {
    const [primaryDir] = await createConfigDirs();
    const configPath = getConfigPath(primaryDir);

    runtimePathMocks.getOpencodeRuntimeDirCandidates.mockReturnValue({
      configDirs: [primaryDir],
    });

    await writeFile(
      configPath,
      JSON.stringify({ orgId: "org-from-file", sessionKey: "sk-from-file" }),
    );

    process.env.ANTHROPIC_ENTERPRISE_ORG_ID = "org-from-env";
    process.env.ANTHROPIC_ENTERPRISE_SESSION_KEY = "sk-from-env";

    const { resolveAnthropicEnterpriseConfig } = await import(
      "../src/lib/anthropic-enterprise-config.js"
    );
    const result = await resolveAnthropicEnterpriseConfig();
    expect(result.state).toBe("configured");
    if (result.state === "configured") {
      expect(result.source).toBe("environment");
      expect(result.config.orgId).toBe("org-from-env");
    }
  });
});
