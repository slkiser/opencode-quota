import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyInitInstallerPlan,
  planInitInstaller,
} from "../src/lib/init-installer.js";

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("init installer planning and merge behavior", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "opencode-quota-init-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates project opencode.json at the worktree root for toast mode", async () => {
    const projectDir = join(tempDir, "project");
    const nestedDir = join(projectDir, "packages", "feature");
    mkdirSync(join(projectDir, ".git"), { recursive: true });
    mkdirSync(nestedDir, { recursive: true });

    const plan = await planInitInstaller({
      cwd: nestedDir,
      selections: {
        scope: "project",
        quotaUi: "toast",
        providerMode: "manual",
        manualProviders: ["openai", "anthropic"],
        formatStyle: "grouped",
        showSessionTokens: false,
      },
    });

    expect(plan.baseDir).toBe(projectDir);
    expect(plan.edits).toHaveLength(1);
    expect(plan.quickSetupNotes).toEqual([
      {
        providerId: "anthropic",
        label: "Anthropic",
        anchor: "anthropic-quick-setup",
      },
    ]);

    const result = await applyInitInstallerPlan(plan);
    expect(result.writtenPaths).toEqual([join(projectDir, "opencode.json")]);

    const config = readJson(join(projectDir, "opencode.json"));
    expect(config).toMatchObject({
      $schema: "https://opencode.ai/config.json",
      plugin: ["@slkiser/opencode-quota"],
      experimental: {
        quotaToast: {
          enableToast: true,
          enabledProviders: ["openai", "anthropic"],
          formatStyle: "grouped",
          showSessionTokens: false,
        },
      },
    });
  });

  it("preserves unrelated values, dedupes plugins, and adds formatStyle without deleting legacy toastStyle", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });

    writeFileSync(
      join(projectDir, "opencode.jsonc"),
      `{
        // preserve existing user values
        "$schema": "https://custom.local/config.json",
        "plugin": [
          "file:///Users/test/Downloads/GitHub/opencode-quota/dist/index.js"
        ],
        "experimental": {
          "quotaToast": {
            "toastStyle": "grouped",
            "enableToast": true,
            "showSessionTokens": true,
            "enabledProviders": ["openai"]
          }
        },
        "other": {
          "keep": true
        },
      }`,
      "utf8",
    );

    writeFileSync(
      join(projectDir, "tui.json"),
      JSON.stringify({
        plugin: ["file:///Users/test/Downloads/GitHub/opencode-quota/dist/tui.tsx"],
        tui: {
          plugin: [["some-other-plugin", { debug: true }]],
        },
        theme: "dark",
      }),
      "utf8",
    );

    const plan = await planInitInstaller({
      cwd: projectDir,
      selections: {
        scope: "project",
        quotaUi: "sidebar",
        providerMode: "manual",
        manualProviders: ["cursor", "opencode-go"],
        formatStyle: "classic",
        showSessionTokens: false,
      },
    });

    const opencodeEdit = plan.edits.find((edit) => edit.kind === "opencode");
    const tuiEdit = plan.edits.find((edit) => edit.kind === "tui");
    expect(opencodeEdit?.warnings).toContain("Existing JSONC comments/trailing commas will be stripped.");
    expect(opencodeEdit?.addedPlugins).toEqual([]);
    expect(opencodeEdit?.addedKeys).toContain("experimental.quotaToast.formatStyle");
    expect(opencodeEdit?.skippedValues).toEqual(
      expect.arrayContaining([
        "plugin already includes @slkiser/opencode-quota",
        "experimental.quotaToast.enableToast preserved existing value",
        "experimental.quotaToast.showSessionTokens preserved existing value",
        "experimental.quotaToast.enabledProviders preserved existing value",
      ]),
    );
    expect(tuiEdit?.addedPlugins).toEqual([]);
    expect(tuiEdit?.skippedValues).toContain("tui config already includes @slkiser/opencode-quota");

    await applyInitInstallerPlan(plan);

    const opencode = readJson(join(projectDir, "opencode.jsonc"));
    expect(opencode.other).toEqual({ keep: true });
    expect(opencode.plugin).toHaveLength(1);
    expect(opencode.experimental.quotaToast).toMatchObject({
      toastStyle: "grouped",
      formatStyle: "grouped",
      enableToast: true,
      showSessionTokens: true,
      enabledProviders: ["openai"],
    });

    const tui = readJson(join(projectDir, "tui.json"));
    expect(tui.$schema).toBe("https://opencode.ai/tui.json");
    expect(tui.theme).toBe("dark");
    expect(tui.plugin).toHaveLength(1);
    expect(tui.tui.plugin).toHaveLength(1);
  });

  it("creates both opencode and tui targets for sidebar mode and appends missing plugins", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });

    const plan = await planInitInstaller({
      cwd: projectDir,
      selections: {
        scope: "project",
        quotaUi: "sidebar",
        providerMode: "auto",
        manualProviders: [],
        formatStyle: "classic",
        showSessionTokens: true,
      },
    });

    expect(plan.edits.map((edit) => edit.kind)).toEqual(["opencode", "tui"]);

    await applyInitInstallerPlan(plan);

    const opencode = readJson(join(projectDir, "opencode.json"));
    const tui = readJson(join(projectDir, "tui.json"));

    expect(opencode.plugin).toEqual(["@slkiser/opencode-quota"]);
    expect(opencode.experimental.quotaToast).toMatchObject({
      enableToast: false,
      enabledProviders: "auto",
      formatStyle: "classic",
      showSessionTokens: true,
    });
    expect(tui).toEqual({
      $schema: "https://opencode.ai/tui.json",
      plugin: ["@slkiser/opencode-quota"],
    });
  });

  it("creates both opencode and tui targets for toast + sidebar mode with popup toasts enabled", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });

    const plan = await planInitInstaller({
      cwd: projectDir,
      selections: {
        scope: "project",
        quotaUi: "toast_sidebar",
        providerMode: "auto",
        manualProviders: [],
        formatStyle: "classic",
        showSessionTokens: true,
      },
    });

    expect(plan.summaryLines).toContain("Quota UI: Toast + Sidebar");
    expect(plan.edits.map((edit) => edit.kind)).toEqual(["opencode", "tui"]);

    await applyInitInstallerPlan(plan);

    const opencode = readJson(join(projectDir, "opencode.json"));
    const tui = readJson(join(projectDir, "tui.json"));

    expect(opencode.plugin).toEqual(["@slkiser/opencode-quota"]);
    expect(opencode.experimental.quotaToast).toMatchObject({
      enableToast: true,
      enabledProviders: "auto",
      formatStyle: "classic",
      showSessionTokens: true,
    });
    expect(tui).toEqual({
      $schema: "https://opencode.ai/tui.json",
      plugin: ["@slkiser/opencode-quota"],
    });
  });

  it("does not touch tui config for none mode and disables popup toasts when missing", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });

    const plan = await planInitInstaller({
      cwd: projectDir,
      selections: {
        scope: "project",
        quotaUi: "none",
        providerMode: "auto",
        manualProviders: [],
        formatStyle: "classic",
        showSessionTokens: true,
      },
    });

    expect(plan.edits).toHaveLength(1);

    await applyInitInstallerPlan(plan);

    expect(existsSync(join(projectDir, "tui.json"))).toBe(false);
    const opencode = readJson(join(projectDir, "opencode.json"));
    expect(opencode.experimental.quotaToast.enableToast).toBe(false);
  });

  it("fails when an existing plugin container is not an array", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });

    writeFileSync(
      join(projectDir, "opencode.json"),
      JSON.stringify({
        plugin: {
          bad: true,
        },
      }),
      "utf8",
    );

    await expect(
      planInitInstaller({
        cwd: projectDir,
        selections: {
          scope: "project",
          quotaUi: "toast",
          providerMode: "auto",
          manualProviders: [],
          formatStyle: "classic",
          showSessionTokens: true,
        },
      }),
    ).rejects.toThrow(/plugin is not an array/i);
  });

});
