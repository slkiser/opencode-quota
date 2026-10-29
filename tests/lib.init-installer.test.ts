import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  applyInitInstallerPlan,
  type InitInstallerSelections,
  planInitInstaller,
  runInitInstaller,
} from "../src/lib/init-installer.js";
import { parseJsonOrJsonc } from "../src/lib/jsonc.js";

function readJson(path: string): any {
  const resolvedPath = !existsSync(path) && path.endsWith(".json") ? `${path}c` : path;
  const content = readFileSync(resolvedPath, "utf8");
  return parseJsonOrJsonc(content, resolvedPath.endsWith(".jsonc"));
}

function installerSelections(
  overrides: Partial<InitInstallerSelections> = {},
): InitInstallerSelections {
  return {
    interfaces: "tui",
    scope: "project",
    quotaUi: ["toast"],
    providerMode: "auto",
    manualProviders: [],
    formatStyle: "singleWindow",
    percentDisplayMode: "remaining",
    showSessionTokens: true,
    ...overrides,
  };
}

const DEFAULT_PROMPT_SELECT_VALUES = [
  "tui",
  "project",
  "jsonc",
  "inline",
  "auto",
  "singleWindow",
  "remaining",
  "yes",
  "current",
] as const;

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

  function planSelections(overrides: Partial<InitInstallerSelections> = {}, cwd = tempDir) {
    return planInitInstaller({ cwd, selections: installerSelections(overrides) });
  }

  async function expectSelectionError(
    overrides: Partial<InitInstallerSelections>,
    error: string | RegExp,
  ): Promise<void> {
    await expect(planSelections(overrides)).rejects.toThrow(error);
  }

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
      selections: installerSelections({
        providerMode: "manual",
        manualProviders: ["openai", "anthropic"],
        formatStyle: "allWindows",
        percentDisplayMode: "used",
        showSessionTokens: false,
        sessionTokenScope: "tree",
      }),
    });

    expect(plan.baseDir).toBe(projectDir);
    expect(plan.summaryLines).toContain("Session token scope: Current session and descendants");
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
      plugin: ["@slkiser/opencode-quota@4"],
    });
    expect(config.experimental).toBeUndefined();

    const quotaConfig = readJson(join(projectDir, "opencode-quota", "quota-toast.json"));
    expect(quotaConfig).toMatchObject({
      enableToast: true,
      enabledProviders: ["openai", "anthropic"],
      formatStyle: "allWindows",
      percentDisplayMode: "used",
      showSessionTokens: false,
      sessionTokenScope: "tree",
      tuiCommandDisplay: "inline",
    });
    expect(quotaConfig).not.toHaveProperty("tuiQuotaCommandDisplay");
    expect(readFileSync(join(projectDir, "opencode.jsonc"), "utf8")).not.toContain(
      "tuiCommandDisplay",
    );
  });

  it("creates strict comment-free JSON when JSON is selected", async () => {
    const projectDir = join(tempDir, "strict-json");
    mkdirSync(projectDir, { recursive: true });

    const plan = await planInitInstaller({
      cwd: projectDir,
      selections: installerSelections({ configFormat: "json" }),
    });
    await applyInitInstallerPlan(plan);

    const path = join(projectDir, "opencode.json");
    const raw = readFileSync(path, "utf8");
    expect(existsSync(join(projectDir, "opencode.jsonc"))).toBe(false);
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(raw).not.toMatch(/^\s*\/\//m);
    const quotaRaw = readFileSync(join(projectDir, "opencode-quota", "quota-toast.json"), "utf8");
    expect(JSON.parse(quotaRaw).tuiCommandDisplay).toBe("inline");
    expect(JSON.parse(quotaRaw).sessionTokenScope).toBe("current");
    expect(plan.summaryLines).toContain("Session token scope: Current session");
    expect(quotaRaw).not.toContain("//");
  });

  it("writes the Dialog selection and its comment to the JSONC quota config, not the host configs", async () => {
    const projectDir = join(tempDir, "dialog-jsonc");
    mkdirSync(projectDir, { recursive: true });
    const selections = installerSelections({
      configFormat: "jsonc",
      quotaUi: ["sidebar"],
      tuiCommandDisplay: "dialog",
    });

    const plan = await planInitInstaller({ cwd: projectDir, selections });
    await applyInitInstallerPlan(plan);

    expect(plan.summaryLines).toContain("Command display: Popup dialog");
    const quotaPath = join(projectDir, "opencode-quota", "quota-toast.jsonc");
    expect(readJson(quotaPath).tuiCommandDisplay).toBe("dialog");
    const quotaRaw = readFileSync(quotaPath, "utf8");
    expect(quotaRaw).toContain("// Quota presentation and reset-period choices.");
    expect(quotaRaw).toMatch(
      /\/\/ TUI command output: "inline" in the session transcript, or "dialog" in a local popup\.\n\s*"tuiCommandDisplay": "dialog"/,
    );

    const hostPaths = [join(projectDir, "opencode.jsonc"), join(projectDir, "tui.jsonc")];
    for (const hostPath of hostPaths) {
      const raw = readFileSync(hostPath, "utf8");
      expect(raw).toContain("// OpenCode Quota: loads the");
      expect(raw).not.toContain("tuiCommandDisplay");
      expect(() => parseJsonOrJsonc(raw, true)).not.toThrow();
    }

    await applyInitInstallerPlan(await planInitInstaller({ cwd: projectDir, selections }));
    expect(readFileSync(quotaPath, "utf8").match(/TUI command output:/g)).toHaveLength(1);
    for (const hostPath of hostPaths) {
      expect(readFileSync(hostPath, "utf8").match(/OpenCode Quota: loads the/g)).toHaveLength(1);
    }
  });

  it("writes legacy experimental.quotaToast only when explicitly requested", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });

    const plan = await planInitInstaller({
      cwd: projectDir,
      syncLegacyConfig: true,
      selections: installerSelections({
        providerMode: "manual",
        manualProviders: ["openai"],
        formatStyle: "allWindows",
        percentDisplayMode: "used",
        showSessionTokens: false,
      }),
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
      selections: installerSelections({
        quotaUi: ["sidebar"],
        providerMode: "manual",
        manualProviders: ["cursor", "opencode-go"],
        showSessionTokens: false,
      }),
    });

    const opencodeEdit = plan.edits.find((edit) => edit.kind === "opencode");
    const tuiEdit = plan.edits.find((edit) => edit.kind === "tui");
    expect(opencodeEdit?.warnings).toEqual([]);
    expect(opencodeEdit?.addedPlugins).toEqual([]);
    expect(opencodeEdit?.addedKeys).toEqual([]);
    expect(opencodeEdit?.skippedValues).toEqual(
      expect.arrayContaining([
        "plugin already includes file:///Users/test/Downloads/GitHub/opencode-quota/dist/index.js",
      ]),
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
      "tui config already includes file:///Users/test/Downloads/GitHub/opencode-quota/dist/tui.tsx",
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

    const plan = await planSelections({}, projectDir);

    const opencodeEdit = plan.edits.find((edit) => edit.kind === "opencode");
    expect(opencodeEdit?.addedPlugins).toEqual(["plugin: @slkiser/opencode-quota@4"]);

    await applyInitInstallerPlan(plan);

    const opencode = readJson(join(projectDir, "opencode.jsonc"));
    expect(opencode.plugin).toEqual([
      "file:///Users/test/Downloads/GitHub/opencode-quota/dist/tui.tsx",
      "@slkiser/opencode-quota@4",
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

    const plan = await planSelections({}, projectDir);

    expect(plan.edits.map((edit) => edit.kind)).toEqual(["opencode", "quota", "tui"]);

    await applyInitInstallerPlan(plan);

    const tui = readJson(join(projectDir, "tui.json"));
    expect(tui).toEqual({ plugin: ["@slkiser/opencode-quota@4"] });
    const quotaConfig = readJson(join(projectDir, "opencode-quota", "quota-toast.json"));
    expect(quotaConfig.tuiSidebarPanel).toEqual({ enabled: false });
  });

  it("pins entries that follow npm latest to @4, since OpenCode Quota 5 needs OpenCode 2", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "opencode.json"),
      JSON.stringify({ plugin: ["other-plugin@1.0.0", "@slkiser/opencode-quota@latest"] }),
      "utf8",
    );
    writeFileSync(
      join(projectDir, "tui.json"),
      JSON.stringify({ plugin: [["@slkiser/opencode-quota", { keep: true }]] }),
      "utf8",
    );

    const plan = await planSelections({}, projectDir);
    expect(plan.edits.find((edit) => edit.kind === "opencode")?.valueChanges).toEqual([
      'plugin: "@slkiser/opencode-quota@latest" -> "@slkiser/opencode-quota@4" (OpenCode Quota 5 needs OpenCode 2)',
    ]);
    await applyInitInstallerPlan(plan);

    expect(readJson(join(projectDir, "opencode.json")).plugin).toEqual([
      "other-plugin@1.0.0",
      "@slkiser/opencode-quota@4",
    ]);
    expect(readJson(join(projectDir, "tui.json")).plugin).toEqual([
      ["@slkiser/opencode-quota@4", { keep: true }],
    ]);
    const secondPlan = await planSelections({}, projectDir);
    expect(secondPlan.edits.every((edit) => edit.valueChanges.length === 0)).toBe(true);
  });

  it("prints only the pin line after pinning, and 'already includes @4' once per file on a rerun", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });
    for (const name of ["opencode.jsonc", "tui.jsonc"]) {
      writeFileSync(
        join(projectDir, name),
        '{\n  "plugin": ["@slkiser/opencode-quota@latest"]\n}\n',
        "utf8",
      );
    }

    const plan = await planSelections({ quotaUi: ["sidebar"] }, projectDir);
    const pinLine =
      '    plugin: "@slkiser/opencode-quota@latest" -> "@slkiser/opencode-quota@4" (OpenCode Quota 5 needs OpenCode 2)';
    expect(plan.summaryLines.filter((line) => line === pinLine)).toHaveLength(2);
    expect(plan.summaryLines.filter((line) => line.includes("already includes"))).toEqual([]);
    await applyInitInstallerPlan(plan);

    const secondPlan = await planSelections({ quotaUi: ["sidebar"] }, projectDir);
    expect(secondPlan.summaryLines.filter((line) => line.includes("already includes"))).toEqual([
      "  = plugin already includes @slkiser/opencode-quota@4",
      "  = tui config already includes @slkiser/opencode-quota@4",
    ]);
  });

  it("names the quota entry that is really there in 'already includes'", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });
    for (const name of ["opencode.json", "tui.json"]) {
      writeFileSync(
        join(projectDir, name),
        JSON.stringify({ plugin: ["@slkiser/opencode-quota@4.10.6"] }),
        "utf8",
      );
    }

    const plan = await planSelections({ quotaUi: ["sidebar"] }, projectDir);
    expect(plan.edits.find((edit) => edit.kind === "opencode")?.skippedValues).toEqual([
      "plugin already includes @slkiser/opencode-quota@4.10.6",
    ]);
    expect(plan.edits.find((edit) => edit.kind === "tui")?.skippedValues).toEqual([
      "tui config already includes @slkiser/opencode-quota@4.10.6",
    ]);
  });

  it("keeps the comments inside a plugin list when it pins an entry to @4", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "opencode.jsonc"),
      `{
  "plugin": [
    // Keep this other plugin pinned
    "other-plugin@1.0.0",
    ["@slkiser/opencode-quota@latest", {
      // Custom option explanation
      "keep": true
    }]
  ]
}
`,
      "utf8",
    );

    await applyInitInstallerPlan(await planSelections({}, projectDir));

    const written = readFileSync(join(projectDir, "opencode.jsonc"), "utf8");
    expect(written).toContain("// Keep this other plugin pinned");
    expect(written).toContain("// Custom option explanation");
    expect(readJson(join(projectDir, "opencode.jsonc")).plugin).toEqual([
      "other-plugin@1.0.0",
      ["@slkiser/opencode-quota@4", { keep: true }],
    ]);
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

    const plan = await planSelections({ quotaUi: ["sidebar"] }, projectDir);

    const tuiEdit = plan.edits.find((edit) => edit.kind === "tui");
    expect(tuiEdit?.addedPlugins).toEqual(["plugin: @slkiser/opencode-quota@4"]);

    await applyInitInstallerPlan(plan);

    const tui = readJson(join(projectDir, "tui.jsonc"));
    expect(tui.plugin).toEqual([
      "file:///Users/test/Downloads/GitHub/opencode-quota/dist/index.js",
      "@slkiser/opencode-quota@4",
    ]);
  });

  it("creates both opencode and tui targets for sidebar mode and appends missing plugins", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });

    const plan = await planSelections({ quotaUi: ["sidebar"] }, projectDir);

    expect(plan.edits.map((edit) => edit.kind)).toEqual(["opencode", "quota", "tui"]);

    await applyInitInstallerPlan(plan);

    const opencode = readJson(join(projectDir, "opencode.jsonc"));
    const tui = readJson(join(projectDir, "tui.jsonc"));

    expect(opencode.plugin).toEqual(["@slkiser/opencode-quota@4"]);
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
      plugin: ["@slkiser/opencode-quota@4"],
    });
  });

  it("leaves compact TUI status alone when not selected for fresh sidebar installs", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });

    const plan = await planSelections({ quotaUi: ["sidebar"] }, projectDir);

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
      selections: installerSelections({ quotaUi: ["sidebar", "compact_status"] }),
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

    const plan = await planSelections({ quotaUi: ["compact_status"] }, projectDir);

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

    const plan = await planSelections({ quotaUi: ["compact_status"] }, projectDir);

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
      selections: installerSelections({
        quotaUi: ["none"],
        maintainerAnnouncements: false,
      }),
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
      selections: installerSelections({
        quotaUi: ["none"],
        maintainerAnnouncements: true,
      }),
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
      selections: installerSelections({
        quotaUi: ["none"],
        maintainerAnnouncements: true,
      }),
    });

    const quotaEdit = plan.edits.find((edit) => edit.kind === "quota");
    expect(quotaEdit?.updatedKeys).toContain("quotaToast.maintainerAnnouncements.enabled");
    expect(quotaEdit?.updatedKeys).toContain("quotaToast.maintainerAnnouncements.home");

    await applyInitInstallerPlan(plan);

    const quotaConfig = readJson(join(projectDir, "opencode-quota", "quota-toast.json"));
    expect(quotaConfig.maintainerAnnouncements).toEqual({ enabled: true, home: true });
  });

  it("rejects empty, unknown, and mixed current quota UI selections", async () => {
    await expectSelectionError({ quotaUi: [] }, "Quota UI selections must not be empty.");
    await expectSelectionError(
      { quotaUi: ["sidebar", "obsolete"] as any },
      "Unknown Quota UI option: obsolete",
    );
    await expectSelectionError(
      { quotaUi: ["none", "toast"] },
      "Manual commands only cannot be combined with automatic quota displays.",
    );
  });

  it("rejects the obsolete string quota UI selection", async () => {
    await expectSelectionError(
      { quotaUi: "toast_sidebar" as any },
      "Quota UI selections must be an array.",
    );
  });

  it("rejects the obsolete compact installer selection field", async () => {
    await expectSelectionError(
      {
        quotaUi: ["toast", "sidebar"],
        tuiCompactStatus: "home_bottom_session_prompt",
      } as any,
      "Unsupported installer selection: tuiCompactStatus",
    );
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
      selections: installerSelections({
        quotaUi: ["toast", "sidebar", "compact_status"],
      }),
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

    const plan = await planSelections({ quotaUi: ["none"] }, projectDir);

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
      selectValues: DEFAULT_PROMPT_SELECT_VALUES,
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
    expect(
      prompts.selectCalls.find((call) => call.message === "Session token scope"),
    ).toMatchObject({
      initialValue: "current",
      options: [
        expect.objectContaining({ value: "current" }),
        expect.objectContaining({ value: "tree" }),
      ],
    });
    expect(prompts.confirmCalls[0]).toEqual({
      message: "Show maintainer announcements on the TUI Home screen when available?",
      initialValue: true,
    });
    const quotaConfig = readJson(join(tempDir, "opencode-quota", "quota-toast.json"));
    expect(quotaConfig.sessionTokenScope).toBe("current");
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
        "sessionTokenScope": "tree",
        "tuiCommandDisplay": "inline",
        "tuiSidebarPanel": { "enabled": true },
        "maintainerAnnouncements": { "enabled": true }
      }`,
      "utf8",
    );
    const prompts = createPromptStub({
      selectValues: [
        "tui",
        "project",
        "jsonc",
        "dialog",
        "manual",
        "allWindows",
        "used",
        "yes",
        "tree",
      ],
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
    expect(
      prompts.selectCalls.find((call) => call.message === "Session token scope"),
    ).toMatchObject({ initialValue: "tree" });
    expect(prompts.outroCalls).toContain("OpenCode Quota setup cancelled — no files changed.");
  });

  it("prompt No for maintainer announcements writes opt-out and does not install TUI only for notices", async () => {
    const prompts = createPromptStub({
      selectValues: DEFAULT_PROMPT_SELECT_VALUES,
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
      selections: installerSelections({ quotaUi: ["toast", "sidebar"] }),
    });

    expect(plan.summaryLines).toContain("TUI surfaces: Sidebar + Toast");
    expect(plan.summaryLines).toContain("Quota reset periods: Single window");
    expect(plan.summaryLines).toContain("Quota percentage meaning: Remaining");
    expect(plan.edits.map((edit) => edit.kind)).toEqual(["opencode", "quota", "tui"]);

    await applyInitInstallerPlan(plan);

    const opencode = readJson(join(projectDir, "opencode.jsonc"));
    const tui = readJson(join(projectDir, "tui.jsonc"));

    expect(opencode.plugin).toEqual(["@slkiser/opencode-quota@4"]);
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
      plugin: ["@slkiser/opencode-quota@4"],
    });
  });

  it("does not touch tui config for none mode and disables popup toasts when missing", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });

    const plan = await planSelections({ quotaUi: ["none"] }, projectDir);

    expect(plan.edits.map((edit) => edit.kind)).toEqual(["opencode", "quota", "tui"]);

    await applyInitInstallerPlan(plan);

    expect(existsSync(join(projectDir, "tui.json"))).toBe(false);
    const opencode = readJson(join(projectDir, "opencode.jsonc"));
    expect(opencode.plugin).toEqual(["@slkiser/opencode-quota@4"]);
    expect(opencode.experimental).toBeUndefined();
    const quotaConfig = readJson(join(projectDir, "opencode-quota", "quota-toast.json"));
    expect(quotaConfig.enableToast).toBe(false);
    expect(quotaConfig.tuiSidebarPanel).toEqual({ enabled: false });
  });

  it("returns zero when the user cancels before applying changes", async () => {
    const prompts = createPromptStub({
      selectValues: DEFAULT_PROMPT_SELECT_VALUES,
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
      selectValues: DEFAULT_PROMPT_SELECT_VALUES,
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
      "OpenCode Quota setup preview complete — no files changed. Run npx @slkiser/opencode-quota@4 init to apply.",
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
      selectValues: DEFAULT_PROMPT_SELECT_VALUES,
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

  it("writes @4 for a new install and is idempotent", async () => {
    const projectDir = join(tempDir, "project-v4");
    mkdirSync(projectDir, { recursive: true });
    const selections = installerSelections();

    const firstPlan = await planInitInstaller({ cwd: projectDir, selections });
    await applyInitInstallerPlan(firstPlan);
    expect(readJson(join(projectDir, "opencode.jsonc")).plugin).toEqual([
      "@slkiser/opencode-quota@4",
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

    const selections = installerSelections();
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
          "@slkiser/opencode-quota@4",
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
      selections: installerSelections({
        interfaces: "web",
        quotaUi: ["sidebar", "toast"],
        showSessionTokens: false,
      }),
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
      "@slkiser/opencode-quota@4",
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
      selections: installerSelections({
        configFormat: "jsonc",
        providerMode: "manual",
        manualProviders: ["anthropic"],
        formatStyle: "allWindows",
        percentDisplayMode: "used",
        tuiCommandDisplay: "dialog",
        maintainerAnnouncements: false,
      }),
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
      selections: installerSelections({
        interfaces: "web",
        configFormat: "jsonc",
        quotaUi: ["none"],
        providerMode: "manual",
        manualProviders: ["anthropic"],
        showSessionTokens: false,
      }),
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
        selections: installerSelections({
          interfaces: "web",
          configFormat: "jsonc",
          quotaUi: ["none"],
          showSessionTokens: false,
        }),
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
      selections: installerSelections({
        interfaces: "both",
        configFormat: "jsonc",
        quotaUi: ["sidebar"],
        providerMode: "manual",
        manualProviders: ["anthropic"],
        formatStyle: "allWindows",
        percentDisplayMode: "used",
        maintainerAnnouncements: false,
      }),
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
    const plan = await planSelections({ quotaUi: ["sidebar"] }, projectDir);

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
        selections: installerSelections(),
      }),
    ).rejects.toThrow(/plugin is not an array/i);
  });
});
