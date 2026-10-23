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
export type PageHost = Pick<WindowHost, "theme" | "themeMode" | "keymap">;

export type SettingsPage = ReturnType<typeof settingsPage>;

/** A window choice as its ‹ › shows it: "lowest left", "5h", … */
export function windowTitle(choice: WindowChoice): string {
  return choice === "lowest" ? "lowest left" : WINDOWS[choice].short;
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
        hint: "Type a color like #89b4fa, then enter · enter with nothing typed = the theme's color · esc stop",
        apply: (text) => draft.edit((settings) => typedColor(settings, field, text)),
      };
    }
    const placeholder = field.placeholder;
    if (!placeholder) return undefined;
    return {
      placeholder,
      hint: `Type ${placeholder}, then enter · enter with nothing typed = ${field.show(null)} · esc stop`,
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
      group: field.group,
      title: field.title,
      depth: field.provider ? 1 : 0,
      value: () => field.show(value()),
      cycle:
        field.values.length > 0
          ? (delta) => {
              const values = field.choices?.(shown()) ?? field.values;
              setValues({ [field.path]: stepIn(values, value(), delta) });
            }
          : undefined,
      typed: typedValue(field, role),
      note: () =>
        field.preset && presetChoice(field.preset, lineValue) !== undefined
          ? "from the preset"
          : (field.note ?? ""),
      swatches: role ? () => [roleColor(host.theme, shown(), role, 60)] : undefined,
    };
  }

  function presetLine(name: PresetName): OptionLine {
    const choice = () => presetChoice(name, lineValue);
    return {
      id: `preset.${name}`,
      title: PRESETS[name].title,
      value: () => choice() ?? "your own",
      cycle: (delta) => setValues(presetValues(name, choice(), delta)),
      note: () => `sets ${PRESETS[name].drives}`,
    };
  }

  /** OpenCode's own theme list and light/dark switch; quota's colors follow them. */
  function themeLines(): OptionLine[] {
    return [
      {
        id: "theme",
        group: "OpenCode theme",
        title: "Theme",
        value: () => "open the theme list",
        run: () => host.keymap.dispatch("theme.switch"),
        swatches: () => COLOR_NAMES.map((name) => namedColor(host.theme, name)),
        note: () => "↑↓ shows each theme live · enter keeps it · esc puts it back",
      },
      {
        id: "themeMode",
        title: "Light or dark",
        value: () => host.themeMode ?? "dark",
        cycle: () => {
          host.keymap.dispatch("theme.switch_mode");
          // OpenCode's switch also closes its dialogs, which gives the keyboard to whatever had
          // it before the last dialog opened (the message box); take it back after that.
          setTimeout(refocus, 50);
        },
        note: () => "some themes have only one",
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
      ? "a local estimate: sends nothing"
      : request.insecure
        ? `${request.url}  plain http: the key travels unencrypted`
        : request.url;
    return {
      id: `custom.${entry.id}`,
      group: first ? "Custom providers (added in settings.jsonc)" : undefined,
      gap: !first,
      title: entry.label,
      value: () => (on() ? "on" : "off"),
      cycle: () => server.switchCustom(entry.id, !on()),
      note: () => (changed ? `${CHANGED_SINCE_REVIEW} · ${where}` : where),
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
        group: id === ordered[0]?.id ? "Which providers" : undefined,
        title: `${ticked ? "[x]" : "[ ]"} ${label}`,
        tick: true,
        warning: true,
        // The tick says on or off; only a saved tick quota can't use says more (a tick not
        // saved yet is not checked yet).
        value: () =>
          ticked && isTicked(savedOff, id) && snapshot && !found.includes(id) ? "not set up" : "",
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
      group: "Window",
      title: "For all providers",
      value: () => windowTitle(current()),
      cycle: (delta) => {
        const next = stepIn(choices(), current(), delta);
        draft.edit((settings) =>
          setIn(settings, [place, "window", ALL_PROVIDERS], next === "lowest" ? undefined : next),
        );
      },
      note: () => "a pick below wins; a provider without it shows its lowest",
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
        .map((name) => ({ ...presetLine(name), group: "Preset" })),
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
