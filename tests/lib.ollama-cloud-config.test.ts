import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtimePathMocks = vi.hoisted(() => ({
  getOpencodeRuntimeDirCandidates: vi.fn(),
}));

const osMocks = vi.hoisted(() => ({
  homedir: vi.fn(() => process.env.HOME || ""),
}));

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirCandidates: runtimePathMocks.getOpencodeRuntimeDirCandidates,
}));

vi.mock("os", async () => {
  const actual = await vi.importActual<typeof import("os")>("os");
  return {
    ...actual,
    homedir: osMocks.homedir,
  };
});

const tempRoots: string[] = [];
const originalEnv = process.env;

async function createConfigRoot(): Promise<{
  root: string;
  opencodeConfigDir: string;
  xdgConfigDir: string;
  jsonPath: string;
  yamlPath: string;
  legacyYamlPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "ollama-cloud-config-"));
  tempRoots.push(root);

  const opencodeConfigDir = join(root, "opencode-config");
  const xdgConfigDir = join(root, "xdg-config");
  const jsonPath = join(opencodeConfigDir, "opencode-quota", "ollama-cloud.json");
  const yamlPath = join(xdgConfigDir, "ollama-usage", "config.yaml");
  const legacyYamlPath = join(root, ".ollama-usage", "config.yaml");

  await mkdir(join(opencodeConfigDir, "opencode-quota"), { recursive: true });
  await mkdir(join(xdgConfigDir, "ollama-usage"), { recursive: true });
  await mkdir(join(root, ".ollama-usage"), { recursive: true });

  return { root, opencodeConfigDir, xdgConfigDir, jsonPath, yamlPath, legacyYamlPath };
}

async function importConfigModule() {
  return import("../src/lib/ollama-cloud-config.js");
}

describe("ollama-cloud config resolution", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    osMocks.homedir.mockReturnValue(originalEnv.HOME || "");
    delete process.env.OLLAMA_USAGE_COOKIE;
  });

  afterEach(async () => {
    process.env = originalEnv;
    for (const root of tempRoots.splice(0, tempRoots.length)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves the cookie from OLLAMA_USAGE_COOKIE first", async () => {
    process.env.OLLAMA_USAGE_COOKIE = "  env-cookie  ";

    const { resolveOllamaCloudConfigFromEnv, resolveOllamaCloudConfig } = await importConfigModule();

    expect(resolveOllamaCloudConfigFromEnv()).toEqual({
      state: "configured",
      config: { cookie: "env-cookie" },
      source: "env",
    });
    await expect(resolveOllamaCloudConfig()).resolves.toEqual({
      state: "configured",
      config: { cookie: "env-cookie" },
      source: "env",
    });
  });

  it("resolves the cookie from the OpenCode quota JSON config before ollama-usage YAML", async () => {
    const { opencodeConfigDir, xdgConfigDir, jsonPath, yamlPath } = await createConfigRoot();
    process.env.XDG_CONFIG_HOME = xdgConfigDir;
    runtimePathMocks.getOpencodeRuntimeDirCandidates.mockReturnValue({
      configDirs: [opencodeConfigDir],
    });

    await writeFile(jsonPath, JSON.stringify({ cookie: "json-cookie" }));
    await writeFile(yamlPath, 'cookie: "yaml-cookie"\n');

    const { resolveOllamaCloudConfig } = await importConfigModule();

    await expect(resolveOllamaCloudConfig()).resolves.toEqual({
      state: "configured",
      config: { cookie: "json-cookie" },
      source: jsonPath,
    });
  });

  it("resolves the cookie from ollama-usage YAML when JSON config is absent", async () => {
    const { root, opencodeConfigDir, xdgConfigDir, legacyYamlPath } = await createConfigRoot();
    process.env.HOME = root;
    osMocks.homedir.mockReturnValue(root);
    process.env.XDG_CONFIG_HOME = xdgConfigDir;
    runtimePathMocks.getOpencodeRuntimeDirCandidates.mockReturnValue({
      configDirs: [opencodeConfigDir],
    });

    await writeFile(legacyYamlPath, "cookie: __Secure-session=yaml-cookie\n");

    const { resolveOllamaCloudConfig } = await importConfigModule();

    await expect(resolveOllamaCloudConfig()).resolves.toEqual({
      state: "configured",
      config: { cookie: "__Secure-session=yaml-cookie" },
      source: legacyYamlPath,
    });
  });

  it("reports incomplete config diagnostics when a present config lacks cookie", async () => {
    const { root, opencodeConfigDir, xdgConfigDir, jsonPath, legacyYamlPath } = await createConfigRoot();
    process.env.HOME = root;
    osMocks.homedir.mockReturnValue(root);
    process.env.XDG_CONFIG_HOME = xdgConfigDir;
    runtimePathMocks.getOpencodeRuntimeDirCandidates.mockReturnValue({
      configDirs: [opencodeConfigDir],
    });

    await writeFile(jsonPath, JSON.stringify({ cookie: "   " }));

    const { getOllamaCloudConfigDiagnostics, resolveOllamaCloudConfig } = await importConfigModule();

    await expect(resolveOllamaCloudConfig()).resolves.toEqual({
      state: "incomplete",
      source: jsonPath,
      missing: "cookie",
    });
    const diagnostics = await getOllamaCloudConfigDiagnostics();
    expect(diagnostics).toMatchObject({
      state: "incomplete",
      source: jsonPath,
      missing: "cookie",
      error: null,
    });
    expect(diagnostics.checkedPaths).toEqual(expect.arrayContaining([jsonPath, legacyYamlPath]));
  });

  it("reports invalid config diagnostics and does not fall through", async () => {
    const { opencodeConfigDir, xdgConfigDir, jsonPath, yamlPath } = await createConfigRoot();
    process.env.XDG_CONFIG_HOME = xdgConfigDir;
    runtimePathMocks.getOpencodeRuntimeDirCandidates.mockReturnValue({
      configDirs: [opencodeConfigDir],
    });

    await writeFile(jsonPath, "[]");
    await writeFile(yamlPath, "cookie: yaml-cookie\n");

    const { getOllamaCloudConfigDiagnostics, resolveOllamaCloudConfig } = await importConfigModule();

    await expect(resolveOllamaCloudConfig()).resolves.toEqual({
      state: "invalid",
      source: jsonPath,
      error: "Config file must contain a JSON object",
    });
    await expect(getOllamaCloudConfigDiagnostics()).resolves.toMatchObject({
      state: "invalid",
      source: jsonPath,
      missing: null,
      error: "Config file must contain a JSON object",
    });
  });
});

