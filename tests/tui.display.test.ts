import { describe, expect, it } from "vite-plus/test";
import { checkSetting, SETTINGS_SCHEMA, type SettingRule } from "../src/settings/schema.js";
import {
  type DisplaySettings,
  defaultDisplaySettings,
  FIELDS,
  type Field,
  type PresetName,
  presetChoice,
  presetValues,
  renameRow,
  resetTab,
  setIn,
  stepIn,
  THEME_COLORS,
  typedColor,
  valueAt,
} from "../src/tui/display.js";

describe("the Settings tabs' field table", () => {
  const field = (path: string) => FIELDS.find((item) => item.path === path) as Field;
  /** ‹ or › on a line, as the Settings tab does it. */
  const cycled = (settings: DisplaySettings, item: Field, delta: number) => {
    const values = item.choices?.(settings) ?? item.values;
    return setIn(
      settings,
      item.path.split("."),
      stepIn(values, valueAt(settings, item.path), delta),
    );
  };
  const choiceOf = (settings: DisplaySettings, name: PresetName) =>
    presetChoice(name, (path) => valueAt(settings, path));
  /** ‹ or › on a preset line. */
  const withPreset = (settings: DisplaySettings, name: PresetName, delta: number) =>
    Object.entries(presetValues(name, choiceOf(settings, name), delta)).reduce(
      (next, [path, value]) => setIn(next, path.split("."), value),
      settings,
    );

  it.each(FIELDS.map((item) => [item.path, item] as const))(
    "%s edits a window setting, starts at its default and steps through values it accepts",
    (path, item) => {
      const rule: SettingRule = SETTINGS_SCHEMA[path];
      expect(rule.fileOnly).toBeUndefined();
      if (item.values.length > 0) expect(item.values).toContain(rule.default);
      for (const value of item.values) expect(checkSetting(path, value).issues).toEqual([]);
    },
  );

  it.each([
    // From "fill", the first value, to the first and the last number.
    { path: "layout.barWidth", delta: 1, expected: 4 },
    { path: "layout.barWidth", delta: -1, expected: 12 },
    { path: "layout.separator", delta: -1, expected: "  " },
    { path: "statusLine.detail", delta: 1, expected: "one" },
    { path: "statusLine.runsOut", delta: 1, expected: true },
    { path: "sidebar.runsOut", delta: 1, expected: false },
    { path: "colors.reset", delta: 1, expected: "text" },
    { path: "colors.reset", delta: -1, expected: "bar" },
    { path: "colors.good", delta: -1, expected: "blue" },
    // Warning stays at or above low, so each goes round through the levels that keep it so.
    { path: "colors.warningBelow", delta: -1, expected: 60, from: 20 },
    { path: "colors.lowBelow", delta: 1, expected: 10, from: 20 },
  ])("‹ › on $path by $delta gives $expected", ({ path, delta, expected, from }) => {
    const start =
      from === undefined
        ? defaultDisplaySettings()
        : setIn(defaultDisplaySettings(), ["colors"], {
            ...defaultDisplaySettings().colors,
            warningBelow: from,
            lowBelow: from,
          });
    const next = cycled(start, field(path), delta);
    expect(valueAt(next, path)).toBe(expected);
    // The rest stays as it was.
    expect(setIn(next, path.split("."), valueAt(start, path))).toEqual(start);
  });

  it("turns every color grey but Almost out and errors with the Color preset, then back", () => {
    const start = defaultDisplaySettings();
    expect(choiceOf(start, "colors")).toBe("theme colors");
    const grey = withPreset(start, "colors", 1);
    expect(choiceOf(grey, "colors")).toBe("grey");
    const shown = (settings: DisplaySettings) =>
      Object.fromEntries(
        Object.entries(THEME_COLORS).map(([role, theme]) => [
          role,
          (settings.colors as Record<string, unknown>)[role] ?? theme,
        ]),
      );
    expect(shown(grey)).toEqual({
      good: "muted",
      warning: "muted",
      low: "red",
      empty: "muted",
      title: "text",
      provider: "muted",
      account: "muted",
      label: "muted",
      // The percent follows the bar: grey, red when almost out.
      percent: "bar",
      reset: "muted",
      value: "muted",
      error: "red",
      statusName: "muted",
      separator: "muted",
      arrows: "muted",
    });
    const back = withPreset(grey, "colors", 1);
    expect(choiceOf(back, "colors")).toBe("theme colors");
    expect(shown(back)).toEqual(shown(start));
  });

  it.each([
    { text: "#89B4FA", expected: "#89b4fa" },
    { text: " 89b4fa ", expected: "#89b4fa" },
    { text: "", expected: undefined },
    { text: "pink", expected: "#112233" },
  ])("a typed color $text gives $expected", ({ text, expected }) => {
    const before = setIn(defaultDisplaySettings(), ["colors", "reset"], "#112233");
    expect(typedColor(before, field("colors.reset"), text).colors.reset).toBe(expected);
  });

  it("names the preset the lines match, else your own, and a preset sets its lines", () => {
    const defaults = defaultDisplaySettings();
    expect([choiceOf(defaults, "layout"), choiceOf(defaults, "toast")]).toEqual([
      "comfortable",
      "normal",
    ]);
    const own = cycled(defaults, field("layout.indent"), 1);
    expect(choiceOf(own, "layout")).toBeUndefined();
    expect(choiceOf(withPreset(own, "layout", 1), "layout")).toBe("compact");
    const roomy = withPreset(defaults, "layout", 1);
    expect([choiceOf(roomy, "layout"), roomy.layout]).toEqual([
      "roomy",
      { ...defaults.layout, indent: 2, providerGap: 2 },
    ]);
    const quiet = withPreset(defaults, "toast", -1);
    expect([choiceOf(quiet, "toast"), quiet.toast.afterReply]).toEqual(["quiet", "off"]);
    expect(withPreset(quiet, "toast", -1).toast.afterCompaction).toBe(false);
  });

  it("renames a row whose id holds a dot, keeps its own name typed, and nothing puts it back", () => {
    const renamed = renameRow(defaultDisplaySettings(), "sidebar", "anthropic.weekly", " Session ");
    expect(renamed.labels).toEqual({ "anthropic.weekly": "Session" });
    // Typed, its own name stays, so it shows where short row names would show "7d".
    expect(renameRow(renamed, "sidebar", "anthropic.weekly", "Weekly").labels).toEqual({
      "anthropic.weekly": "Weekly",
    });
    expect(renameRow(renamed, "sidebar", "anthropic.weekly", "").labels).toEqual({});
  });

  it("resets only the tab's lines, its surface and its windows; row names stay", () => {
    let changed = defaultDisplaySettings();
    changed = setIn(changed, ["collapsed", "runsOut"], true);
    changed = setIn(changed, ["collapsed", "providerOrder"], ["openai", "anthropic"]);
    changed = setIn(changed, ["collapsed", "window", "anthropic"], "week");
    changed = setIn(changed, ["sidebar", "runsOut"], false);
    changed = setIn(changed, ["sidebar", "names", "anthropic.five_hour"], "Session");
    const reset = resetTab(changed, "collapsed");
    expect(reset).toEqual(
      setIn(
        setIn(defaultDisplaySettings(), ["sidebar", "runsOut"], false),
        ["sidebar", "names", "anthropic.five_hour"],
        "Session",
      ),
    );
    expect(resetTab(changed, "layout")).toEqual(changed);
  });
});
