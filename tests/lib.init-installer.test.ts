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
  const content = readFileSync(path, "utf8");
  return parseJsonOrJsonc(content, path.endsWith(".jsonc"));
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

  it("creates project opencode.json at the worktree root for toast mode", async () => {
    const projectDir = join(tempDir, "project");
    const nestedDir = join(projectDir, "packages", "feature");
    mkdirSync(join(projectDir, ".git"), { recursive: true });
    mkdirSync(nestedDir, { recursive: true });

    const plan = await planInitInstaller({
      cwd: nestedDir,
      selections: {
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
    expect(plan.edits.map((edit) => edit.kind)).toEqual(["opencode", "quota"]);
    expect(plan.quickSetupNotes).toEqual([
      {
        providerId: "anthropic",
        label: "Anthropic",
        anchor: "anthropic-claude",
      },
    ]);

    const result = await applyInitInstallerPlan(plan);
    expect(result.writtenPaths).toEqual([
      join(projectDir, "opencode.json"),
      join(projectDir, "opencode-quota", "quota-toast.json"),
    ]);

    const config = readJson(join(projectDir, "opencode.json"));
    expect(config).toMatchObject({
      $schema: "https://opencode.ai/config.json",
      plugin: ["@slkiser/opencode-quota"],
    });
    expect(config.experimental).toBeUndefined();

    const quotaConfig = readJson(join(projectDir, "opencode-quota", "quota-toast.json"));
    expect(quotaConfig).toMatchObject({
      enableToast: true,
      enabledProviders: ["openai", "anthropic"],
      formatStyle: "allWindows",
      percentDisplayMode: "used",
      showSessionTokens: false,
    });
  });

  it("writes legacy experimental.quotaToast only when explicitly requested", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });

    const plan = await planInitInstaller({
      cwd: projectDir,
      syncLegacyConfig: true,
      selections: {
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

    const opencode = readJson(join(projectDir, "opencode.json"));
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
    expect(opencodeEdit?.warnings).toContain(
      "Existing JSONC comments/trailing commas will be stripped.",
    );
    expect(opencodeEdit?.addedPlugins).toEqual([]);
    expect(opencodeEdit?.addedKeys).toEqual(
      [],
    );
    expect(opencodeEdit?.skippedValues).toEqual(
      expect.arrayContaining([
        "plugin already includes @slkiser/opencode-quota",
      ]),
    );
    const quotaEdit = plan.edits.find((edit) => edit.kind === "quota");
    expect(quotaEdit?.addedKeys).toEqual(
      expect.arrayContaining([
        "opencode-quota/quota-toast.json (seeded from experimental.quotaToast)",
        "quotaToast.formatStyle",
        "quotaToast.percentDisplayMode",
      ]),
    );
    expect(quotaEdit?.updatedKeys).toContain("quotaToast.enableToast");
    expect(quotaEdit?.skippedValues).toEqual(
      expect.arrayContaining([
        "quotaToast.showSessionTokens preserved existing value",
        "quotaToast.enabledProviders preserved existing value",
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
      enableToast: true,
      showSessionTokens: true,
      enabledProviders: ["openai"],
    });
    expect(opencode.experimental.quotaToast.formatStyle).toBeUndefined();
    const quotaConfig = readJson(join(projectDir, "opencode-quota", "quota-toast.json"));
    expect(quotaConfig).toMatchObject({
      toastStyle: "grouped",
      formatStyle: "allWindows",
      percentDisplayMode: "remaining",
      enableToast: false,
      showSessionTokens: true,
      enabledProviders: ["openai"],
    });

    const tui = readJson(join(projectDir, "tui.json"));
    expect(tui.$schema).toBe("https://opencode.ai/tui.json");
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
    expect(opencodeEdit?.addedPlugins).toEqual(["plugin: @slkiser/opencode-quota"]);

    await applyInitInstallerPlan(plan);

    const opencode = readJson(join(projectDir, "opencode.json"));
    expect(opencode.plugin).toEqual([
      "file:///Users/test/Downloads/GitHub/opencode-quota/dist/tui.tsx",
      "@slkiser/opencode-quota",
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
        scope: "project",
        quotaUi: ["toast"],
        providerMode: "auto",
        manualProviders: [],
        formatStyle: "singleWindow",
        percentDisplayMode: "remaining",
        showSessionTokens: true,
      },
    });

    expect(plan.edits.map((edit) => edit.kind)).toEqual(["opencode", "quota"]);

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
    expect(tuiEdit?.addedPlugins).toEqual(["plugin: @slkiser/opencode-quota"]);

    await applyInitInstallerPlan(plan);

    const tui = readJson(join(projectDir, "tui.json"));
    expect(tui.plugin).toEqual([
      "file:///Users/test/Downloads/GitHub/opencode-quota/dist/index.js",
      "@slkiser/opencode-quota",
    ]);
  });

  it("creates both opencode and tui targets for sidebar mode and appends missing plugins", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });

    const plan = await planInitInstaller({
      cwd: projectDir,
      selections: {
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

    const opencode = readJson(join(projectDir, "opencode.json"));
    const tui = readJson(join(projectDir, "tui.json"));

    expect(opencode.plugin).toEqual(["@slkiser/opencode-quota"]);
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
      plugin: ["@slkiser/opencode-quota"],
    });
  });

  it("leaves compact TUI status alone when not selected for fresh sidebar installs", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });

    const plan = await planInitInstaller({
      cwd: projectDir,
      selections: {
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

    expect(existsSync(join(projectDir, "opencode.json"))).toBe(true);
    expect(existsSync(join(projectDir, "tui.json"))).toBe(true);
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
        scope: "project",
        quotaUi: ["sidebar", "compact_status"],
        providerMode: "auto",
        manualProviders: [],
        formatStyle: "singleWindow",
        percentDisplayMode: "remaining",
        showSessionTokens: true,
      },
    });

    expect(plan.summaryLines).toContain("Quota UI: Sidebar + Compact status");
    expect(plan.summaryLines).toContain("Compact status mode: Home bottom + session prompt");

    await applyInitInstallerPlan(plan);

    expect(existsSync(join(projectDir, "tui.json"))).toBe(true);
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
    expect(plan.summaryLines).toContain("Quota UI: Compact status");
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

    expect(plan.summaryLines).toContain("Quota UI: Terminal only");
    expect(plan.summaryLines).toContain("Maintainer announcements: Disabled");
    expect(plan.edits.map((edit) => edit.kind)).toEqual(["opencode", "quota"]);

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
    expect(plan.edits.map((edit) => edit.kind)).toEqual(["opencode", "quota"]);

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

  it("normalizes empty and mixed none quota UI choices defensively", async () => {
    const emptyPlan = await planInitInstaller({
      cwd: tempDir,
      selections: {
        scope: "project",
        quotaUi: [],
        providerMode: "auto",
        manualProviders: [],
        formatStyle: "singleWindow",
        percentDisplayMode: "remaining",
        showSessionTokens: true,
      },
    });
    expect(emptyPlan.selections.quotaUi).toEqual(["none"]);
    expect(emptyPlan.edits.map((edit) => edit.kind)).toEqual(["opencode", "quota"]);

    const mixedNonePlan = await planInitInstaller({
      cwd: tempDir,
      selections: {
        scope: "project",
        quotaUi: ["none", "toast", "sidebar"],
        providerMode: "auto",
        manualProviders: [],
        formatStyle: "singleWindow",
        percentDisplayMode: "remaining",
        showSessionTokens: true,
      },
    });
    expect(mixedNonePlan.selections.quotaUi).toEqual(["toast", "sidebar"]);
    expect(mixedNonePlan.summaryLines).toContain("Quota UI: Toast + Sidebar");
  });

  it("normalizes legacy quota UI strings defensively", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });

    const plan = await planInitInstaller({
      cwd: projectDir,
      selections: {
        scope: "project",
        quotaUi: "toast_sidebar",
        providerMode: "auto",
        manualProviders: [],
        formatStyle: "singleWindow",
        percentDisplayMode: "remaining",
        showSessionTokens: true,
      } as any,
    });

    expect(plan.selections.quotaUi).toEqual(["toast", "sidebar"]);
    expect(plan.edits.map((edit) => edit.kind)).toEqual(["opencode", "quota", "tui"]);

    await applyInitInstallerPlan(plan);

    const quotaConfig = readJson(join(projectDir, "opencode-quota", "quota-toast.json"));
    expect(quotaConfig.enableToast).toBe(true);
  });

  it("maps legacy compact session-prompt config to compact sync when requested", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });

    const plan = await planInitInstaller({
      cwd: projectDir,
      syncLegacyConfig: true,
      selections: {
        scope: "project",
        quotaUi: ["toast", "sidebar"],
        providerMode: "auto",
        manualProviders: [],
        formatStyle: "singleWindow",
        percentDisplayMode: "remaining",
        showSessionTokens: true,
        tuiCompactStatus: "home_bottom_session_prompt",
      } as any,
    });

    expect(plan.warnings).not.toContain(
      "sessionPrompt wraps OpenCode's core prompt slot and may conflict with other prompt-slot integrations.",
    );
    expect(plan.summaryLines).toContain("Compact status mode: Home bottom + session prompt");

    await applyInitInstallerPlan(plan);

    const quotaConfig = readJson(join(projectDir, "opencode-quota", "quota-toast.json"));
    const opencode = readJson(join(projectDir, "opencode.json"));
    expect(quotaConfig.tuiCompactStatus.sessionPrompt).toBe(true);
    expect(opencode.experimental.quotaToast.tuiCompactStatus).toEqual(quotaConfig.tuiCompactStatus);
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

  it("tolerates legacy compact status without adding sidebar intent", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });

    const plan = await planInitInstaller({
      cwd: projectDir,
      selections: {
        scope: "project",
        quotaUi: ["toast"],
        providerMode: "auto",
        manualProviders: [],
        formatStyle: "singleWindow",
        percentDisplayMode: "remaining",
        showSessionTokens: true,
        tuiCompactStatus: "home_bottom",
      } as any,
    });

    expect(plan.selections.quotaUi).toEqual(["toast", "compact_status"]);
    expect(plan.edits.map((edit) => edit.kind)).toEqual(["opencode", "quota", "tui"]);
  });

  it("prompts for quota UI as a multiselect and does not ask a separate compact status question", async () => {
    const prompts = createPromptStub({
      selectValues: ["project", "auto", "singleWindow", "remaining", "yes"],
      multiselectValues: [["sidebar", "compact_status"]],
      confirmValues: [true, true],
    });

    const code = await runInitInstaller({
      cwd: tempDir,
      prompts: prompts as any,
    });

    expect(code).toBe(0);
    expect(prompts.outroCalls).toContain(
      "Quota init complete — if this helps, stars are appreciated: https://github.com/slkiser/opencode-quota",
    );
    expect(prompts.multiselectCalls[0]).toMatchObject({
      message: "Quota UI",
      required: true,
    });
    expect(prompts.multiselectCalls[0]?.options).toEqual([
      { label: "Toast", value: "toast", hint: "popup quota summaries after idle/question/compact events" },
      { label: "Sidebar panel", value: "sidebar", hint: "full Quota panel in the OpenCode session sidebar" },
      { label: "Compact status line", value: "compact_status", hint: "short quota summary in the TUI status area" },
      {
        label: "Terminal command only",
        value: "none",
        hint: "no toast, sidebar, compact status, or TUI slash-command dialogs",
      },
    ]);
    const sessionTokenCall = prompts.selectCalls.find((call) => call.message === "Session token details");
    expect(sessionTokenCall?.options).toEqual([
      { label: "Hide session tokens", value: "no", hint: "keep quota output shorter" },
      { label: "Show session tokens", value: "yes", hint: "include current session input/output token counts when available" },
    ]);
    const messages = prompts.selectCalls.map((call) => call.message);
    expect(messages).not.toContain("Compact TUI status");
    expect(prompts.confirmCalls[0]).toEqual({
      message: "Show bundled maintainer notices automatically when available?",
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

  it("prompt No for maintainer announcements writes opt-out and does not install TUI only for notices", async () => {
    const prompts = createPromptStub({
      selectValues: ["project", "auto", "singleWindow", "remaining", "yes"],
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
        scope: "project",
        quotaUi: ["toast", "sidebar"],
        providerMode: "auto",
        manualProviders: [],
        formatStyle: "singleWindow",
        percentDisplayMode: "remaining",
        showSessionTokens: true,
      },
    });

    expect(plan.summaryLines).toContain("Quota UI: Toast + Sidebar");
    expect(plan.summaryLines).toContain("Quota reset periods: Single window");
    expect(plan.summaryLines).toContain("Quota percentage meaning: Remaining");
    expect(plan.edits.map((edit) => edit.kind)).toEqual(["opencode", "quota", "tui"]);

    await applyInitInstallerPlan(plan);

    const opencode = readJson(join(projectDir, "opencode.json"));
    const tui = readJson(join(projectDir, "tui.json"));

    expect(opencode.plugin).toEqual(["@slkiser/opencode-quota"]);
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
        quotaUi: ["none"],
        providerMode: "auto",
        manualProviders: [],
        formatStyle: "singleWindow",
        percentDisplayMode: "remaining",
        showSessionTokens: true,
      },
    });

    expect(plan.edits.map((edit) => edit.kind)).toEqual(["opencode", "quota"]);

    await applyInitInstallerPlan(plan);

    expect(existsSync(join(projectDir, "tui.json"))).toBe(false);
    const opencode = readJson(join(projectDir, "opencode.json"));
    expect(opencode.experimental).toBeUndefined();
    const quotaConfig = readJson(join(projectDir, "opencode-quota", "quota-toast.json"));
    expect(quotaConfig.enableToast).toBe(false);
    expect(quotaConfig.tuiSidebarPanel).toEqual({ enabled: false });
  });

  it("returns zero when the user cancels before applying changes", async () => {
    const prompts = createPromptStub({
      selectValues: ["project", "auto", "singleWindow", "remaining", "yes"],
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
      selectValues: ["project", "auto", "singleWindow", "remaining", "yes"],
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
