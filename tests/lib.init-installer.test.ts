import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJsonOrJsonc } from "../src/lib/jsonc.js";

import {
  applyInitInstallerPlan,
  planInitInstaller,
  runInitInstaller,
} from "../src/lib/init-installer.js";

function readJson(path: string): any {
  const resolvedPath = !existsSync(path) && path.endsWith(".json") ? `${path}c` : path;
  const content = readFileSync(resolvedPath, "utf8");
  return parseJsonOrJsonc(content, resolvedPath.endsWith(".jsonc"));
}

function createPromptStub(params: {
  selectValues?: unknown[];
  multiselectValues?: unknown[];
  confirmValues?: unknown[];
}) {
  const selectValues = [...(params.selectValues ?? [])];
  const multiselectValues = [...(params.multiselectValues ?? [])];
  const confirmValues = [...(params.confirmValues ?? [])];
  const selectCalls: { message: string; options: unknown[] }[] = [];
  const multiselectCalls: { message: string; required?: boolean; options: unknown[] }[] = [];
  const outroCalls: string[] = [];
  const confirmCalls: { message: string; initialValue?: boolean }[] = [];

  return {
    intro: () => {},
    outro: (message: string) => {
      outroCalls.push(message);
    },
    select: async (options: { message: string; options: unknown[] }) => {
      selectCalls.push(options);
      return selectValues.shift();
    },
    multiselect: async (options: { message: string; required?: boolean; options: unknown[] }) => {
      multiselectCalls.push(options);
      return multiselectValues.shift();
    },
    confirm: async (options: { message: string; initialValue?: boolean }) => {
      confirmCalls.push(options);
      return confirmValues.shift();
    },
    isCancel: (value: unknown) => value === Symbol.for("cancel"),
    log: {
      info: () => {},
      success: () => {},
      error: () => {},
    },
    selectCalls,
    multiselectCalls,
    outroCalls,
    confirmCalls,
  };
}

describe("init installer planning and merge behavior", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "opencode-quota-init-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates recommended project opencode.jsonc at the worktree root for toast mode", async () => {
    const projectDir = join(tempDir, "project");
    const nestedDir = join(projectDir, "packages", "feature");
    mkdirSync(join(projectDir, ".git"), { recursive: true });
    mkdirSync(nestedDir, { recursive: true });

    const plan = await planInitInstaller({
      cwd: nestedDir,
      selections: {
        interfaces: "tui",
        scope: "project",
        quotaUi: ["toast"],
        providerMode: "manual",
        manualProviders: ["openai", "anthropic"],
        formatStyle: "allWindows",
        percentDisplayMode: "used",
        showSessionTokens: false,
      },
    });

    expect(plan.baseDir).toBe(projectDir);
    expect(plan.edits.map((edit) => edit.kind)).toEqual(["opencode", "quota", "tui"]);
    expect(plan.quickSetupNotes).toEqual([
      {
        providerId: "anthropic",
        label: "Anthropic",
        anchor: "anthropic-claude",
      },
    ]);

    const result = await applyInitInstallerPlan(plan);
    expect(result.writtenPaths).toEqual([
      join(projectDir, "opencode.jsonc"),
      join(projectDir, "opencode-quota", "quota-toast.jsonc"),
      join(projectDir, "tui.jsonc"),
    ]);

    const config = readJson(join(projectDir, "opencode.jsonc"));
    expect(config).toMatchObject({
      $schema: "https://opencode.ai/config.json",
      plugin: ["@slkiser/opencode-quota@latest"],
    });
    expect(config.experimental).toBeUndefined();

    const quotaConfig = readJson(join(projectDir, "opencode-quota", "quota-toast.json"));
    expect(quotaConfig).toMatchObject({
      enableToast: true,
      enabledProviders: ["openai", "anthropic"],
      formatStyle: "allWindows",
      percentDisplayMode: "used",
      showSessionTokens: false,
      tuiCommandDisplay: "inline",
    });
    expect(quotaConfig).not.toHaveProperty("tuiQuotaCommandDisplay");
    expect(readFileSync(join(projectDir, "opencode.jsonc"), "utf8")).toContain(
      "// OpenCode Quota: tuiCommandDisplay chooses whether native TUI command output appears in the session transcript or a local popup dialog.",
    );
  });

  it("creates strict comment-free JSON when JSON is selected", async () => {
    const projectDir = join(tempDir, "strict-json");
    mkdirSync(projectDir, { recursive: true });

    const plan = await planInitInstaller({
      cwd: projectDir,
      selections: {
        interfaces: "tui",
        scope: "project",
        configFormat: "json",
        quotaUi: ["toast"],
        providerMode: "auto",
        manualProviders: [],
        formatStyle: "singleWindow",
        percentDisplayMode: "remaining",
        showSessionTokens: true,
      },
    });
    await applyInitInstallerPlan(plan);

    const path = join(projectDir, "opencode.json");
    const raw = readFileSync(path, "utf8");
    expect(existsSync(join(projectDir, "opencode.jsonc"))).toBe(false);
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(raw).not.toMatch(/^\s*\/\//m);
    const quotaRaw = readFileSync(join(projectDir, "opencode-quota", "quota-toast.json"), "utf8");
    expect(JSON.parse(quotaRaw).tuiCommandDisplay).toBe("inline");
    expect(quotaRaw).not.toContain("//");
  });

  it("writes Dialog selection and explanatory comments only to generated JSONC host configs", async () => {
    const projectDir = join(tempDir, "dialog-jsonc");
    mkdirSync(projectDir, { recursive: true });

    const plan = await planInitInstaller({
      cwd: projectDir,
      selections: {
        interfaces: "tui",
        scope: "project",
        configFormat: "jsonc",
        quotaUi: ["sidebar"],
        providerMode: "auto",
        manualProviders: [],
        formatStyle: "singleWindow",
        percentDisplayMode: "remaining",
        showSessionTokens: true,
        tuiCommandDisplay: "dialog",
      },
    });
    await applyInitInstallerPlan(plan);

    expect(plan.summaryLines).toContain("Command display: Popup dialog");
    const quotaPath = join(projectDir, "opencode-quota", "quota-toast.jsonc");
    expect(readJson(quotaPath).tuiCommandDisplay).toBe("dialog");
    expect(readFileSync(quotaPath, "utf8")).toContain(
      "// Quota presentation and reset-period choices.",
    );

    for (const hostPath of [join(projectDir, "opencode.jsonc"), join(projectDir, "tui.jsonc")]) {
      const raw = readFileSync(hostPath, "utf8");
      expect(raw).toContain(
        "// OpenCode Quota: tuiCommandDisplay chooses whether native TUI command output appears in the session transcript or a local popup dialog.",
      );
      expect(() => parseJsonOrJsonc(raw, true)).not.toThrow();
    }
  });

  it("writes legacy experimental.quotaToast only when explicitly requested", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });

    const plan = await planInitInstaller({
      cwd: projectDir,
      syncLegacyConfig: true,
      selections: {
        interfaces: "tui",
        scope: "project",
        quotaUi: ["toast"],
        providerMode: "manual",
        manualProviders: ["openai"],
        formatStyle: "allWindows",
        percentDisplayMode: "used",
        showSessionTokens: false,
      },
    });

    const opencodeEdit = plan.edits.find((edit) => edit.kind === "opencode");
    expect(opencodeEdit?.addedKeys).toContain(
      "experimental.quotaToast (synced from opencode-quota/quota-toast.json)",
    );

    await applyInitInstallerPlan(plan);

    const opencode = readJson(join(projectDir, "opencode.jsonc"));
    const quotaConfig = readJson(join(projectDir, "opencode-quota", "quota-toast.json"));
    expect(opencode.experimental.quotaToast).toMatchObject(quotaConfig);
    expect(opencode.experimental.quotaToast).toMatchObject({
      enableToast: true,
      enabledProviders: ["openai"],
      formatStyle: "allWindows",
      percentDisplayMode: "used",
      showSessionTokens: false,
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
        interfaces: "tui",
        scope: "project",
        quotaUi: ["sidebar"],
        providerMode: "manual",
        manualProviders: ["cursor", "opencode-go"],
        formatStyle: "singleWindow",
        percentDisplayMode: "remaining",
        showSessionTokens: false,
      },
    });

    const opencodeEdit = plan.edits.find((edit) => edit.kind === "opencode");
    const tuiEdit = plan.edits.find((edit) => edit.kind === "tui");
    expect(opencodeEdit?.warnings).toEqual([]);
    expect(opencodeEdit?.addedPlugins).toEqual([]);
    expect(opencodeEdit?.addedKeys).toEqual([]);
    expect(opencodeEdit?.skippedValues).toEqual(
      expect.arrayContaining(["plugin already includes @slkiser/opencode-quota@latest"]),
    );
    const quotaEdit = plan.edits.find((edit) => edit.kind === "quota");
    expect(quotaEdit?.addedKeys).toEqual(
      expect.arrayContaining([
        "opencode-quota/quota-toast.jsonc (seeded from experimental.quotaToast)",
        "quotaToast.formatStyle",
        "quotaToast.percentDisplayMode",
      ]),
    );
    expect(quotaEdit?.updatedKeys).toContain("quotaToast.enableToast");
    expect(quotaEdit?.updatedKeys).toEqual(
      expect.arrayContaining(["quotaToast.showSessionTokens", "quotaToast.enabledProviders"]),
    );
    expect(tuiEdit?.addedPlugins).toEqual([]);
    expect(tuiEdit?.skippedValues).toContain(
      "tui config already includes @slkiser/opencode-quota@latest",
    );

    await applyInitInstallerPlan(plan);

    const opencodeRaw = readFileSync(join(projectDir, "opencode.jsonc"), "utf8");
    expect(opencodeRaw).toContain("// preserve existing user values");
    expect(opencodeRaw).toMatch(/"other":\s*\{[\s\S]*"keep": true[\s\S]*\},/);
    expect(opencodeRaw.match(/OpenCode Quota: loads the server plugin/g)).toHaveLength(1);
    const opencode = readJson(join(projectDir, "opencode.jsonc"));
    expect(opencode.other).toEqual({ keep: true });
    expect(opencode.plugin).toHaveLength(1);
    expect(opencode.experimental.quotaToast).toMatchObject({
      toastStyle: "grouped",
      enableToast: true,
      showSessionTokens: true,
      enabledProviders: ["openai"],
    });
    expect(opencode.experimental.quotaToast.formatStyle).toBeUndefined();
    const quotaConfig = readJson(join(projectDir, "opencode-quota", "quota-toast.json"));
    expect(quotaConfig).toMatchObject({
      toastStyle: "grouped",
      formatStyle: "singleWindow",
      percentDisplayMode: "remaining",
      enableToast: false,
      showSessionTokens: false,
      enabledProviders: ["cursor", "opencode-go"],
    });

    const tui = readJson(join(projectDir, "tui.jsonc"));
    expect(tui.$schema).toBeUndefined();
    expect(tui.theme).toBe("dark");
    expect(tui.plugin).toHaveLength(1);
    expect(tui.tui.plugin).toHaveLength(1);
  });

  it("adds the server plugin when opencode config only references the tui entrypoint", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });

    writeFileSync(
      join(projectDir, "opencode.json"),
      JSON.stringify({
        plugin: ["file:///Users/test/Downloads/GitHub/opencode-quota/dist/tui.tsx"],
      }),
      "utf8",
    );

    const plan = await planInitInstaller({
      cwd: projectDir,
      selections: {
        interfaces: "tui",
        scope: "project",
        quotaUi: ["toast"],
        providerMode: "auto",
        manualProviders: [],
        formatStyle: "singleWindow",
        percentDisplayMode: "remaining",
        showSessionTokens: true,
      },
    });

    const opencodeEdit = plan.edits.find((edit) => edit.kind === "opencode");
    expect(opencodeEdit?.addedPlugins).toEqual(["plugin: @slkiser/opencode-quota@latest"]);

    await applyInitInstallerPlan(plan);

    const opencode = readJson(join(projectDir, "opencode.jsonc"));
    expect(opencode.plugin).toEqual([
      "file:///Users/test/Downloads/GitHub/opencode-quota/dist/tui.tsx",
      "@slkiser/opencode-quota@latest",
    ]);
  });

  it("writes sidebar disabled when selected UI omits sidebar and tui config already has the plugin", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });

    writeFileSync(
      join(projectDir, "tui.json"),
      JSON.stringify({
        plugin: ["@slkiser/opencode-quota"],
      }),
      "utf8",
    );

    const plan = await planInitInstaller({
      cwd: projectDir,
      selections: {
        interfaces: "tui",
        scope: "project",
        quotaUi: ["toast"],
        providerMode: "auto",
        manualProviders: [],
        formatStyle: "singleWindow",
        percentDisplayMode: "remaining",
        showSessionTokens: true,
      },
    });

    expect(plan.edits.map((edit) => edit.kind)).toEqual(["opencode", "quota", "tui"]);

    await applyInitInstallerPlan(plan);

    const tui = readJson(join(projectDir, "tui.json"));
    expect(tui).toEqual({ plugin: ["@slkiser/opencode-quota"] });
    const quotaConfig = readJson(join(projectDir, "opencode-quota", "quota-toast.json"));
    expect(quotaConfig.tuiSidebarPanel).toEqual({ enabled: false });
  });

  it("adds the tui plugin when tui config only references the server entrypoint", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });

    writeFileSync(
      join(projectDir, "tui.json"),
      JSON.stringify({
        plugin: ["file:///Users/test/Downloads/GitHub/opencode-quota/dist/index.js"],
      }),
      "utf8",
    );

    const plan = await planInitInstaller({
      cwd: projectDir,
      selections: {
        interfaces: "tui",
        scope: "project",
        quotaUi: ["sidebar"],
        providerMode: "auto",
        manualProviders: [],
        formatStyle: "singleWindow",
        percentDisplayMode: "remaining",
        showSessionTokens: true,
      },
    });

    const tuiEdit = plan.edits.find((edit) => edit.kind === "tui");
    expect(tuiEdit?.addedPlugins).toEqual(["plugin: @slkiser/opencode-quota@latest"]);

    await applyInitInstallerPlan(plan);

    const tui = readJson(join(projectDir, "tui.jsonc"));
    expect(tui.plugin).toEqual([
      "file:///Users/test/Downloads/GitHub/opencode-quota/dist/index.js",
      "@slkiser/opencode-quota@latest",
    ]);
  });

  it("creates both opencode and tui targets for sidebar mode and appends missing plugins", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });

    const plan = await planInitInstaller({
      cwd: projectDir,
      selections: {
        interfaces: "tui",
        scope: "project",
        quotaUi: ["sidebar"],
        providerMode: "auto",
        manualProviders: [],
        formatStyle: "singleWindow",
        percentDisplayMode: "remaining",
        showSessionTokens: true,
      },
    });

    expect(plan.edits.map((edit) => edit.kind)).toEqual(["opencode", "quota", "tui"]);

    await applyInitInstallerPlan(plan);

    const opencode = readJson(join(projectDir, "opencode.jsonc"));
    const tui = readJson(join(projectDir, "tui.jsonc"));

    expect(opencode.plugin).toEqual(["@slkiser/opencode-quota@latest"]);
    expect(opencode.experimental).toBeUndefined();
    const quotaConfig = readJson(join(projectDir, "opencode-quota", "quota-toast.json"));
    expect(quotaConfig).toMatchObject({
      enableToast: false,
      enabledProviders: "auto",
      formatStyle: "singleWindow",
      percentDisplayMode: "remaining",
      showSessionTokens: true,
      tuiSidebarPanel: { enabled: true },
    });
    expect(tui).toEqual({
      $schema: "https://opencode.ai/tui.json",
      plugin: ["@slkiser/opencode-quota@latest"],
    });
  });

  it("leaves compact TUI status alone when not selected for fresh sidebar installs", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });

    const plan = await planInitInstaller({
      cwd: projectDir,
      selections: {
        interfaces: "tui",
        scope: "project",
        quotaUi: ["sidebar"],
        providerMode: "auto",
        manualProviders: [],
        formatStyle: "singleWindow",
        percentDisplayMode: "remaining",
        showSessionTokens: true,
      },
    });

    expect(plan.summaryLines).not.toContain("Compact status mode: Home bottom + session prompt");
    expect(plan.edits.map((edit) => edit.kind)).toEqual(["opencode", "quota", "tui"]);

    await applyInitInstallerPlan(plan);

    expect(existsSync(join(projectDir, "opencode.jsonc"))).toBe(true);
    expect(existsSync(join(projectDir, "tui.jsonc"))).toBe(true);
    const quotaConfig = readJson(join(projectDir, "opencode-quota", "quota-toast.json"));
    expect(quotaConfig.tuiSidebarPanel).toEqual({ enabled: true });
    expect(quotaConfig.tuiCompactStatus).toBeUndefined();
  });

  it("writes compact TUI config when compact status is selected", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });

    const plan = await planInitInstaller({
      cwd: projectDir,
      selections: {
        interfaces: "tui",
        scope: "project",
        quotaUi: ["sidebar", "compact_status"],
        providerMode: "auto",
        manualProviders: [],
        formatStyle: "singleWindow",
        percentDisplayMode: "remaining",
        showSessionTokens: true,
      },
    });

    expect(plan.summaryLines).toContain("TUI surfaces: Sidebar + Compact status");
    expect(plan.summaryLines).toContain("Compact status mode: Home bottom + session prompt");

    await applyInitInstallerPlan(plan);

    expect(existsSync(join(projectDir, "tui.jsonc"))).toBe(true);
    const quotaConfig = readJson(join(projectDir, "opencode-quota", "quota-toast.json"));
    expect(quotaConfig.tuiSidebarPanel).toEqual({ enabled: true });
    expect(quotaConfig.tuiCompactStatus).toEqual({
      enabled: true,
      homeBottom: true,
      sessionPrompt: true,
      suppressWhenNativeProviderQuota: true,
    });
  });

  it("keeps compact-only selection independent from sidebar", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });

    const plan = await planInitInstaller({
      cwd: projectDir,
      selections: {
        interfaces: "tui",
        scope: "project",
        quotaUi: ["compact_status"],
        providerMode: "auto",
        manualProviders: [],
        formatStyle: "singleWindow",
        percentDisplayMode: "remaining",
        showSessionTokens: true,
      },
    });

    expect(plan.selections.quotaUi).toEqual(["compact_status"]);
    expect(plan.summaryLines).toContain("TUI surfaces: Compact status");
    expect(plan.edits.map((edit) => edit.kind)).toEqual(["opencode", "quota", "tui"]);

    await applyInitInstallerPlan(plan);

    const quotaConfig = readJson(join(projectDir, "opencode-quota", "quota-toast.json"));
    expect(quotaConfig.enableToast).toBe(false);
    expect(quotaConfig.tuiSidebarPanel).toEqual({ enabled: false });
    expect(quotaConfig.tuiCompactStatus).toEqual({
      enabled: true,
      homeBottom: true,
      sessionPrompt: true,
      suppressWhenNativeProviderQuota: true,
    });
  });

  it("updates existing sidebar enabled value for compact-only selection", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(join(projectDir, "opencode-quota"), { recursive: true });
    writeFileSync(
      join(projectDir, "opencode-quota", "quota-toast.json"),
      JSON.stringify({
        enableToast: false,
        enabledProviders: "auto",
        formatStyle: "singleWindow",
        percentDisplayMode: "remaining",
        showSessionTokens: true,
        tuiSidebarPanel: {
          enabled: true,
        },
      }),
      "utf8",
    );

    const plan = await planInitInstaller({
      cwd: projectDir,
      selections: {
        interfaces: "tui",
        scope: "project",
        quotaUi: ["compact_status"],
        providerMode: "auto",
        manualProviders: [],
        formatStyle: "singleWindow",
        percentDisplayMode: "remaining",
        showSessionTokens: true,
      },
    });

    const quotaEdit = plan.edits.find((edit) => edit.kind === "quota");
    expect(quotaEdit?.updatedKeys).toContain("quotaToast.tuiSidebarPanel.enabled");
    expect(quotaEdit?.skippedValues).not.toContain(
      "quotaToast.tuiSidebarPanel.enabled preserved existing value",
    );

    await applyInitInstallerPlan(plan);

    const quotaConfig = readJson(join(projectDir, "opencode-quota", "quota-toast.json"));
    expect(quotaConfig.tuiSidebarPanel).toEqual({ enabled: false });
    expect(quotaConfig.tuiCompactStatus).toMatchObject({ enabled: true });
  });

  it("writes maintainer announcements disabled without installing TUI solely for announcements", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });

    const plan = await planInitInstaller({
      cwd: projectDir,
      selections: {
        interfaces: "tui",
        scope: "project",
        quotaUi: ["none"],
        providerMode: "auto",
        manualProviders: [],
        formatStyle: "singleWindow",
        percentDisplayMode: "remaining",
        showSessionTokens: true,
        maintainerAnnouncements: false,
      },
    });

    expect(plan.summaryLines).toContain("TUI surfaces: Manual commands only");
    expect(plan.summaryLines).toContain("Maintainer announcements: Disabled");
    expect(plan.edits.map((edit) => edit.kind)).toEqual(["opencode", "quota", "tui"]);

    await applyInitInstallerPlan(plan);

    expect(existsSync(join(projectDir, "tui.json"))).toBe(false);
    const quotaConfig = readJson(join(projectDir, "opencode-quota", "quota-toast.json"));
    expect(quotaConfig.maintainerAnnouncements).toEqual({ enabled: false });
  });

  it("writes maintainer announcements enabled without installing TUI solely for announcements", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });

    const plan = await planInitInstaller({
      cwd: projectDir,
      selections: {
        interfaces: "tui",
        scope: "project",
        quotaUi: ["none"],
        providerMode: "auto",
        manualProviders: [],
        formatStyle: "singleWindow",
        percentDisplayMode: "remaining",
        showSessionTokens: true,
        maintainerAnnouncements: true,
      },
    });

    expect(plan.summaryLines).toContain("Maintainer announcements: Enabled");
    expect(plan.summaryLines).not.toContain(
      "TUI plugin: install for maintainer announcement home notices only",
    );
    expect(plan.edits.map((edit) => edit.kind)).toEqual(["opencode", "quota", "tui"]);

    await applyInitInstallerPlan(plan);

    expect(existsSync(join(projectDir, "tui.json"))).toBe(false);
    const quotaConfig = readJson(join(projectDir, "opencode-quota", "quota-toast.json"));
    expect(quotaConfig.maintainerAnnouncements).toEqual({ enabled: true, home: true });
  });

  it("rerun with maintainer announcements enabled restores installer-created opt-outs", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(join(projectDir, "opencode-quota"), { recursive: true });
    writeFileSync(
      join(projectDir, "opencode-quota", "quota-toast.json"),
      JSON.stringify({
        enableToast: false,
        enabledProviders: "auto",
        formatStyle: "singleWindow",
        percentDisplayMode: "remaining",
        showSessionTokens: true,
        maintainerAnnouncements: { enabled: false, home: false },
      }),
      "utf8",
    );

    const plan = await planInitInstaller({
      cwd: projectDir,
      selections: {
        interfaces: "tui",
        scope: "project",
        quotaUi: ["none"],
        providerMode: "auto",
        manualProviders: [],
        formatStyle: "singleWindow",
        percentDisplayMode: "remaining",
        showSessionTokens: true,
        maintainerAnnouncements: true,
      },
    });

    const quotaEdit = plan.edits.find((edit) => edit.kind === "quota");
    expect(quotaEdit?.updatedKeys).toContain("quotaToast.maintainerAnnouncements.enabled");
    expect(quotaEdit?.updatedKeys).toContain("quotaToast.maintainerAnnouncements.home");

    await applyInitInstallerPlan(plan);

    const quotaConfig = readJson(join(projectDir, "opencode-quota", "quota-toast.json"));
    expect(quotaConfig.maintainerAnnouncements).toEqual({ enabled: true, home: true });
  });

  it("rejects empty, unknown, and mixed current quota UI selections", async () => {
    const baseSelections = {
      interfaces: "tui",
      scope: "project",
      providerMode: "auto",
      manualProviders: [],
      formatStyle: "singleWindow",
      percentDisplayMode: "remaining",
      showSessionTokens: true,
    } as const;

    await expect(
      planInitInstaller({
        cwd: tempDir,
        selections: { ...baseSelections, quotaUi: [] },
      }),
    ).rejects.toThrow("Quota UI selections must not be empty.");

    await expect(
      planInitInstaller({
        cwd: tempDir,
        selections: { ...baseSelections, quotaUi: ["sidebar", "obsolete"] as any },
      }),
    ).rejects.toThrow("Unknown Quota UI option: obsolete");

    await expect(
      planInitInstaller({
        cwd: tempDir,
        selections: { ...baseSelections, quotaUi: ["none", "toast"] },
      }),
    ).rejects.toThrow("Manual commands only cannot be combined with automatic quota displays.");
  });

  it("rejects the obsolete string quota UI selection", async () => {
    await expect(
      planInitInstaller({
        cwd: tempDir,
        selections: {
          interfaces: "tui",
          scope: "project",
          quotaUi: "toast_sidebar",
          providerMode: "auto",
          manualProviders: [],
          formatStyle: "singleWindow",
          percentDisplayMode: "remaining",
          showSessionTokens: true,
        } as any,
      }),
    ).rejects.toThrow("Quota UI selections must be an array.");
  });

  it("rejects the obsolete compact installer selection field", async () => {
    await expect(
      planInitInstaller({
        cwd: tempDir,
        selections: {
          interfaces: "tui",
          scope: "project",
          quotaUi: ["toast", "sidebar"],
          providerMode: "auto",
          manualProviders: [],
          formatStyle: "singleWindow",
          percentDisplayMode: "remaining",
          showSessionTokens: true,
          tuiCompactStatus: "home_bottom_session_prompt",
        } as any,
      }),
    ).rejects.toThrow("Unsupported installer selection: tuiCompactStatus");
  });

  it("updates installer-owned compact config values and preserves custom fields", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(join(projectDir, "opencode-quota"), { recursive: true });
    writeFileSync(
      join(projectDir, "opencode-quota", "quota-toast.json"),
      JSON.stringify({
        enableToast: false,
        enabledProviders: "auto",
        formatStyle: "singleWindow",
        percentDisplayMode: "remaining",
        showSessionTokens: true,
        tuiSidebarPanel: {
          enabled: false,
        },
        tuiCompactStatus: {
          enabled: false,
          sessionPrompt: false,
          maxWidth: 40,
        },
      }),
      "utf8",
    );

    const plan = await planInitInstaller({
      cwd: projectDir,
      selections: {
        interfaces: "tui",
        scope: "project",
        quotaUi: ["toast", "sidebar", "compact_status"],
        providerMode: "auto",
        manualProviders: [],
        formatStyle: "singleWindow",
        percentDisplayMode: "remaining",
        showSessionTokens: true,
      },
    });

    const quotaEdit = plan.edits.find((edit) => edit.kind === "quota");
    expect(quotaEdit?.addedKeys).toEqual(
      expect.arrayContaining([
        "quotaToast.tuiCompactStatus.homeBottom",
        "quotaToast.tuiCompactStatus.suppressWhenNativeProviderQuota",
      ]),
    );
    expect(quotaEdit?.updatedKeys).toEqual(
      expect.arrayContaining([
        "quotaToast.enableToast",
        "quotaToast.tuiSidebarPanel.enabled",
        "quotaToast.tuiCompactStatus.enabled",
        "quotaToast.tuiCompactStatus.sessionPrompt",
      ]),
    );
    expect(quotaEdit?.skippedValues).not.toEqual(
      expect.arrayContaining([
        "quotaToast.enableToast preserved existing value",
        "quotaToast.tuiSidebarPanel.enabled preserved existing value",
        "quotaToast.tuiCompactStatus.enabled preserved existing value",
        "quotaToast.tuiCompactStatus.sessionPrompt preserved existing value",
      ]),
    );

    await applyInitInstallerPlan(plan);

    const quotaConfig = readJson(join(projectDir, "opencode-quota", "quota-toast.json"));
    expect(quotaConfig.enableToast).toBe(true);
    expect(quotaConfig.tuiSidebarPanel).toEqual({ enabled: true });
    expect(quotaConfig.tuiCompactStatus).toEqual({
      enabled: true,
      sessionPrompt: true,
      maxWidth: 40,
      homeBottom: true,
      suppressWhenNativeProviderQuota: true,
    });
  });

  it("disables deselected existing UI surfaces without adding compact safety fields", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(join(projectDir, "opencode-quota"), { recursive: true });
    writeFileSync(
      join(projectDir, "opencode-quota", "quota-toast.json"),
      JSON.stringify({
        enableToast: true,
        enabledProviders: "auto",
        formatStyle: "singleWindow",
        percentDisplayMode: "remaining",
        showSessionTokens: true,
        tuiSidebarPanel: {
          enabled: true,
        },
        tuiCompactStatus: {
          enabled: true,
          sessionPrompt: true,
        },
      }),
      "utf8",
    );

    const plan = await planInitInstaller({
      cwd: projectDir,
      selections: {
        interfaces: "tui",
        scope: "project",
        quotaUi: ["none"],
        providerMode: "auto",
        manualProviders: [],
        formatStyle: "singleWindow",
        percentDisplayMode: "remaining",
        showSessionTokens: true,
      },
    });

    const quotaEdit = plan.edits.find((edit) => edit.kind === "quota");
    expect(quotaEdit?.addedKeys).not.toEqual(
      expect.arrayContaining([
        "quotaToast.tuiCompactStatus.homeBottom",
        "quotaToast.tuiCompactStatus.suppressWhenNativeProviderQuota",
      ]),
    );
    expect(quotaEdit?.updatedKeys).toEqual(
      expect.arrayContaining([
        "quotaToast.enableToast",
        "quotaToast.tuiSidebarPanel.enabled",
        "quotaToast.tuiCompactStatus.enabled",
      ]),
    );

    await applyInitInstallerPlan(plan);

    const quotaConfig = readJson(join(projectDir, "opencode-quota", "quota-toast.json"));
    expect(quotaConfig.enableToast).toBe(false);
    expect(quotaConfig.tuiSidebarPanel).toEqual({ enabled: false });
    expect(quotaConfig.tuiCompactStatus).toEqual({
      enabled: false,
      sessionPrompt: true,
    });
  });

  it("prompts for quota UI as a multiselect and does not ask a separate compact status question", async () => {
    const prompts = createPromptStub({
      selectValues: [
        "tui",
        "project",
        "jsonc",
        "inline",
        "auto",
        "singleWindow",
        "remaining",
        "yes",
      ],
      multiselectValues: [["sidebar", "compact_status"]],
      confirmValues: [true, true],
    });

    const code = await runInitInstaller({
      cwd: tempDir,
      prompts: prompts as any,
    });

    expect(code).toBe(0);
    expect(
      prompts.outroCalls.some((message) => message.startsWith("OpenCode Quota setup complete.")),
    ).toBe(true);
    expect(prompts.selectCalls[0]).toMatchObject({
      message: "Which OpenCode interfaces do you use?",
      options: [
        { label: "TUI", value: "tui", hint: "terminal interface" },
        { label: "Web", value: "web", hint: "browser interface" },
        {
          label: "Both",
          value: "both",
          hint: "configure terminal and browser interfaces",
        },
      ],
    });
    expect(prompts.selectCalls[1]).toMatchObject({
      message: "Where should OpenCode Quota be configured?",
      initialValue: "global",
      options: [
        expect.objectContaining({ label: "Global OpenCode config (recommended)", value: "global" }),
        expect.objectContaining({ label: "Project config", value: "project" }),
      ],
    });
    expect(prompts.selectCalls[2]).toMatchObject({
      message: "OpenCode config format",
    });
    expect(prompts.multiselectCalls[0]).toMatchObject({
      message: "Which automatic quota displays do you want?",
      required: true,
      initialValues: ["sidebar"],
    });
    expect(prompts.multiselectCalls[0]?.options).toEqual([
      expect.objectContaining({ label: "Sidebar panel (TUI)", value: "sidebar" }),
      expect.objectContaining({ label: "Toast (TUI)", value: "toast" }),
      expect.objectContaining({ label: "Compact status line (TUI)", value: "compact_status" }),
      expect.objectContaining({ label: "Manual commands only", value: "none" }),
    ]);
    expect(
      prompts.selectCalls.find(
        (call) => call.message === "Where should slash commands (e.g. /quota) appear?",
      ),
    ).toMatchObject({
      initialValue: "inline",
      options: [
        {
          label: "Inline with messages",
          value: "inline",
          hint: "persist output in the message transcript",
        },
        {
          label: "Popup dialog",
          value: "dialog",
          hint: "show output in a temporary TUI popup",
        },
      ],
    });
    expect(
      prompts.selectCalls.find(
        (call) => call.message === "How should pre-configured providers be selected?",
      )?.options,
    ).toEqual([
      {
        label: "Auto-detect providers",
        value: "auto",
        hint: "use providers found in your OpenCode configuration and authentication",
      },
      {
        label: "Choose providers manually",
        value: "manual",
        hint: "track only the pre-configured providers you select",
      },
    ]);
    const resetPeriodsPrompt = prompts.selectCalls.find(
      (call) => call.message === "Quota reset periods",
    );
    expect(resetPeriodsPrompt).toMatchObject({ initialValue: "allWindows" });
    expect(resetPeriodsPrompt?.options).toEqual([
      {
        label: "All reset periods",
        value: "allWindows",
        hint: "show every available quota window",
      },
      {
        label: "One reset period (expiring soonest)",
        value: "singleWindow",
        hint: "show only the next quota window to expire",
      },
    ]);
    expect(
      prompts.selectCalls.find((call) => call.message === "What should quota percentages show?"),
    ).toBeDefined();
    expect(
      prompts.selectCalls.find((call) => call.message === "Session input/output tokens")?.options,
    ).toEqual([
      { label: "Hide", value: "no", hint: "keep output shorter" },
      {
        label: "Show",
        value: "yes",
        hint: "include current-session input and output totals",
      },
    ]);
    expect(prompts.confirmCalls[0]).toEqual({
      message: "Show maintainer announcements on the TUI Home screen when available?",
      initialValue: true,
    });
    const quotaConfig = readJson(join(tempDir, "opencode-quota", "quota-toast.json"));
    expect(quotaConfig.tuiSidebarPanel).toEqual({ enabled: true });
    expect(quotaConfig.tuiCompactStatus).toMatchObject({
      enabled: true,
      homeBottom: true,
      sessionPrompt: true,
      suppressWhenNativeProviderQuota: true,
    });
  });

  it("prefills installer-owned answers from existing configuration on rerun", async () => {
    mkdirSync(join(tempDir, "opencode-quota"), { recursive: true });
    writeFileSync(
      join(tempDir, "opencode-quota", "quota-toast.jsonc"),
      `{
        // preserve
        "enableToast": false,
        "enabledProviders": ["openai"],
        "formatStyle": "singleWindow",
        "percentDisplayMode": "remaining",
        "showSessionTokens": false,
        "tuiCommandDisplay": "inline",
        "tuiSidebarPanel": { "enabled": true },
        "maintainerAnnouncements": { "enabled": true }
      }`,
      "utf8",
    );
    const prompts = createPromptStub({
      selectValues: ["tui", "project", "jsonc", "dialog", "manual", "allWindows", "used", "yes"],
      multiselectValues: [["toast"], ["anthropic"]],
      confirmValues: [false, false],
    });

    const code = await runInitInstaller({ cwd: tempDir, prompts: prompts as any });

    expect(code).toBe(0);
    expect(prompts.multiselectCalls[0]).toMatchObject({ initialValues: ["sidebar"] });
    expect(prompts.multiselectCalls[1]).toMatchObject({ initialValues: ["openai"] });
    expect(
      prompts.selectCalls.find(
        (call) => call.message === "Where should slash commands (e.g. /quota) appear?",
      ),
    ).toMatchObject({ initialValue: "inline" });
    expect(
      prompts.selectCalls.find(
        (call) => call.message === "How should pre-configured providers be selected?",
      ),
    ).toMatchObject({ initialValue: "manual" });
    expect(
      prompts.selectCalls.find((call) => call.message === "Quota reset periods"),
    ).toMatchObject({ initialValue: "singleWindow" });
    expect(prompts.outroCalls).toContain("OpenCode Quota setup cancelled — no files changed.");
  });

  it("prompt No for maintainer announcements writes opt-out and does not install TUI only for notices", async () => {
    const prompts = createPromptStub({
      selectValues: [
        "tui",
        "project",
        "jsonc",
        "inline",
        "auto",
        "singleWindow",
        "remaining",
        "yes",
      ],
      multiselectValues: [["none"]],
      confirmValues: [false, true],
    });

    const code = await runInitInstaller({
      cwd: tempDir,
      prompts: prompts as any,
    });

    expect(code).toBe(0);
    expect(existsSync(join(tempDir, "tui.json"))).toBe(false);
    const quotaConfig = readJson(join(tempDir, "opencode-quota", "quota-toast.json"));
    expect(quotaConfig.maintainerAnnouncements).toEqual({ enabled: false });
  });

  it("creates both opencode and tui targets for toast + sidebar mode with popup toasts enabled", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });

    const plan = await planInitInstaller({
      cwd: projectDir,
      selections: {
        interfaces: "tui",
        scope: "project",
        quotaUi: ["toast", "sidebar"],
        providerMode: "auto",
        manualProviders: [],
        formatStyle: "singleWindow",
        percentDisplayMode: "remaining",
        showSessionTokens: true,
      },
    });

    expect(plan.summaryLines).toContain("TUI surfaces: Sidebar + Toast");
    expect(plan.summaryLines).toContain("Quota reset periods: Single window");
    expect(plan.summaryLines).toContain("Quota percentage meaning: Remaining");
    expect(plan.edits.map((edit) => edit.kind)).toEqual(["opencode", "quota", "tui"]);

    await applyInitInstallerPlan(plan);

    const opencode = readJson(join(projectDir, "opencode.jsonc"));
    const tui = readJson(join(projectDir, "tui.jsonc"));

    expect(opencode.plugin).toEqual(["@slkiser/opencode-quota@latest"]);
    expect(opencode.experimental).toBeUndefined();
    const quotaConfig = readJson(join(projectDir, "opencode-quota", "quota-toast.json"));
    expect(quotaConfig).toMatchObject({
      enableToast: true,
      enabledProviders: "auto",
      formatStyle: "singleWindow",
      percentDisplayMode: "remaining",
      showSessionTokens: true,
      tuiSidebarPanel: { enabled: true },
    });
    expect(tui).toEqual({
      $schema: "https://opencode.ai/tui.json",
      plugin: ["@slkiser/opencode-quota@latest"],
    });
  });

  it("does not touch tui config for none mode and disables popup toasts when missing", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });

    const plan = await planInitInstaller({
      cwd: projectDir,
      selections: {
        interfaces: "tui",
        scope: "project",
        quotaUi: ["none"],
        providerMode: "auto",
        manualProviders: [],
        formatStyle: "singleWindow",
        percentDisplayMode: "remaining",
        showSessionTokens: true,
      },
    });

    expect(plan.edits.map((edit) => edit.kind)).toEqual(["opencode", "quota", "tui"]);

    await applyInitInstallerPlan(plan);

    expect(existsSync(join(projectDir, "tui.json"))).toBe(false);
    const opencode = readJson(join(projectDir, "opencode.jsonc"));
    expect(opencode.plugin).toEqual(["@slkiser/opencode-quota@latest"]);
    expect(opencode.experimental).toBeUndefined();
    const quotaConfig = readJson(join(projectDir, "opencode-quota", "quota-toast.json"));
    expect(quotaConfig.enableToast).toBe(false);
    expect(quotaConfig.tuiSidebarPanel).toEqual({ enabled: false });
  });

  it("returns zero when the user cancels before applying changes", async () => {
    const prompts = createPromptStub({
      selectValues: [
        "tui",
        "project",
        "jsonc",
        "inline",
        "auto",
        "singleWindow",
        "remaining",
        "yes",
      ],
      multiselectValues: [["toast"]],
      confirmValues: [true, false],
    });

    const code = await runInitInstaller({
      cwd: tempDir,
      prompts: prompts as any,
    });

    expect(code).toBe(0);
    expect(existsSync(join(tempDir, "opencode.json"))).toBe(false);
  });

  it("validates and prints an init dry-run without writing files", async () => {
    const prompts = createPromptStub({
      selectValues: [
        "tui",
        "project",
        "jsonc",
        "inline",
        "auto",
        "singleWindow",
        "remaining",
        "yes",
      ],
      multiselectValues: [["toast"]],
      confirmValues: [true],
    });

    const code = await runInitInstaller({
      cwd: tempDir,
      prompts: prompts as any,
      dryRun: true,
    });

    expect(code).toBe(0);
    expect(existsSync(join(tempDir, "opencode.jsonc"))).toBe(false);
    expect(existsSync(join(tempDir, "opencode-quota", "quota-toast.json"))).toBe(false);
    expect(prompts.outroCalls).toContain(
      "OpenCode Quota setup preview complete — no files changed. Run npx @slkiser/opencode-quota@latest init to apply.",
    );
  });

  it("returns one when planning fails after prompt collection", async () => {
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

    const logError = vi.fn();
    const prompts = createPromptStub({
      selectValues: [
        "tui",
        "project",
        "jsonc",
        "inline",
        "auto",
        "singleWindow",
        "remaining",
        "yes",
      ],
      multiselectValues: [["toast"]],
    });
    prompts.log.error = logError;

    const code = await runInitInstaller({
      cwd: projectDir,
      prompts: prompts as any,
    });

    expect(code).toBe(1);
    expect(logError).toHaveBeenCalledWith(expect.stringMatching(/plugin is not an array/i));
  });

  it("writes @latest for a new install and is idempotent", async () => {
    const projectDir = join(tempDir, "project-latest");
    mkdirSync(projectDir, { recursive: true });
    const selections = {
      interfaces: "tui" as const,
      scope: "project" as const,
      quotaUi: ["toast"] as const,
      providerMode: "auto" as const,
      manualProviders: [],
      formatStyle: "singleWindow" as const,
      percentDisplayMode: "remaining" as const,
      showSessionTokens: true,
    };

    const firstPlan = await planInitInstaller({ cwd: projectDir, selections });
    await applyInitInstallerPlan(firstPlan);
    expect(readJson(join(projectDir, "opencode.jsonc")).plugin).toEqual([
      "@slkiser/opencode-quota@latest",
    ]);

    const secondPlan = await planInitInstaller({ cwd: projectDir, selections });
    expect(secondPlan.edits.find((edit) => edit.kind === "opencode")?.changed).toBe(false);
  });

  it("preserves existing exact, range, tag, tuple, and local specs", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });
    const existingPlugins = [
      "@slkiser/opencode-quota@3.11.1",
      ["@slkiser/opencode-quota@next", { keep: true }],
      "@slkiser/opencode-quota@^3.0.0",
      "file:../opencode-quota",
    ];
    writeFileSync(
      join(projectDir, "opencode.json"),
      JSON.stringify({ plugin: existingPlugins }),
      "utf8",
    );

    const selections = {
      interfaces: "tui" as const,
      scope: "project" as const,
      quotaUi: ["toast"] as const,
      providerMode: "auto" as const,
      manualProviders: [],
      formatStyle: "singleWindow" as const,
      percentDisplayMode: "remaining" as const,
      showSessionTokens: true,
    };
    const firstPlan = await planInitInstaller({ cwd: projectDir, selections });
    await applyInitInstallerPlan(firstPlan);
    expect(readJson(join(projectDir, "opencode.jsonc")).plugin).toEqual(existingPlugins);

    const secondPlan = await planInitInstaller({ cwd: projectDir, selections });
    expect(secondPlan.edits.find((edit) => edit.kind === "opencode")?.changed).toBe(false);
  });

  it("installs Web server-only and removes only canonical quota package entries", async () => {
    const projectDir = join(tempDir, "web-only");
    mkdirSync(join(projectDir, "opencode-quota"), { recursive: true });
    writeFileSync(
      join(projectDir, "tui.jsonc"),
      `{
        // keep this comment
        "plugin": [
          "@slkiser/opencode-quota",
          "@slkiser/opencode-quota@latest",
          ["@slkiser/opencode-quota@4.0.0", { "source": "tuple" }],
          "@slkiser/opencode-quota-helper",
          "@slkiser/opencode-quota/latest",
          "custom:@slkiser/opencode-quota",
          "file:///tmp/opencode-quota/dist/tui.js",
          "./opencode-quota",
          ["node", "./opencode-quota.js"],
          { "package": "@slkiser/opencode-quota", "command": "run" },
          "other-tui-plugin"
        ],
        "tui": {
          "plugin": [
            "@slkiser/opencode-quota@4.0.0-beta.1",
            ["bun", "custom-command"],
            { "spec": "@slkiser/opencode-quota@latest" }
          ]
        },
        "theme": "dark"
      }`,
      "utf8",
    );

    const plan = await planInitInstaller({
      cwd: projectDir,
      selections: {
        interfaces: "web",
        scope: "project",
        quotaUi: ["sidebar", "toast"],
        providerMode: "auto",
        manualProviders: [],
        formatStyle: "singleWindow",
        percentDisplayMode: "remaining",
        showSessionTokens: false,
      },
    });

    expect(plan.summaryLines).toContain("Interface: Web");
    expect(plan.summaryLines.some((line) => line.startsWith("TUI surfaces:"))).toBe(false);
    expect(plan.summaryLines.some((line) => line.startsWith("Command display:"))).toBe(false);
    expect(plan.edits.map((edit) => edit.kind)).toEqual(["opencode", "quota", "tui"]);

    await applyInitInstallerPlan(plan);

    const tuiRaw = readFileSync(join(projectDir, "tui.jsonc"), "utf8");
    expect(tuiRaw).toContain("// keep this comment");
    expect(tuiRaw).toContain('["node", "./opencode-quota.js"]');
    expect(tuiRaw).toContain('{ "package": "@slkiser/opencode-quota", "command": "run" }');
    expect(tuiRaw).toContain('["bun", "custom-command"]');
    expect(readJson(join(projectDir, "tui.jsonc"))).toEqual({
      plugin: [
        "@slkiser/opencode-quota-helper",
        "@slkiser/opencode-quota/latest",
        "custom:@slkiser/opencode-quota",
        "file:///tmp/opencode-quota/dist/tui.js",
        "./opencode-quota",
        ["node", "./opencode-quota.js"],
        { package: "@slkiser/opencode-quota", command: "run" },
        "other-tui-plugin",
      ],
      tui: {
        plugin: [["bun", "custom-command"], { spec: "@slkiser/opencode-quota@latest" }],
      },
      theme: "dark",
    });
    expect(readJson(join(projectDir, "opencode.jsonc")).plugin).toEqual([
      "@slkiser/opencode-quota@latest",
    ]);
    const quotaConfig = readJson(join(projectDir, "opencode-quota", "quota-toast.jsonc"));
    expect(quotaConfig.enableToast).toBe(false);
    expect(quotaConfig.tuiCommandDisplay).toBeUndefined();
  });

  it("preserves unrelated JSONC comments and trailing commas during an in-place rerun edit", async () => {
    const projectDir = join(tempDir, "jsonc-comment-rerun");
    mkdirSync(join(projectDir, "opencode-quota"), { recursive: true });
    const sidecarPath = join(projectDir, "opencode-quota", "quota-toast.jsonc");
    writeFileSync(
      sidecarPath,
      `{
        // keep root comment
        "enableToast": true,
        "enabledProviders": ["openai"],
        "formatStyle": "singleWindow",
        "percentDisplayMode": "remaining",
        "showSessionTokens": false,
        "tuiCommandDisplay": "inline",
        "tuiSidebarPanel": { "enabled": true },
        // keep unrelated section comment
        "unrelated": {
          "keep": true,
        },
      }`,
      "utf8",
    );

    const plan = await planInitInstaller({
      cwd: projectDir,
      selections: {
        interfaces: "tui",
        scope: "project",
        configFormat: "jsonc",
        quotaUi: ["toast"],
        providerMode: "manual",
        manualProviders: ["anthropic"],
        formatStyle: "allWindows",
        percentDisplayMode: "used",
        showSessionTokens: true,
        tuiCommandDisplay: "dialog",
        maintainerAnnouncements: false,
      },
    });
    await applyInitInstallerPlan(plan);

    const raw = readFileSync(sidecarPath, "utf8");
    expect(raw).toContain("// keep root comment");
    expect(raw).toContain("// keep unrelated section comment");
    expect(raw).toMatch(/"keep": true,\s*}/);
    expect(raw).toContain('"enabled": false\n        },');
    expect(readJson(sidecarPath)).toMatchObject({
      enabledProviders: ["anthropic"],
      formatStyle: "allWindows",
      unrelated: { keep: true },
    });
  });

  it("prefers JSONC deterministically when both quota sidecars exist", async () => {
    const projectDir = join(tempDir, "both-sidecars");
    mkdirSync(join(projectDir, "opencode-quota"), { recursive: true });
    const jsoncPath = join(projectDir, "opencode-quota", "quota-toast.jsonc");
    const jsonPath = join(projectDir, "opencode-quota", "quota-toast.json");
    writeFileSync(jsoncPath, '{ // preferred\n  "enabledProviders": ["openai"],\n}\n', "utf8");
    writeFileSync(jsonPath, JSON.stringify({ enabledProviders: ["chutes"] }), "utf8");

    const plan = await planInitInstaller({
      cwd: projectDir,
      selections: {
        interfaces: "web",
        scope: "project",
        configFormat: "jsonc",
        quotaUi: ["none"],
        providerMode: "manual",
        manualProviders: ["anthropic"],
        formatStyle: "singleWindow",
        percentDisplayMode: "remaining",
        showSessionTokens: false,
      },
    });
    expect(plan.warnings).toContain(
      "Both quota-toast.jsonc and quota-toast.json exist; using JSONC and preserving the JSON file.",
    );
    await applyInitInstallerPlan(plan);

    expect(readJson(jsoncPath).enabledProviders).toEqual(["anthropic"]);
    expect(readJson(jsonPath).enabledProviders).toEqual(["chutes"]);
  });

  it("refuses malformed preferred JSONC without changing either sidecar", async () => {
    const projectDir = join(tempDir, "malformed-sidecar");
    mkdirSync(join(projectDir, "opencode-quota"), { recursive: true });
    const jsoncPath = join(projectDir, "opencode-quota", "quota-toast.jsonc");
    const jsonPath = join(projectDir, "opencode-quota", "quota-toast.json");
    const malformed = '{ "enabledProviders": [';
    const valid = JSON.stringify({ enabledProviders: ["openai"] });
    writeFileSync(jsoncPath, malformed, "utf8");
    writeFileSync(jsonPath, valid, "utf8");

    await expect(
      planInitInstaller({
        cwd: projectDir,
        selections: {
          interfaces: "web",
          scope: "project",
          configFormat: "jsonc",
          quotaUi: ["none"],
          providerMode: "auto",
          manualProviders: [],
          formatStyle: "singleWindow",
          percentDisplayMode: "remaining",
          showSessionTokens: false,
        },
      }),
    ).rejects.toThrow("Failed to parse quota-toast.jsonc");
    expect(readFileSync(jsoncPath, "utf8")).toBe(malformed);
    expect(readFileSync(jsonPath, "utf8")).toBe(valid);
  });

  it("converts an existing quota-toast.json to validated JSONC and removes the source", async () => {
    const projectDir = join(tempDir, "quota-jsonc-migration");
    mkdirSync(join(projectDir, "opencode-quota"), { recursive: true });
    const sourcePath = join(projectDir, "opencode-quota", "quota-toast.json");
    writeFileSync(
      sourcePath,
      JSON.stringify({
        enableToast: true,
        enabledProviders: ["openai"],
        unrelated: { keep: true },
      }),
      "utf8",
    );

    const plan = await planInitInstaller({
      cwd: projectDir,
      selections: {
        interfaces: "both",
        scope: "project",
        configFormat: "jsonc",
        quotaUi: ["sidebar"],
        providerMode: "manual",
        manualProviders: ["anthropic"],
        formatStyle: "allWindows",
        percentDisplayMode: "used",
        showSessionTokens: true,
        tuiCommandDisplay: "inline",
        maintainerAnnouncements: false,
      },
    });
    expect(plan.summaryLines).toContain(
      `convert: ${sourcePath} -> ${join(projectDir, "opencode-quota", "quota-toast.jsonc")}`,
    );

    await applyInitInstallerPlan(plan);

    expect(existsSync(sourcePath)).toBe(false);
    const targetPath = join(projectDir, "opencode-quota", "quota-toast.jsonc");
    const raw = readFileSync(targetPath, "utf8");
    expect(raw).toContain("// Provider selection:");
    expect(readJson(targetPath)).toMatchObject({
      enableToast: false,
      enabledProviders: ["anthropic"],
      unrelated: { keep: true },
    });
  });

  it("preflights every OpenCode config before the first installer write", async () => {
    const projectDir = join(tempDir, "preflight");
    mkdirSync(projectDir, { recursive: true });
    const plan = await planInitInstaller({
      cwd: projectDir,
      selections: {
        interfaces: "tui",
        scope: "project",
        quotaUi: ["sidebar"],
        providerMode: "auto",
        manualProviders: [],
        formatStyle: "singleWindow",
        percentDisplayMode: "remaining",
        showSessionTokens: true,
      },
    });

    writeFileSync(join(projectDir, "tui.jsonc"), '{"theme":"raced"}\n', "utf8");

    await expect(applyInitInstallerPlan(plan)).rejects.toThrow("changed since preview");
    expect(existsSync(join(projectDir, "opencode.jsonc"))).toBe(false);
    expect(readFileSync(join(projectDir, "tui.jsonc"), "utf8")).toBe('{"theme":"raced"}\n');
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
          interfaces: "tui",
          scope: "project",
          quotaUi: ["toast"],
          providerMode: "auto",
          manualProviders: [],
          formatStyle: "singleWindow",
          percentDisplayMode: "remaining",
          showSessionTokens: true,
        },
      }),
    ).rejects.toThrow(/plugin is not an array/i);
  });
});
