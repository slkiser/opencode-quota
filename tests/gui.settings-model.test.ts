import { describe, expect, it, vi } from "vite-plus/test";
import type { QuotaSnapshot } from "../src/core/types.js";
import type { GuiQuota } from "../src/gui/bridge.js";
import { en } from "../src/gui/i18n.js";
import {
  changedSettings,
  type Control,
  controlFor,
  editorKeys,
  fileOnlyKeys,
  PROVIDER_KEYS,
  presetNames,
  rangeWords,
  resetKeys,
  SECTIONS,
  type Section,
  sectionRows,
  SUBHEADINGS,
  TUI_ONLY,
  typedNumber,
} from "../src/gui/settings-model.js";
import { createSettingsPageState } from "../src/gui/settings-page.js";
import { settingsFromValues, surfaceSettings } from "../src/gui/surface-settings.js";
import type { QuotaRpcSaveSettingsInput, QuotaRpcSettingsOutput } from "../src/rpc.js";
import {
  checkSetting,
  clientSettings,
  defaultSettings,
  isRecordSetting,
  SETTINGS_SCHEMA,
  type SettingRule,
} from "../src/settings/schema.js";
import {
  createSettingsDraft,
  type SettingsDraft,
  settingsShape,
} from "../src/tui/settings-draft.js";
import { surfaceEditor } from "../src/tui/window/surface-editor.js";
import { COLOR_ROLES, PRESET_CHOICES, type PresetName, presetChoice } from "../src/view/presets.js";
import { providerSnapshot, quotaRow as row } from "./helpers/fake-answers.js";

/** The rules as the RPC carries them: JSON, so an undefined default is gone. */
const RULES = JSON.parse(JSON.stringify(SETTINGS_SCHEMA)) as Record<string, SettingRule>;
const SURFACES = ["sidebar", "collapsed", "statusLine", "toast"] as const;
const words = (key: string) => Object.hasOwn(en, key);
const section = (id: Section["id"]) => SECTIONS.find((item) => item.id === id) as Section;

describe("the Settings page's sections", () => {
  it("lists every setting a client may change once: as a row, a provider switch or a tree", () => {
    const listed = [
      ...SECTIONS.flatMap((item) => item.keys),
      ...SURFACES.flatMap((surface) => editorKeys(surface, RULES)),
    ];
    const editable = Object.entries(SETTINGS_SCHEMA)
      .filter(([key, rule]) => key !== "version" && !("fileOnly" in rule && rule.fileOnly))
      .map(([key]) => key);

    expect([...listed].sort()).toEqual([...editable].sort());
    expect(new Set(listed).size).toBe(listed.length);
  });

  it("names only settings of the schema", () => {
    const keys = [
      ...SECTIONS.flatMap((item) => item.keys),
      ...TUI_ONLY,
      ...Object.keys(SUBHEADINGS),
      ...Object.values(PROVIDER_KEYS).flat(),
    ];
    for (const key of keys) expect([key, Object.hasOwn(SETTINGS_SCHEMA, key)]).toEqual([key, true]);
  });

  it("has words for every section, row, option, preset and file-only setting", () => {
    const missing: string[] = [];
    const need = (key: string) => {
      if (!words(key)) missing.push(key);
    };
    for (const item of SECTIONS) {
      need(`section.${item.id}`);
      need(`section.${item.id}.description`);
      for (const { key, rule } of sectionRows(item, RULES)) {
        need(`setting.${key}`);
        const control = controlFor(key, rule);
        if (control.kind === "select" || control.kind === "color") {
          for (const option of control.options) need(option.words.key);
        }
      }
      if (item.preset) {
        need(`preset.${item.preset}`);
        for (const choice of presetNames(item.preset)) need(`preset.${item.preset}.${choice}`);
      }
    }
    for (const key of fileOnlyKeys(RULES)) need(`setting.${key}`);
    for (const key of Object.values(SUBHEADINGS)) need(key);

    expect(missing).toEqual([]);
  });

  it("puts the Providers section's own settings under Cursor and OpenCode Zen, not as rows", () => {
    expect(sectionRows(section("providers"), RULES).map((item) => item.key)).toEqual(
      Object.values(PROVIDER_KEYS).flat(),
    );
  });

  it("skips a key an older server's rules lack", () => {
    const { "toast.seconds": _gone, ...older } = RULES;

    expect(sectionRows(section("toast"), older).map((item) => item.key)).not.toContain(
      "toast.seconds",
    );
  });

  it("lists the file-only settings and the version from the rules", () => {
    expect(fileOnlyKeys(RULES)).toEqual([
      "version",
      "providers.custom",
      "providers.anthropic.binaryPath",
      "system.exportPath",
    ]);
  });

  it("resets a surface's rows and tree but keeps its row names", () => {
    expect(resetKeys(section("sidebar"), RULES)).toEqual([
      "sidebar.sessionTokens",
      "sidebar.runsOut",
      "sidebar.hidden",
      "sidebar.providerOrder",
      "sidebar.rowOrder",
    ]);
    expect(resetKeys(section("collapsed"), RULES)).toContain("collapsed.window");
  });
});

describe("the control each rule makes", () => {
  it("makes a switch of a boolean and a select of a choice with the rule's values", () => {
    expect(controlFor("toast.show", RULES["toast.show"] as SettingRule)).toEqual({
      kind: "switch",
    });
    const select = controlFor("words.percent", RULES["words.percent"] as SettingRule);
    expect(select.kind === "select" && select.options.map((option) => option.value)).toEqual(
      SETTINGS_SCHEMA["words.percent"].values,
    );
  });

  it("takes a number's bounds, wholeness, null and word from the rule", () => {
    expect(controlFor("toast.seconds", RULES["toast.seconds"] as SettingRule)).toEqual({
      kind: "number",
      integer: true,
      min: 1,
      max: 120,
      nullable: false,
    });
    expect(controlFor("layout.barWidth", RULES["layout.barWidth"] as SettingRule)).toMatchObject({
      word: "fill",
      min: 1,
      max: 30,
    });
    expect(
      controlFor(
        "providers.cursor.includedApiUsd",
        RULES["providers.cursor.includedApiUsd"] as SettingRule,
      ),
    ).toEqual({ kind: "number", integer: false, above: 0, nullable: true });
  });

  it("offers a few check intervals, and the file's own value too", () => {
    const key = "providers.checking.minIntervalMs";
    const options = (current?: number) => {
      const control = controlFor(key, RULES[key] as SettingRule, current);
      return control.kind === "select" ? control.options.map((option) => option.value) : [];
    };

    expect(options()).toEqual([60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000]);
    expect(options(90_000)).toContain(90_000);
    for (const value of options()) expect(checkSetting(key, value).issues).toEqual([]);
    const timeout = controlFor(
      "providers.checking.requestTimeoutMs",
      RULES["providers.checking.requestTimeoutMs"] as SettingRule,
    );
    expect(timeout.kind === "select" && timeout.options[0]).toEqual({
      value: null,
      words: { key: "option.providers.checking.requestTimeoutMs.unset" },
    });
  });

  it("offers theme colors, and the bar color except for the bar levels themselves", () => {
    const values = (key: string) => {
      const control = controlFor(key, RULES[key] as SettingRule);
      return control.kind === "color" ? control.options.map((option) => option.value) : [];
    };

    expect(values("colors.title")).toEqual([undefined, ...SETTINGS_COLOR_NAMES]);
    expect(values("colors.good")).not.toContain("bar");
    for (const value of values("colors.title")) {
      expect(checkSetting("colors.title", value).issues).toEqual([]);
    }
  });

  it("limits the separator to the rule's length, and leaves lists to the trees", () => {
    expect(controlFor("layout.separator", RULES["layout.separator"] as SettingRule)).toEqual({
      kind: "text",
      maxLength: 5,
    });
    expect(controlFor("sidebar.hidden", RULES["sidebar.hidden"] as SettingRule).kind).toBe("none");
    expect(controlFor("providers.off", RULES["providers.off"] as SettingRule).kind).toBe("none");
  });

  it("makes the same controls from the schema as from its JSON", () => {
    for (const [key, rule] of Object.entries(SETTINGS_SCHEMA)) {
      expect(controlFor(key, RULES[key] as SettingRule)).toEqual(controlFor(key, rule));
    }
  });

  it("takes only a typed number the rule takes", () => {
    const number = (key: string) =>
      controlFor(key, RULES[key] as SettingRule) as Extract<Control, { kind: "number" }>;
    const seconds = number("toast.seconds");
    const budget = number("providers.cursor.includedApiUsd");

    expect(typedNumber(seconds, "15")).toBe(15);
    expect(typedNumber(seconds, "0")).toBeUndefined();
    expect(typedNumber(seconds, "121")).toBeUndefined();
    expect(typedNumber(seconds, "2.5")).toBeUndefined();
    expect(typedNumber(seconds, "")).toBeUndefined();
    expect(typedNumber(budget, "$25.5")).toBe(25.5);
    expect(typedNumber(budget, "0")).toBeUndefined();
    expect(typedNumber(budget, " ")).toBeNull();
    for (const [key, text] of [
      ["toast.seconds", "15"],
      ["providers.cursor.includedApiUsd", "25.5"],
    ] as const) {
      expect(checkSetting(key, typedNumber(number(key), text)).issues).toEqual([]);
    }
  });

  it("says a number's range from the rule", () => {
    const range = (key: string) =>
      rangeWords(
        controlFor(key, RULES[key] as SettingRule) as Extract<Control, { kind: "number" }>,
      );

    expect(range("toast.seconds")).toEqual({
      key: "settings.range.between",
      params: { min: 1, max: 120 },
    });
    expect(range("providers.opencode.monthlyLimitUsd")).toEqual({
      key: "settings.range.above",
      params: { min: 0 },
    });
    expect(range("providers.pricing.autoRefreshDays")).toEqual({
      key: "settings.range.atLeast",
      params: { min: 1 },
    });
  });
});

const SETTINGS_COLOR_NAMES = ["text", "muted", "accent", "green", "yellow", "red", "blue", "bar"];

describe("the presets", () => {
  it("set only settings of the schema, to values it takes", () => {
    for (const choices of Object.values(PRESET_CHOICES)) {
      for (const values of Object.values(choices)) {
        for (const [key, value] of Object.entries(values)) {
          expect([key, checkSetting(key, value).issues]).toEqual([key, []]);
        }
      }
    }
  });

  it("list every color role of the schema", () => {
    const colors = Object.entries(SETTINGS_SCHEMA)
      .filter(([, rule]) => rule.kind === "color")
      .map(([key]) => key.slice("colors.".length));

    expect([...COLOR_ROLES].sort()).toEqual(colors.sort());
  });

  it("knows the choice the settings match, and none for your own", () => {
    const values = (name: PresetName, choice: string) => PRESET_CHOICES[name][choice] ?? {};
    const quiet = values("toast", "quiet");

    expect(presetChoice("toast", (key) => quiet[key])).toBe("quiet");
    expect(presetChoice("toast", (key) => ({ ...quiet, "toast.afterQuestion": true })[key])).toBe(
      undefined,
    );
    expect(presetChoice("colors", () => undefined)).toBe("theme colors");
  });
});

const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const SNAPSHOT: QuotaSnapshot = {
  version: 6,
  providers: [
    providerSnapshot("anthropic", "Anthropic", [
      row("anthropic.five_hour", { label: "5h", window: "five_hour", percentRemaining: 30 }),
      row("anthropic.week", { label: "Weekly", window: "week", percentRemaining: 60 }),
    ]),
    providerSnapshot("openai", "OpenAI", [
      row("openai.week", { label: "Weekly", window: "week", percentRemaining: 80 }),
    ]),
  ],
  resetNotices: [],
  generatedAtMs: NOW,
};
const SURFACE_KEYS = Object.keys(RULES).filter((key) =>
  ["sidebar", "collapsed", "statusLine", "toast", "colors", "layout", "words"].includes(
    key.split(".")[0] as string,
  ),
);

describe("a tree edit as draft changes", () => {
  const before = settingsFromValues({});

  it("hides a row in its surface's hidden list", () => {
    const edit = surfaceEditor("sidebar", SNAPSHOT).toggleHidden("anthropic.week");

    expect(changedSettings(before, edit(before), SURFACE_KEYS)).toEqual([
      ["sidebar.hidden", ["anthropic.week"]],
    ]);
  });

  it("moves a provider in its surface's order, and renames a row", () => {
    const editor = surfaceEditor("toast", SNAPSHOT);

    expect(changedSettings(before, editor.move("openai", -1)(before), SURFACE_KEYS)).toEqual([
      ["toast.providerOrder", ["openai", "anthropic"]],
    ]);
    const renamed = editor.rename("anthropic.week")?.apply("Week")(before);
    expect(renamed && changedSettings(before, renamed, SURFACE_KEYS)).toEqual([
      ["toast.names", { "anthropic.week": "Week" }],
    ]);
  });

  it("picks a provider's window among its own, and a pick of the inherited one is no pick", () => {
    const editor = surfaceEditor("collapsed", SNAPSHOT);

    expect(editor.windowChoices("anthropic", before)).toEqual(["lowest", "five_hour", "week"]);
    expect(editor.windowChoices("openai", before)).toEqual([]);
    const week = editor.pickWindow("anthropic", "week")(before);
    expect(changedSettings(before, week, SURFACE_KEYS)).toEqual([
      ["collapsed.window", { anthropic: "week" }],
    ]);
    expect(
      changedSettings(week, editor.pickWindow("anthropic", "lowest")(week), SURFACE_KEYS),
    ).toEqual([["collapsed.window", {}]]);
  });
});

describe("the surfaces' preview of unsaved changes", () => {
  it("puts the page's changes over the saved settings, a color back to the theme's too", () => {
    const saved = { "words.percent": "used", "colors.title": "red", "toast.seconds": 20 };
    const snapshot = { ...SNAPSHOT, settings: { values: saved } } as unknown as QuotaSnapshot;

    const shown = surfaceSettings(snapshot, { "words.percent": "bare", "colors.title": undefined });

    expect(shown.words.percent).toBe("bare");
    expect(shown.colors.title).toBeUndefined();
    expect(shown.toast.seconds).toBe(20);
    expect(surfaceSettings(snapshot).words.percent).toBe("used");
  });
});

describe("the draft the Settings page shares with the TUI", () => {
  it("is shaped the same from the schema as from the RPC's JSON of it", () => {
    const fromSchema = settingsShape(SETTINGS_SCHEMA);
    const fromJson = settingsShape(RULES);

    expect(fromSchema.defaults).toEqual(
      clientSettings({ settings: defaultSettings(), fromFile: [], issues: [] }).values,
    );
    expect(fromJson).toEqual(fromSchema);
    expect([...fromSchema.recordKeys]).toEqual(
      Object.keys(SETTINGS_SCHEMA).filter((key) => isRecordSetting(key)),
    );
  });

  function serverAnswers(values: Record<string, unknown>, fromFile: string[]) {
    const settings: QuotaRpcSettingsOutput = { values, fromFile, providers: [], custom: [] };
    const saves: QuotaRpcSaveSettingsInput[] = [];
    const rpc = {
      settings: vi.fn(async () => structuredClone(settings)),
      saveSettings: vi.fn(async (input: QuotaRpcSaveSettingsInput) => {
        saves.push(structuredClone(input));
        return { ok: true, issues: [] };
      }),
    };
    return { settings, saves, rpc };
  }

  it("counts its changes, and saves only the changed keys", async () => {
    const defaults = settingsShape(RULES).defaults;
    const server = serverAnswers({ ...defaults, "toast.seconds": 20 }, ["toast.seconds"]);
    const draft = createSettingsDraft(server.rpc, settingsShape(RULES));
    await draft.load();

    draft.set("words.percent", "bare");
    draft.set("toast.seconds", 20);
    draft.set("sidebar.names", { "anthropic.week": "Week" });
    expect(draft.count()).toBe(2);
    expect(draft.changedKeys()).toEqual(["words.percent", "sidebar.names"]);
    draft.set("words.percent", "left");
    expect(draft.changedKeys()).toEqual(["sidebar.names"]);
    draft.set("words.percent", "bare");
    await draft.save();

    expect(server.saves).toEqual([
      { patch: { words: { percent: "bare" }, sidebar: { names: { "anthropic.week": "Week" } } } },
    ]);
  });

  it("removes a reset key from the file, and discards back to the saved settings", async () => {
    const defaults = settingsShape(RULES).defaults;
    const server = serverAnswers({ ...defaults, "toast.seconds": 20 }, ["toast.seconds"]);
    const draft = createSettingsDraft(server.rpc, settingsShape(RULES));
    await draft.load();

    draft.reset("toast.seconds");
    draft.set("layout.evenUse", false);
    expect(draft.value("toast.seconds")).toBe(9);
    draft.discard();
    expect(draft.count()).toBe(0);
    expect(draft.value("toast.seconds")).toBe(20);
    draft.reset("toast.seconds");
    await draft.save();

    expect(server.saves).toEqual([{ patch: { toast: { seconds: null } } }]);
  });

  it("keeps its changes over settings the file changed on disk meanwhile", async () => {
    const defaults = settingsShape(RULES).defaults;
    const server = serverAnswers({ ...defaults }, []);
    const draft = createSettingsDraft(server.rpc, settingsShape(RULES));
    await draft.load();
    draft.set("words.percent", "bare");

    draft.receive({
      values: { ...defaults, "words.percent": "used", "toast.seconds": 30 },
      fromFile: ["words.percent", "toast.seconds"],
      providers: [],
      custom: [],
    });

    expect(draft.value("words.percent")).toBe("bare");
    expect(draft.value("toast.seconds")).toBe(30);
    expect(draft.count()).toBe(1);
  });

  it("keeps its saved settings when a snapshot brings the same ones", async () => {
    const defaults = settingsShape(RULES).defaults;
    const server = serverAnswers({ ...defaults, "toast.seconds": 20 }, ["toast.seconds"]);
    const draft = createSettingsDraft(server.rpc, settingsShape(RULES));
    await draft.load();
    const before = draft.saved();

    draft.receive(structuredClone(server.settings));
    expect(draft.saved()).toBe(before);
    draft.receive({ ...structuredClone(server.settings), fromFile: [] });
    expect(draft.saved()).not.toBe(before);
  });

  it("takes a new shape's defaults and keeps its changes", async () => {
    const defaults = settingsShape(RULES).defaults;
    const server = serverAnswers({ ...defaults, "toast.seconds": 20 }, ["toast.seconds"]);
    const draft = createSettingsDraft(server.rpc, settingsShape(RULES));
    await draft.load();
    draft.set("words.percent", "bare");

    draft.reshape(settingsShape(withDefault("toast.seconds", 12)));
    draft.reset("toast.seconds");

    expect(draft.value("toast.seconds")).toBe(12);
    expect(draft.value("words.percent")).toBe("bare");
    expect(draft.count()).toBe(2);
  });
});

/** The rules with one key's default changed, as a newer server's schema may have it. */
function withDefault(key: string, value: unknown): Record<string, SettingRule> {
  const rules = structuredClone(RULES);
  rules[key] = { ...rules[key], default: value } as SettingRule;
  return rules;
}

describe("the Settings page's state", () => {
  /** A server whose saved settings set `toast.seconds` to `seconds`, with these rules. */
  function server(seconds: number) {
    const answer = (secondsNow: number): QuotaRpcSettingsOutput => ({
      values: { ...settingsShape(RULES).defaults, "toast.seconds": secondsNow },
      fromFile: ["toast.seconds"],
      providers: [],
      custom: [],
    });
    const data = {
      rules: RULES,
      seconds,
      settingsSchema: vi.fn(async () => ({ rules: data.rules, path: "/settings.jsonc" })),
      settings: vi.fn(async () => answer(data.seconds)),
      saveSettings: vi.fn(async () => ({ ok: true, issues: [] })),
    };
    return { data, answer };
  }

  it("keeps the settings it read over the older snapshot it saw before", async () => {
    const { data, answer } = server(30);
    const state = createSettingsPageState(data as unknown as GuiQuota);
    const cached = answer(9);

    // The page offers the snapshot on screen at once, and again when the draft shows.
    state.receive(cached);
    await state.load();
    state.receive(cached);
    expect(state.draft()?.value("toast.seconds")).toBe(30);

    // A newer snapshot still shows under the draft.
    state.receive(answer(40));
    expect(state.draft()?.value("toast.seconds")).toBe(40);
  });

  it("follows a reloaded schema's defaults, keeping the unsaved changes", async () => {
    const { data } = server(20);
    const state = createSettingsPageState(data as unknown as GuiQuota);
    await state.load();
    const draft = state.draft() as SettingsDraft;
    draft.set("words.percent", "bare");

    data.rules = withDefault("toast.seconds", 12);
    await state.load();
    draft.reset("toast.seconds");

    expect(state.draft()).toBe(draft);
    expect(draft.value("toast.seconds")).toBe(12);
    expect(draft.value("words.percent")).toBe("bare");
  });
});
