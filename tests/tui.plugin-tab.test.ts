import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createLocalization } from "../src/i18n.js";
import type { QuotaRpcSaveSettingsInput, QuotaRpcSettingsOutput } from "../src/rpc.js";
import { createFileDisplay } from "../src/tui/display.js";
import { createServerSettings } from "../src/tui/server-settings.js";
import { createPluginTab } from "../src/tui/window/plugin-tab.js";
import { createSettingsEditor, type SettingsEditor } from "../src/tui/window/settings.tsx";
import type { WindowHost } from "../src/tui/window/shell.js";
import { stubJsx } from "./helpers/fake-tui-host.js";
import { THEME, words } from "./helpers/jsx-tree.js";

describe("TUI Plugin tab language selection", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("saves the selected language and redraws this tab immediately in Simplified Chinese", async () => {
    stubJsx();
    let saved: QuotaRpcSettingsOutput = {
      values: { "system.language": "en" },
      fromFile: ["system.language"],
      providers: [],
      custom: [],
    };
    const rpc = {
      settings: vi.fn(async () => structuredClone(saved)),
      saveSettings: vi.fn(async (input: QuotaRpcSaveSettingsInput) => {
        const patch = input.patch as { system?: { language?: string } };
        if (patch.system?.language) {
          saved = {
            ...saved,
            values: { ...saved.values, "system.language": patch.system.language },
          };
        }
        return { ok: true, issues: [] };
      }),
      noticeList: vi.fn(async () => ({ notices: [] })),
      status: vi.fn(async () => ({ text: "Ready" })),
    };
    const localization = createLocalization(
      () => String(saved.values["system.language"]),
      () => "en-US",
    );
    const host = {
      ...localization,
      theme: THEME,
      themeMode: "dark",
      location: { directory: "/project" },
      data: { location: { default: () => ({ directory: "/project" }) } },
      client: { rpc: () => rpc },
      keymap: { dispatch: vi.fn() },
      renderer: { width: 100 },
      ui: { toast: { show: vi.fn() } },
    } as unknown as WindowHost;
    const server = createServerSettings({
      settings: rpc.settings,
      saveSettings: rpc.saveSettings,
    });
    await server.load();
    const settings = createSettingsEditor(host, createFileDisplay(server), {
      preview: vi.fn(),
      closePreview: vi.fn(),
    });
    const tab = createPluginTab(host, settings, vi.fn());
    tab.show(undefined);
    await vi.waitFor(() => expect(settings.savedValue("system.language")).toBe("en"));

    const before = words(tab.View({ width: 100 }));
    expect(before).toContain("Interface language");
    expect(before).toContain(
      "Shared by Desktop and TUI; Auto follows each host's interface locale.",
    );

    // The Plugin tab starts with Copy selected; ↑ selects Language, then → selects zh-Hans.
    expect(tab.select(-1)).toBe(true);
    tab.step(1);
    await vi.waitFor(() => expect(settings.savedValue("system.language")).toBe("zh-Hans"));

    expect(host.locale()).toBe("zh-Hans");
    const after = words(tab.View({ width: 100 }));
    expect(after).toContain("通知");
    expect(after).toContain("界面语言");
    expect(after).toContain("设置检查（/quota_status）");
    expect(after).toContain("Desktop 和 TUI 共用；自动模式跟随各自宿主的界面语言。");
    expect(after).not.toContain("Interface language");
    expect(rpc.saveSettings).toHaveBeenCalledWith({ patch: { system: { language: "zh-Hans" } } });
  });

  it("localizes the failed-save toast title but preserves the provider error text", async () => {
    const toast = vi.fn();
    const localization = createLocalization(
      () => "zh-Hans",
      () => "en-US",
    );
    const host = {
      ...localization,
      theme: THEME,
      client: {
        rpc: () => ({
          noticeList: async () => ({ notices: [] }),
          status: async () => ({ text: "" }),
        }),
      },
      ui: { toast: { show: toast } },
    } as unknown as WindowHost;
    const settings = {
      savedSwitch: (key: string) => (key === "system.telemetry" ? false : undefined),
      savedValue: () => undefined,
      saveSwitch: vi.fn(async () => {
        throw new Error("Upstream provider returned HTTP 401");
      }),
      loadSaved: vi.fn(async () => {}),
      click: vi.fn((run: () => void) => run),
    } as unknown as SettingsEditor;
    const tab = createPluginTab(host, settings, vi.fn());
    tab.show(undefined);
    expect(tab.select(-1)).toBe(true);
    tab.step(1);

    await vi.waitFor(() => expect(toast).toHaveBeenCalledOnce());
    expect(toast).toHaveBeenCalledWith({
      variant: "error",
      title: "OpenCode 配额",
      message: "Upstream provider returned HTTP 401",
    });
  });
});
