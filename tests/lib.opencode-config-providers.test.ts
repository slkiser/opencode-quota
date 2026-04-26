import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

    await expect(loadConfiguredOpenCodeConfig({ configRootDir: workspaceDir })).resolves.toMatchObject({
      provider: {
        google: { options: { projectId: "global-project" } },
        copilot: {},
      },
      plugin: ["@slkiser/opencode-quota"],
      experimental: { quotaToast: { enabledProviders: ["copilot"] } },
    });
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
