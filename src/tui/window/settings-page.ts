/**
 * One Settings page apart from how it is drawn: its option lines (settings, presets, OpenCode's
 * theme, custom provider switches, provider ticks, the window for all providers), the surface's
 * provider tree, the order ↑↓ select them in, and what ←/→ (`step`), space or enter (`activate`)
 * and Reset do. Every edit goes to the window's draft (`DisplayStore`); Save writes it.
 */
import type { QuotaSnapshot, QuotaWindow } from "../../core/types.js";
import { ALL_PROVIDERS, WINDOWS } from "../../core/windows.js";
import type { CustomProviderSwitch } from "../../settings/index.js";
import { CHANGED_SINCE_REVIEW } from "../../settings/schema.js";
import { formatDuration, formatUsd } from "../../view/format.js";
import type { Surface, WindowChoice } from "../../view/select.js";
import type { ColorRole } from "../../view/text.js";
import {
  COLOR_NAMES,
  type DisplayStore,
  FIELDS,
  type Field,
  type FieldValue,
  isSurfaceTab,
  PRESETS,
  type PresetName,
  presetChoice,
  presetValues,
  resetKeys,
  type SettingsTab,
  setIn,
  stepIn,
  typedColor,
  typedNumber,
} from "../display.js";
import {
  foundProviderIds,
  isTicked,
  PROVIDERS_KEY,
  type ServerSettings,
  withTick,
} from "../server-settings.js";
import { namedColor, roleColor } from "../theme.js";
import { activateLine, type OptionLine, stepLine, type Typed } from "./option-line.js";
import type { WindowHost } from "./shell.js";
import { surfaceEditor, type TreeLine } from "./surface-editor.js";

/** The id of a surface page's switch line. */
export const SWITCH_ID = "surface";

/** Selection id of a tree line; a row id could equal a setting's path. */
export function lineKey(id: string): string {
  return `line:${id}`;
}

/**
 * Reset tab or Reset page: every line of `tab` back to its default in the draft, so Save
 * removes them from settings.jsonc. On Providers the switched-off providers too, and each
 * custom provider switch goes back to its saved state.
 */
export function resetPage(server: ServerSettings, tab: SettingsTab): void {
  for (const key of resetKeys(tab)) server.reset(key);
  if (tab !== "providers") return;
  server.reset(PROVIDERS_KEY);
  server.discardSwitches();
}

/** What a page needs from OpenCode's TUI: its theme, its light/dark mode and its commands. */
export type PageHost = Pick<WindowHost, "theme" | "themeMode" | "keymap"> & {
  locale?: WindowHost["locale"];
  t?: WindowHost["t"];
};

export type SettingsPage = ReturnType<typeof settingsPage>;

/** A window choice as its ‹ › shows it: "lowest left", "5h", … */
export function windowTitle(choice: WindowChoice, t?: WindowHost["t"]): string {
  if (choice !== "lowest") return WINDOWS[choice].short;
  return t?.("settings.window.lowest") ?? "lowest left";
}

/**
 * `tab`'s page over the draft and the quota snapshot. `refocus` gives the window the keyboard
 * again after OpenCode's light/dark switch took it.
 */
export function settingsPage(input: {
  tab: SettingsTab;
  draft: DisplayStore;
  snapshot: QuotaSnapshot | undefined;
  host: PageHost;
  refocus: () => void;
}) {
  const { tab, draft, snapshot, host, refocus } = input;
  const server = draft.server;
  const translated = (key: string, fallback: string): string => {
    const value = host.t?.(key);
    return value && value !== key ? value : fallback;
  };
  const localizedOptionValue = (field: Field, value: FieldValue, fallback: string): string => {
    const t = host.t;
    if (!t || host.locale?.() === "en") return fallback;
    const count = Number(value);
    switch (field.path) {
      case "statusLine.width":
        return count === 0 ? t("tui.value.allFreeRoom") : t("tui.value.upToColumns", { count });
      case "statusLine.autoScrollSeconds":
        return count === 0 ? t("tui.action.off") : t("tui.value.everySeconds", { count });
      case "toast.seconds":
        return t("tui.value.seconds", { count });
      case "layout.barWidth":
        return value === "fill" ? t("tui.value.fillRoom") : t("tui.value.columns", { count });
      case "layout.indent":
        return t(`tui.value.spaces.${count === 1 ? "one" : "other"}`, { count });
      case "layout.labelWidth":
        return t(`tui.value.letters.${count === 1 ? "one" : "other"}`, { count });
      case "layout.providerGap":
        return count === 0
          ? t("tui.value.noGap")
          : t(`tui.value.emptyLines.${count === 1 ? "one" : "other"}`, { count });
      case "words.resetDecimals":
        return t("tui.value.decimals", {
          count,
          duration: formatDuration(134 * 60_000, "decimal", count, host.locale?.() ?? "zh-Hans"),
        });
      case "providers.cursor.includedApiUsd":
        return typeof value === "number"
          ? t("tui.value.monthlyUsd", { amount: formatUsd(value, host.locale?.() ?? "zh-Hans") })
          : t("tui.value.fromPlan");
      case "providers.cursor.billingCycleStartDay":
        return typeof value === "number"
          ? t("tui.value.dayNumber", { count })
          : t("tui.value.calendarMonth");
      case "providers.opencode.monthlyLimitUsd":
        return typeof value === "number"
          ? t("tui.value.monthlyUsd", { amount: formatUsd(value, host.locale?.() ?? "zh-Hans") })
          : t("tui.value.fromConsole");
      case "providers.checking.minIntervalMs":
        return t("tui.value.everyMinutes", { count: count / 60_000 });
      case "providers.checking.requestTimeoutMs":
        return value === null
          ? t("option.providers.checking.requestTimeoutMs.unset")
          : t("option.seconds", { count: count / 1_000 });
      case "providers.pricing.autoRefreshDays":
        return count === 1 ? t("tui.value.everyDay") : t("tui.value.everyDays", { count });
      case "colors.warningBelow":
      case "colors.lowBelow":
        return t("tui.value.percentLeft", { count });
      default:
        return fallback;
    }
  };
  const optionValue = (field: Field, value: FieldValue): string => {
    const fallback = field.show(value);
    if (value === "on" || value === "off") {
      return translated(`tui.option.${value}`, fallback);
    }
    if (field.color && value !== null && value !== undefined) {
      return translated(`option.color.${String(value)}`, fallback);
    }
    if (value === null) {
      if (field.path === "providers.cursor.includedApiUsd") {
        return translated("tui.value.fromPlan", fallback);
      }
      if (field.path === "providers.opencode.monthlyLimitUsd") {
        return translated("tui.value.fromConsole", fallback);
      }
      if (field.path === "providers.cursor.billingCycleStartDay") {
        return translated("tui.value.calendarMonth", fallback);
      }
      if (field.path === "providers.checking.requestTimeoutMs") {
        return translated("option.providers.checking.requestTimeoutMs.unset", fallback);
      }
      return fallback;
    }
    const translatedValue = translated(`option.${field.path}.${String(value)}`, fallback);
    return translatedValue === fallback
      ? localizedOptionValue(field, value, fallback)
      : translatedValue;
  };
  const shown = () => draft.shown();
  const lineValue = (path: string): FieldValue => server.value(path) as FieldValue;
  const surface = isSurfaceTab(tab) ? tab : undefined;
  /** The page's tree and its edits; undefined on a page without a surface. */
  const editor = surface && surfaceEditor(surface, snapshot);

  function setValues(values: Readonly<Record<string, FieldValue>>): void {
    for (const [path, value] of Object.entries(values)) server.set(path, value);
  }

  /** What typing into a line does: a color for a color line, a number for a server number. */
  function typedValue(field: Field, role: ColorRole | undefined): Typed | undefined {
    if (role) {
      return {
        placeholder: "#rrggbb",
        hint:
          host.t?.("tui.window.hint.colorInput") ??
          "Type a color like #89b4fa, then enter · enter with nothing typed = the theme's color · esc stop",
        apply: (text) => draft.edit((settings) => typedColor(settings, field, text)),
      };
    }
    const placeholder = field.placeholder;
    if (!placeholder) return undefined;
    return {
      placeholder,
      hint:
        host.t?.("tui.window.hint.typeValue", {
          placeholder,
          value: optionValue(field, null),
        }) ??
        `Type ${placeholder}, then enter · enter with nothing typed = ${field.show(null)} · esc stop`,
      apply: (text) => {
        const value = typedNumber(field, text);
        if (value !== undefined) server.set(field.path, value);
      },
    };
  }

  /** A field's line: ‹ › step through its values, or you type one. */
  function fieldLine(field: Field): OptionLine {
    const role = field.color ? (field.path.slice("colors.".length) as ColorRole) : undefined;
    const value = () => (server.unset(field.path) ? null : lineValue(field.path));
    return {
      id: field.path,
      group: field.group ? translated(`tui.setting.group.${field.group}`, field.group) : undefined,
      title: translated(`setting.${field.path}`, field.title),
      depth: field.provider ? 1 : 0,
      value: () => optionValue(field, value()),
      cycle:
        field.values.length > 0
          ? (delta) => {
              const values = field.choices?.(shown()) ?? field.values;
              setValues({ [field.path]: stepIn(values, value(), delta) });
            }
          : undefined,
      typed: typedValue(field, role),
      note: () => {
        if (field.preset && presetChoice(field.preset, lineValue) !== undefined) {
          return translated("tui.setting.fromPreset", "from the preset");
        }
        if (!field.note || host.locale?.() !== "zh-Hans") return field.note ?? "";
        return translated(`setting.${field.path}.description`, field.note);
      },
      swatches: role ? () => [roleColor(host.theme, shown(), role, 60)] : undefined,
    };
  }

  function presetLine(name: PresetName): OptionLine {
    const choice = () => presetChoice(name, lineValue);
    return {
      id: `preset.${name}`,
      title: translated(`preset.${name}`, PRESETS[name].title),
      value: () => {
        const preset = choice();
        return preset
          ? translated(`preset.${name}.${preset}`, preset)
          : translated("tui.setting.yourOwn", "your own");
      },
      cycle: (delta) => setValues(presetValues(name, choice(), delta)),
      note: () => translated(`tui.setting.preset.${name}`, `sets ${PRESETS[name].drives}`),
    };
  }

  /** OpenCode's own theme list and light/dark switch; quota's colors follow them. */
  function themeLines(): OptionLine[] {
    return [
      {
        id: "theme",
        group: translated("tui.setting.group.OpenCode theme", "OpenCode theme"),
        title: translated("tui.setting.theme", "Theme"),
        value: () => translated("tui.setting.openThemeList", "open the theme list"),
        run: () => host.keymap.dispatch("theme.switch"),
        swatches: () => COLOR_NAMES.map((name) => namedColor(host.theme, name)),
        note: () =>
          translated(
            "tui.setting.themeNote",
            "↑↓ shows each theme live · enter keeps it · esc puts it back",
          ),
      },
      {
        id: "themeMode",
        title: translated("tui.setting.themeMode", "Light or dark"),
        value: () => host.themeMode ?? "dark",
        cycle: () => {
          host.keymap.dispatch("theme.switch_mode");
          // OpenCode's switch also closes its dialogs, which gives the keyboard to whatever had
          // it before the last dialog opened (the message box); take it back after that.
          setTimeout(refocus, 50);
        },
        note: () => translated("tui.setting.themeModeNote", "some themes have only one"),
      },
    ];
  }

  /**
   * A custom provider's switch, its web address and the key it would send; marked when the server
   * would not switch it on because it changed since the window showed it.
   */
  function customLine(entry: CustomProviderSwitch, first: boolean): OptionLine {
    const on = () => server.customOn(entry.id);
    const request = entry.request;
    const changed = server.changedSinceReview(entry.id);
    const where = !request
      ? translated("providers.custom.local", "a local estimate: sends nothing")
      : request.insecure
        ? `${request.url}  ${translated("providers.custom.insecure", "plain http: the key travels unencrypted")}`
        : request.url;
    return {
      id: `custom.${entry.id}`,
      group: first
        ? translated("tui.setting.customProviders", "Custom providers (added in settings.jsonc)")
        : undefined,
      gap: !first,
      title: entry.label,
      value: () => (on() ? "on" : "off"),
      cycle: () => server.switchCustom(entry.id, !on()),
      note: () =>
        changed
          ? `${translated("providers.custom.changed", CHANGED_SINCE_REVIEW)} · ${where}`
          : where,
      warning: changed || request?.insecure,
      detail: request ? `key: ${request.key}` : undefined,
    };
  }

  /**
   * The custom providers' switches (on top: an agent sends the user here to switch one on), which
   * providers quota checks (ticks, with Cursor's and OpenCode Zen's settings nested; the ones
   * quota found first), then the other groups.
   */
  function providerLines(): OptionLine[] {
    const loaded = server.saved();
    if (!loaded) return [];
    const found = foundProviderIds(snapshot);
    const off = () => server.value(PROVIDERS_KEY) as string[];
    const savedOff = loaded.values[PROVIDERS_KEY] as string[];
    const ordered = [
      ...loaded.providers.filter(({ id }) => found.includes(id)),
      ...loaded.providers.filter(({ id }) => !found.includes(id)),
    ];
    const ticks = ordered.flatMap(({ id, label }): OptionLine[] => {
      const ticked = isTicked(off(), id);
      const tick: OptionLine = {
        id: `provider.${id}`,
        group:
          id === ordered[0]?.id
            ? translated("tui.setting.group.Which providers", "Which providers")
            : undefined,
        title: `${ticked ? "[x]" : "[ ]"} ${label}`,
        tick: true,
        warning: true,
        // The tick says on or off; only a saved tick quota can't use says more (a tick not
        // saved yet is not checked yet).
        value: () =>
          ticked && isTicked(savedOff, id) && snapshot && !found.includes(id)
            ? translated("tui.state.providerNotSetup", "not set up")
            : "",
        cycle: () => server.set(PROVIDERS_KEY, withTick(off(), id, !ticked)),
      };
      const nested = ticked ? FIELDS.filter((field) => field.provider === id) : [];
      return [tick, ...nested.map(fieldLine)];
    });
    return [
      ...loaded.custom.map((entry, index) => customLine(entry, index === 0)),
      ...ticks,
      ...FIELDS.filter((field) => field.tab === "providers" && !field.provider).map(fieldLine),
    ];
  }

  /**
   * Collapsed's and Status line's window for every provider without its own pick in the list
   * below. ‹ › step through lowest and the windows the providers have.
   */
  function allProvidersLine(place: "collapsed" | "statusLine"): OptionLine {
    const current = (): WindowChoice => shown()[place].window[ALL_PROVIDERS] ?? "lowest";
    const choices = (): WindowChoice[] => {
      const found = new Set(
        (snapshot?.providers ?? []).flatMap((provider) =>
          provider.rows.flatMap((row) =>
            row.window && row.percentRemaining !== undefined ? [row.window] : [],
          ),
        ),
      );
      const windows = (Object.keys(WINDOWS) as QuotaWindow[]).filter(
        (window) => found.has(window) || window === current(),
      );
      return ["lowest", ...windows];
    };
    return {
      id: `${place}.window.${ALL_PROVIDERS}`,
      group: translated("tui.setting.group.Window", "Window"),
      title: translated("tui.setting.allProviders", "For all providers"),
      value: () => windowTitle(current(), host.t),
      cycle: (delta) => {
        const next = stepIn(choices(), current(), delta);
        draft.edit((settings) =>
          setIn(settings, [place, "window", ALL_PROVIDERS], next === "lowest" ? undefined : next),
        );
      },
      note: () =>
        translated(
          "tui.setting.allProvidersNote",
          "a pick below wins; a provider without it shows its lowest",
        ),
    };
  }

  /**
   * The page's option lines. A preset sits above the line it names, under that line's heading,
   * or else first, under "Preset". None until the saved settings arrive.
   */
  function optionLines(): OptionLine[] {
    if (tab === "providers") return providerLines();
    if (!server.saved()) return [];
    const presets = (Object.keys(PRESETS) as PresetName[]).filter(
      (name) => PRESETS[name].tab === tab,
    );
    const fields = FIELDS.filter((field) => field.tab === tab).flatMap((field) => {
      const line = fieldLine(field);
      const preset = presets.find((name) => PRESETS[name].before === field.path);
      return preset
        ? [
            { ...presetLine(preset), group: line.group },
            { ...line, group: undefined },
          ]
        : [line];
    });
    return [
      ...presets
        .filter((name) => PRESETS[name].before === undefined)
        .map((name) => ({
          ...presetLine(name),
          group: translated("tui.setting.group.Preset", "Preset"),
        })),
      ...(tab === "colors" ? themeLines() : []),
      ...fields,
      ...(tab === "collapsed" || tab === "statusLine" ? [allProvidersLine(tab)] : []),
    ];
  }

  const options = optionLines();
  const optionById = (id: string) => options.find((line) => line.id === id);
  /**
   * The tree line id of a selection id; undefined for any other line, and for a line the tree no
   * longer has (its provider left the snapshot). The time only changes the lines' texts.
   */
  const treeId = (id: string) =>
    editor?.lines(shown(), Date.now()).find((line) => lineKey(line.id) === id)?.id;

  return {
    surface: surface as Surface | undefined,
    editor,
    options,
    /** The surface's providers (and rows) as `nowMs` shows them; none without a surface. */
    tree(nowMs: number): TreeLine[] {
      return editor?.lines(shown(), nowMs) ?? [];
    },
    /** The selection ids, top to bottom: the surface switch, the options, then `tree`'s lines. */
    ids(tree: readonly TreeLine[]): string[] {
      return [
        ...(surface ? [SWITCH_ID] : []),
        ...options.map((line) => line.id),
        ...tree.map((line) => lineKey(line.id)),
      ];
    },
    /** ←/→ or ‹ ›: the line's next or previous value, or a provider's next or previous window. */
    step(id: string, delta: number): void {
      const option = optionById(id);
      const line = treeId(id);
      if (option) stepLine(option, delta);
      else if (editor && line !== undefined) draft.edit(editor.cycleWindow(line, delta));
    },
    /**
     * Space or enter: flip the surface switch, run a button, the next value, or show or hide a
     * tree line. "type" when the line takes typing instead.
     */
    activate(id: string): "type" | undefined {
      const option = optionById(id);
      const line = treeId(id);
      if (id === SWITCH_ID && editor) draft.edit(editor.toggleSurface());
      else if (option) return activateLine(option);
      else if (editor && line !== undefined) draft.edit(editor.toggleHidden(line));
      return undefined;
    },
    reset(): void {
      resetPage(server, tab);
    },
  };
}
