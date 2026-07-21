import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtimeDirs = vi.hoisted(() => ({
  value: {
    dataDirs: [] as string[],
    configDirs: [] as string[],
    cacheDirs: [] as string[],
    stateDirs: [] as string[],
  },
}));

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirCandidates: () => runtimeDirs.value,
}));

import { extractProviderIdsFromParsedConfig } from "../src/lib/config-file-utils.js";
import {
  loadConfiguredOpenCodeConfig,
  loadConfiguredProviderIds,
  reconcileDetectedProvidersInGlobalConfig,
} from "../src/lib/opencode-config-providers.js";

describe("opencode config provider discovery", () => {
  let tempDir: string;
  let globalConfigDir: string;
  let workspaceDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "opencode-quota-config-providers-"));
    globalConfigDir = join(tempDir, "global-config", "opencode");
    workspaceDir = join(tempDir, "workspace");
    mkdirSync(globalConfigDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
    runtimeDirs.value = {
      dataDirs: [],
      configDirs: [globalConfigDir],
      cacheDirs: [],
      stateDirs: [],
    };
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("extracts root-level provider ids and ignores malformed provider sections", () => {
    expect(
      extractProviderIdsFromParsedConfig({
        provider: {
          " copilot ": {},
          openai: {},
          "": {},
        },
      }),
    ).toEqual(["copilot", "openai"]);

    expect(extractProviderIdsFromParsedConfig({ provider: [] })).toEqual([]);
    expect(extractProviderIdsFromParsedConfig({ tui: { provider: { copilot: {} } } })).toEqual([]);
  });

  it("loads provider ids from global and workspace opencode config files", async () => {
    writeFileSync(
      join(globalConfigDir, "opencode.json"),
      JSON.stringify({ provider: { copilot: {}, openai: {} } }),
      "utf8",
    );
    writeFileSync(
      join(workspaceDir, "opencode.jsonc"),
      '{\n  // workspace providers\n  "provider": { "openai": {}, "gemini-cli": {}, },\n}',
      "utf8",
    );

    await expect(loadConfiguredProviderIds({ configRootDir: workspaceDir })).resolves.toEqual([
      "copilot",
      "openai",
      "gemini-cli",
    ]);
  });

  it("infers provider ids from known companion plugin specs", async () => {
    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({
        plugin: [
          "opencode-qwencode-auth",
          "opencode-antigravity-auth@latest",
          "opencode-gemini-auth",
          "@playwo/opencode-cursor-oauth",
          "@slkiser/opencode-quota",
        ],
      }),
      "utf8",
    );

    await expect(loadConfiguredProviderIds({ configRootDir: workspaceDir })).resolves.toEqual([
      "qwen-code",
      "google-antigravity",
      "google-gemini-cli",
      "cursor",
    ]);
  });

  it("deduplicates provider ids inferred from provider blocks and plugin specs", async () => {
    writeFileSync(
      join(globalConfigDir, "opencode.json"),
      JSON.stringify({ plugin: ["opencode-qwencode-auth"] }),
      "utf8",
    );
    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({
        provider: { "qwen-code": {}, cursor: {} },
        plugin: [["@playwo/opencode-cursor-oauth", { enabled: true }]],
      }),
      "utf8",
    );

    await expect(loadConfiguredProviderIds({ configRootDir: workspaceDir })).resolves.toEqual([
      "qwen-code",
      "cursor",
    ]);
  });

  it("loads a merged OpenCode config view for standalone clients", async () => {
    writeFileSync(
      join(globalConfigDir, "opencode.json"),
      JSON.stringify({
        provider: { google: { options: { projectId: "global-project" } } },
      }),
      "utf8",
    );
    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({
        provider: { copilot: {} },
        plugin: ["@slkiser/opencode-quota"],
        experimental: { quotaToast: { enabledProviders: ["copilot"] } },
      }),
      "utf8",
    );

    await expect(
      loadConfiguredOpenCodeConfig({ configRootDir: workspaceDir }),
    ).resolves.toMatchObject({
      provider: {
        google: { options: { projectId: "global-project" } },
        copilot: {},
      },
      plugin: ["@slkiser/opencode-quota"],
      experimental: { quotaToast: { enabledProviders: ["copilot"] } },
    });
  });

  it("uses one selected format per scope and lets project provider declarations override global", async () => {
    writeFileSync(
      join(globalConfigDir, "opencode.json"),
      JSON.stringify({
        provider: {
          shared: { options: { baseURL: "https://global.example.test" } },
          globalOnly: {},
        },
      }),
      "utf8",
    );
    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({
        provider: {
          ignoredJson: {},
        },
      }),
      "utf8",
    );
    writeFileSync(
      join(workspaceDir, "opencode.jsonc"),
      `{
        // Project declarations are read-only inputs and override global declarations here.
        "provider": {
          "shared": { "options": { "baseURL": "https://project.example.test" } },
          "projectOnly": {},
        },
      }`,
      "utf8",
    );

    const before = await import("node:fs/promises").then(({ readFile }) =>
      readFile(join(workspaceDir, "opencode.jsonc"), "utf8"),
    );
    await expect(
      loadConfiguredOpenCodeConfig({ configRootDir: workspaceDir }),
    ).resolves.toMatchObject({
      provider: {
        shared: { options: { baseURL: "https://project.example.test" } },
        globalOnly: {},
        projectOnly: {},
      },
    });
    await expect(loadConfiguredProviderIds({ configRootDir: workspaceDir })).resolves.toEqual([
      "shared",
      "globalOnly",
      "projectOnly",
    ]);
    const after = await import("node:fs/promises").then(({ readFile }) =>
      readFile(join(workspaceDir, "opencode.jsonc"), "utf8"),
    );
    expect(after).toBe(before);
  });

  it("adds detected providers to global JSONC only and respects project declarations", async () => {
    const globalPath = join(globalConfigDir, "opencode.jsonc");
    const projectPath = join(workspaceDir, "opencode.jsonc");
    writeFileSync(
      globalPath,
      `{
        // Keep this global setting and comment.
        "theme": "system",
        "provider": {
          "global-only": {},
        },
      }
      `,
      "utf8",
    );
    writeFileSync(
      projectPath,
      `{
        // Project declarations are read-only overrides.
        "provider": {
          "openai": { "options": { "baseURL": "https://project.example.test" } },
        },
      }
      `,
      "utf8",
    );
    const projectBefore = readFileSync(projectPath, "utf8");

    const result = await reconcileDetectedProvidersInGlobalConfig({
      configRootDir: workspaceDir,
      detectedProviderIds: ["openai", "deepseek"],
    });

    expect(result).toMatchObject({
      path: globalPath,
      format: "jsonc",
      addedProviderIds: ["deepseek"],
      changed: true,
    });
    const globalAfter = readFileSync(globalPath, "utf8");
    expect(globalAfter).toContain("// Keep this global setting and comment.");
    expect(globalAfter).toContain(
      "// Detected deepseek authentication; opencode-quota added this global provider declaration.",
    );
    expect(
      globalAfter.match(/opencode-quota added this global provider declaration/g),
    ).toHaveLength(1);
    expect(
      JSON.parse(
        JSON.stringify(await loadConfiguredOpenCodeConfig({ configRootDir: workspaceDir })),
      ),
    ).toMatchObject({
      theme: "system",
      provider: {
        "global-only": {},
        deepseek: {},
        openai: { options: { baseURL: "https://project.example.test" } },
      },
    });
    expect(readFileSync(projectPath, "utf8")).toBe(projectBefore);
  });

  it("preserves strict global JSON and is idempotent", async () => {
    const globalPath = join(globalConfigDir, "opencode.json");
    writeFileSync(
      globalPath,
      JSON.stringify({ theme: "dark", provider: {} }, null, 2) + "\n",
      "utf8",
    );

    const first = await reconcileDetectedProvidersInGlobalConfig({
      configRootDir: workspaceDir,
      detectedProviderIds: ["deepseek"],
    });
    const firstRaw = readFileSync(globalPath, "utf8");
    expect(first).toMatchObject({ format: "json", addedProviderIds: ["deepseek"], changed: true });
    expect(JSON.parse(firstRaw)).toMatchObject({ theme: "dark", provider: { deepseek: {} } });
    expect(firstRaw).not.toContain("//");
    expect(existsSync(join(globalConfigDir, "opencode.jsonc"))).toBe(false);

    const second = await reconcileDetectedProvidersInGlobalConfig({
      configRootDir: workspaceDir,
      detectedProviderIds: ["deepseek"],
    });
    expect(second).toMatchObject({ format: "json", addedProviderIds: [], changed: false });
    expect(readFileSync(globalPath, "utf8")).toBe(firstRaw);
  });

  it("uses the selected project format when creating a missing global config", async () => {
    const projectPath = join(workspaceDir, "opencode.json");
    const globalPath = join(globalConfigDir, "opencode.json");
    writeFileSync(
      projectPath,
      JSON.stringify({ provider: { projectOnly: {} } }, null, 2) + "\n",
      "utf8",
    );
    const projectBefore = readFileSync(projectPath, "utf8");

    const result = await reconcileDetectedProvidersInGlobalConfig({
      configRootDir: workspaceDir,
      detectedProviderIds: ["deepseek"],
    });

    expect(result).toMatchObject({
      path: globalPath,
      format: "json",
      addedProviderIds: ["deepseek"],
    });
    expect(JSON.parse(readFileSync(globalPath, "utf8"))).toEqual({ provider: { deepseek: {} } });
    expect(existsSync(join(globalConfigDir, "opencode.jsonc"))).toBe(false);
    expect(readFileSync(projectPath, "utf8")).toBe(projectBefore);
  });

  it("leaves global and project files unchanged when the atomic write fails", async () => {
    const globalPath = join(globalConfigDir, "opencode.jsonc");
    const projectPath = join(workspaceDir, "opencode.jsonc");
    writeFileSync(globalPath, '{\n  // keep\n  "provider": {},\n}\n', "utf8");
    writeFileSync(projectPath, '{\n  // project keep\n  "theme": "dark",\n}\n', "utf8");
    const globalBefore = readFileSync(globalPath, "utf8");
    const projectBefore = readFileSync(projectPath, "utf8");

    await expect(
      reconcileDetectedProvidersInGlobalConfig({
        configRootDir: workspaceDir,
        detectedProviderIds: ["deepseek"],
        writeText: async () => {
          throw new Error("disk full");
        },
      }),
    ).rejects.toThrow("disk full");

    expect(readFileSync(globalPath, "utf8")).toBe(globalBefore);
    expect(readFileSync(projectPath, "utf8")).toBe(projectBefore);
  });

  it("ignores missing, malformed, and parse-failing provider config files", async () => {
    writeFileSync(join(globalConfigDir, "opencode.json"), "{ nope", "utf8");
    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({ provider: ["copilot"] }),
      "utf8",
    );

    await expect(loadConfiguredProviderIds({ configRootDir: workspaceDir })).resolves.toEqual([]);
  });
});
