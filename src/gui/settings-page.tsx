/** @jsxImportSource solid-js */
/**
 * The Quota page in OpenCode's Settings: every server setting in sections (`settings-model.ts`),
 * each control made from the setting's rule in the server's schema, the presets, a tree per
 * surface (show or hide, order, rename rows, the window per provider), the Plugin switches with
 * the notices and the setup check, the settings only the file sets, and what OpenCode keeps.
 *
 * Edits go to a draft (`../tui/settings-draft.ts`, the TUI Settings tabs' own) until Save, which
 * sends only the changed keys to the server's `saveSettings`, the code the TUI saves with: it
 * checks them, keeps settings.jsonc's comments, and writes over the file as it is on disk then.
 * Each new snapshot carries the saved settings, so an edit of the file by hand shows at once
 * under the draft. While the page is open, the draft's changes show in Quota's other places.
 * The Plugin switches save at once, as on the TUI's Plugin tab.
 */
import type { Context } from "@opencode/plugin/gui";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  on,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js";
import type { QuotaSnapshot, QuotaWindow } from "../core/types.js";
import { ALL_PROVIDERS, WINDOWS } from "../core/windows.js";
import {
  isSettingsFilePath,
  type Notice,
  type QuotaRpcSettingsOutput,
  type QuotaRpcSettingsSchemaOutput,
} from "../rpc.js";
import type { CustomProviderSwitch, SettingRule, Settings } from "../settings/index.js";
import { rpcErrorMessage } from "../tui/client.js";
import {
  createSettingsDraft,
  isTicked,
  PROVIDERS_KEY,
  type SettingsDraft,
  settingsShape,
  withTick,
} from "../tui/settings-draft.js";
import { type SettingsEdit, surfaceEditor, type TreeLine } from "../tui/window/surface-editor.js";
import { PRESET_CHOICES, type PresetName, presetChoice } from "../view/presets.js";
import type { Surface, WindowChoice } from "../view/select.js";
import { setIn } from "../view/settings-edit.js";
import type { GuiQuota } from "./bridge.js";
import { en } from "./i18n.js";
import {
  changedSettings,
  type Control,
  controlFor,
  fileOnlyKeys,
  type Option,
  PROVIDER_KEYS,
  presetNames,
  rangeWords,
  resetKeys,
  rowGroups,
  SECTIONS,
  type Section,
  sectionRows,
  SUBHEADINGS,
  TUI_ONLY,
  typedNumber,
  type Words,
} from "./settings-model.js";
import { SURFACE_GROUPS, settingsFromValues } from "./surface-settings.js";

/** The page's id: its Settings tab, and `ctx.layout.settings`'s argument. */
export const SETTINGS_PAGE_ID = "quota";
const CLOCK_MS = 60_000;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Shows `value` in `input`, except while it has focus: a new snapshot leaves the text being typed
 * alone. Once it loses focus (after its change, if any), it shows `value` again; `keep` holds text
 * the control refused, so the user sees what to fix.
 */
function mirror(input: HTMLInputElement, value: () => string, keep = () => false): void {
  createEffect(() => {
    const next = value();
    if (document.activeElement !== input) input.value = next;
  });
  input.addEventListener("blur", () => {
    if (!keep()) input.value = untrack(value);
  });
}

/** The Quota tab's open or folded state, which plugin storage keeps (`index.tsx`). */
export type PanelOpenState = { open(): boolean; set(open: boolean): void; load(): void };

/**
 * The page's state across visits: the schema, and the draft made once it arrived, so unsaved
 * changes stay while the user looks at another page.
 */
export function createSettingsPageState(data: GuiQuota) {
  const [schema, setSchema] = createSignal<QuotaRpcSettingsSchemaOutput>();
  const [draft, setDraft] = createSignal<SettingsDraft>();
  const [failure, setFailure] = createSignal<unknown>();
  let loading: Promise<void> | undefined;
  /** The draft while its first read waits: snapshots that come meanwhile go to it. */
  let reading: SettingsDraft | undefined;
  /** The snapshot settings last offered: a snapshot shown again is not news. */
  let offered: QuotaRpcSettingsOutput | undefined;
  return {
    schema,
    draft,
    failure,
    /**
     * The saved settings a snapshot carries: an edit of the file shows under the draft. Before
     * the draft starts reading the settings, and when the same snapshot comes again (the page
     * shows the draft, or opens again), they are older than the draft's and are dropped; a newer
     * one that comes during the read wins over it.
     */
    receive(settings: QuotaRpcSettingsOutput): void {
      if (settings === offered) return;
      offered = settings;
      (draft() ?? reading)?.receive(settings);
    },
    /** Asks for the schema (each visit: the server may have restarted) and the saved settings. */
    load(): Promise<void> {
      loading ??= (async () => {
        try {
          const answer = await data.settingsSchema();
          const rulesChanged = !same(answer.rules, schema()?.rules);
          setSchema(answer);
          const existing = draft();
          if (existing && rulesChanged) existing.reshape(settingsShape(answer.rules));
          const current =
            existing ??
            createSettingsDraft(
              { settings: data.settings, saveSettings: data.saveSettings },
              settingsShape(answer.rules),
            );
          reading = current;
          await current.load();
          setDraft(current);
          setFailure(undefined);
        } catch (error) {
          setFailure(error);
        } finally {
          reading = undefined;
          loading = undefined;
        }
      })();
      return loading;
    },
  };
}

export type SettingsPageState = ReturnType<typeof createSettingsPageState>;

type PageProps = {
  ctx: Context;
  data: GuiQuota;
  state: SettingsPageState;
  directory: () => string | undefined;
  sessionID: () => string | undefined;
  panel: PanelOpenState;
  /** Shows the draft's changes in Quota's other places; undefined stops. */
  setPreview: (values: Readonly<Record<string, unknown>> | undefined) => void;
  /** The search entry to scroll to. */
  target?: string;
};

/** Words by an i18n key, or `fallback` for a key the words lack (a value of a newer server). */
function say(ctx: Context, words: Words, fallback?: string): string {
  if (fallback !== undefined && !Object.hasOwn(en, words.key)) return fallback;
  return ctx.t(words.key, words.params);
}

/** The search entries: the page, and each section. */
export function settingsEntries(ctx: Context) {
  return [
    { id: SETTINGS_PAGE_ID, title: ctx.t("settings.title"), keywords: "quota usage limits" },
    ...SECTIONS.map((section) => ({
      id: `${SETTINGS_PAGE_ID}.${section.id}`,
      title: ctx.t(`section.${section.id}`),
      description: ctx.t(`section.${section.id}.description`),
    })),
  ];
}

export function SettingsPageView(props: PageProps) {
  const { ctx, data, state } = props;
  const snapshot = () => data.snapshot(props.directory(), props.sessionID());
  const [nowMs, setNowMs] = createSignal(Date.now());
  const clock = setInterval(() => setNowMs(Date.now()), CLOCK_MS);
  onCleanup(() => clearInterval(clock));
  createEffect(() => {
    onCleanup(data.watch(props.directory(), props.sessionID()));
  });
  void state.load();
  props.panel.load();

  // The saved settings each snapshot carries: an edit of the file shows under the draft.
  createEffect(() => {
    const saved = snapshot()?.settings;
    if (saved) untrack(() => state.receive(saved));
  });

  // The draft's changes over the saved settings in Quota's other places, while the page is open.
  createEffect(() => {
    const draft = state.draft();
    if (!draft) return;
    props.setPreview(Object.fromEntries(draft.changedKeys().map((key) => [key, draft.value(key)])));
  });
  onCleanup(() => props.setPreview(undefined));

  onMount(() => {
    if (!props.target) return;
    const target = props.target;
    // The sections render once the settings arrive.
    createEffect(() => {
      if (!state.draft()) return;
      queueMicrotask(() =>
        document
          .querySelector(`.oq-settings [data-action="${CSS.escape(target)}"]`)
          ?.scrollIntoView({ block: "start" }),
      );
    });
  });

  const failureText = () => {
    const error = state.failure();
    if (error === undefined) return undefined;
    const unavailable =
      typeof error === "object" &&
      error !== null &&
      "type" in error &&
      error.type === "rpc.unavailable";
    return unavailable
      ? ctx.t("settings.unavailable")
      : ctx.t("settings.error", { message: rpcErrorMessage(error) });
  };

  return (
    <div class="oq-window oq-settings" data-mode={ctx.appearance.mode()}>
      <Show
        when={state.draft()?.saved() !== undefined && state.schema() ? state.draft() : undefined}
        fallback={
          <>
            <PageHeader ctx={ctx} />
            <div class="settings-tab-body settings-tab-body--sectioned">
              <Show
                when={failureText()}
                fallback={
                  <div class="oq-note">
                    <ctx.ui.Loader size="large" /> {ctx.t("settings.loading")}
                  </div>
                }
              >
                {(text) => <p class="oq-error">{text()}</p>}
              </Show>
            </div>
          </>
        }
      >
        {(draft) => (
          <Page
            {...props}
            draft={draft()}
            rules={(state.schema() as QuotaRpcSettingsSchemaOutput).rules}
            path={(state.schema() as QuotaRpcSettingsSchemaOutput).path}
            snapshot={snapshot}
            nowMs={nowMs}
          />
        )}
      </Show>
    </div>
  );
}

/**
 * The page's title block, made as OpenCode's own Settings pages make theirs, so the app's styles
 * give it their look (with `style.ts`'s fallback); `actions` sit at its right, `children` under it.
 */
function PageHeader(props: { ctx: Context; actions?: JSX.Element; children?: JSX.Element }) {
  const { ctx } = props;
  // The header's height on the page's root, so a section or row scrolled to starts below it.
  const [header, setHeader] = createSignal<HTMLDivElement>();
  createEffect(() => {
    const element = header();
    const root = element?.parentElement;
    if (!element || !root) return;
    const measure = () => root.style.setProperty("--oq-head-h", `${element.offsetHeight}px`);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    onCleanup(() => observer.disconnect());
  });
  return (
    <div ref={setHeader} class="settings-tab-header settings-tab-header--stacked">
      <div class="settings-tab-header-row">
        <div class="flex flex-col gap-1 oq-shead-copy">
          <h2 class="settings-tab-title">{ctx.t("settings.title")}</h2>
          <span class="text-11-regular text-v2-text-text-muted">{ctx.t("settings.intro")}</span>
        </div>
        {props.actions}
      </div>
      {props.children}
    </div>
  );
}

type Shown = PageProps & {
  draft: SettingsDraft;
  rules: Readonly<Record<string, SettingRule>>;
  path: string;
  snapshot: () => QuotaSnapshot | undefined;
  nowMs: () => number;
};

/** The surface settings' keys, which a tree edit may change. */
function surfaceKeys(rules: Readonly<Record<string, SettingRule>>): string[] {
  const groups: readonly string[] = SURFACE_GROUPS;
  return Object.keys(rules).filter((key) => groups.includes(key.split(".")[0] as string));
}

function Page(props: Shown) {
  const { ctx, draft } = props;
  const [saving, setSaving] = createSignal(false);
  const [saveError, setSaveError] = createSignal<string>();
  const [savedNote, setSavedNote] = createSignal(false);
  /** What a row shows: null for a setting the file leaves unset whose unset isn't its default. */
  const valueOf = (key: string) => (draft.unset(key) ? null : draft.value(key));
  /** The settings the page shows, as the surfaces read them: the saved ones with the draft. */
  const shown = createMemo(() =>
    settingsFromValues(
      Object.fromEntries(surfaceKeys(props.rules).map((key) => [key, draft.value(key)])),
    ),
  );
  const keys = surfaceKeys(props.rules);
  /** A tree edit: each surface setting it changes goes to the draft. */
  const apply = (edit: SettingsEdit) => {
    const before = shown();
    for (const [key, value] of changedSettings(before, edit(before), keys)) draft.set(key, value);
  };

  async function save(): Promise<void> {
    setSaving(true);
    setSaveError(undefined);
    try {
      await draft.save();
      setSavedNote(true);
      setTimeout(() => setSavedNote(false), 3_000);
    } catch (error) {
      setSaveError(rpcErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function discard(): Promise<void> {
    // An OpenCode without the app's confirmation dialog discards without asking.
    let confirmed = true;
    try {
      confirmed = await ctx.dialogs.confirm({
        title: ctx.t("settings.discard.title"),
        description: ctx.t("settings.discard.description"),
        confirm: ctx.t("settings.discard"),
        danger: true,
      });
    } catch {
      confirmed = true;
    }
    if (confirmed) {
      draft.discard();
      setSaveError(undefined);
    }
  }

  const unsaved = () => {
    const count = draft.count();
    if (count === 0) return ctx.t("settings.unsaved.none");
    return ctx.t(count === 1 ? "settings.unsaved.one" : "settings.unsaved.other", { count });
  };

  const jump = (id: string) =>
    document
      .querySelector(`.oq-settings [data-action="${SETTINGS_PAGE_ID}.${id}"]`)
      ?.scrollIntoView({ block: "start", behavior: "smooth" });

  return (
    <>
      <PageHeader
        ctx={ctx}
        actions={
          <div class="oq-shead-actions">
            <span class="oq-small oq-muted" aria-live="polite">
              {savedNote() && draft.count() === 0 ? ctx.t("settings.saved") : unsaved()}
            </span>
            <ctx.ui.Button
              disabled={draft.count() === 0 || saving()}
              onClick={() => void discard()}
            >
              {ctx.t("settings.discard")}
            </ctx.ui.Button>
            <ctx.ui.Button
              variant="contrast"
              busy={saving()}
              disabled={draft.count() === 0}
              onClick={() => void save()}
            >
              {ctx.t("settings.save")}
            </ctx.ui.Button>
          </div>
        }
      >
        <Show when={saveError()}>
          {(message) => (
            <p class="oq-error">{ctx.t("settings.saveFailed", { message: message() })}</p>
          )}
        </Show>
        <nav class="oq-snav">
          <For each={SECTIONS}>
            {(section) => (
              <ctx.ui.Button variant="ghost-muted" size="small" onClick={() => jump(section.id)}>
                {ctx.t(`section.${section.id}`)}
              </ctx.ui.Button>
            )}
          </For>
        </nav>
      </PageHeader>
      <div class="settings-tab-body settings-tab-body--sectioned">
        <For each={SECTIONS}>
          {(section) => (
            <SectionView
              {...props}
              section={section}
              valueOf={valueOf}
              shown={shown}
              apply={apply}
            />
          )}
        </For>
      </div>
    </>
  );
}

type SectionProps = Shown & {
  section: Section;
  valueOf: (key: string) => unknown;
  shown: () => Settings;
  apply: (edit: SettingsEdit) => void;
};

function SectionView(props: SectionProps) {
  const { ctx, section, draft } = props;
  const tuiName = Object.hasOwn(en, `section.${section.id}.tui`)
    ? ctx.t(`section.${section.id}.tui`)
    : undefined;
  const canReset = !section.instant && section.id !== "file" && section.id !== "opencode";
  const reset = () => {
    for (const key of resetKeys(section, props.rules)) draft.reset(key);
    if (section.id === "providers") draft.discardSwitches();
  };
  const groups = () => rowGroups(sectionRows(section, props.rules), SUBHEADINGS);
  const presetAlone = () => {
    const first = groups()[0];
    return first === undefined || first.heading !== undefined;
  };
  return (
    <section class="settings-section" data-action={`${SETTINGS_PAGE_ID}.${section.id}`}>
      <div class="oq-sgroup-head">
        <div class="oq-sgroup-title">
          <h3 class="settings-section-title">{ctx.t(`section.${section.id}`)}</h3>
          <Show when={tuiName}>
            {(name) => <span class="oq-chip">{ctx.t("settings.tuiName", { name: name() })}</span>}
          </Show>
          <Show when={canReset}>
            <span class="oq-right">
              <ctx.ui.Button variant="ghost" size="small" onClick={reset}>
                {ctx.t("settings.resetSection")}
              </ctx.ui.Button>
            </span>
          </Show>
        </div>
        <p class="oq-sgroup-desc">{ctx.t(`section.${section.id}.description`)}</p>
      </div>
      <Show when={section.id === "providers"}>
        <ProvidersView {...props} />
      </Show>
      <Show when={section.id !== "providers"}>
        {/* A preset sets the whole section, so it gets a card of its own when the first card
            has a subheading (Colors: "Bars"), or when there are no rows. */}
        <Show when={presetAlone() && section.preset}>
          {(name) => (
            <List>
              <PresetRow {...props} name={name()} />
            </List>
          )}
        </Show>
        <For each={groups()}>
          {(group, at) => (
            <List heading={group.heading && ctx.t(group.heading)}>
              <Show when={at() === 0 && !presetAlone() && section.preset}>
                {(name) => <PresetRow {...props} name={name()} />}
              </Show>
              <For each={group.rows}>
                {(row) => <SettingRow {...props} settingKey={row.key} rule={row.rule} />}
              </For>
            </List>
          )}
        </For>
      </Show>
      <Show when={section.editor}>{(surface) => <TreeView {...props} surface={surface()} />}</Show>
      <Show when={section.id === "plugin"}>
        <PluginExtras {...props} />
      </Show>
      <Show when={section.id === "file"}>
        <FileOnlyView {...props} />
      </Show>
      <Show when={section.id === "opencode"}>
        <OpenCodeView {...props} />
      </Show>
    </section>
  );
}

/**
 * One card of rows, as OpenCode's `SettingsList` makes it, under its own small heading if it has
 * one.
 */
function List(props: { heading?: string; children: JSX.Element }) {
  return (
    <div class="oq-sgroup-part">
      <Show when={props.heading}>{(heading) => <h4 class="oq-subhead">{heading()}</h4>}</Show>
      <div data-component="settings-list">{props.children}</div>
    </div>
  );
}

/**
 * One row, as OpenCode's `SettingsRow` makes it: the setting's name, words and key, and its
 * control; a dot marks an unsaved change.
 */
function Row(props: {
  ctx: Context;
  action: string;
  title: string;
  description?: string;
  settingKey?: string;
  changed?: boolean;
  chips?: JSX.Element;
  children: JSX.Element;
  nested?: boolean;
}) {
  return (
    <div
      data-component="settings-row"
      class="oq-srow"
      classList={{ "oq-changed": props.changed === true, "oq-nested": props.nested === true }}
      data-action={props.action}
    >
      <div data-slot="settings-row-copy">
        <div data-slot="settings-row-title">
          {props.title}
          {props.chips}
        </div>
        <Show when={props.description || props.settingKey}>
          <div data-slot="settings-row-description">
            <Show when={props.description}>{(text) => <span class="oq-d">{text()}</span>}</Show>
            <Show when={props.settingKey}>{(key) => <span class="oq-key">{key()}</span>}</Show>
          </div>
        </Show>
      </div>
      <div data-slot="settings-row-control">{props.children}</div>
    </div>
  );
}

function settingWords(ctx: Context, key: string) {
  const description = `setting.${key}.description`;
  return {
    title: say(ctx, { key: `setting.${key}` }, key),
    description: Object.hasOwn(en, description) ? ctx.t(description) : undefined,
  };
}

function SettingRow(
  props: SectionProps & { settingKey: string; rule: SettingRule; nested?: boolean },
) {
  const { ctx, draft, settingKey: key } = props;
  const words = settingWords(ctx, key);
  const instant = props.section.instant === true;
  const [busy, setBusy] = createSignal(false);
  const [problem, setProblem] = createSignal<string>();
  const set = (value: unknown) => {
    setProblem(undefined);
    if (!instant) {
      draft.set(key, value);
      return;
    }
    // The Plugin switches save at once; another click waits for the first.
    if (busy()) return;
    setBusy(true);
    draft
      .saveNow(key, value)
      .catch((error: unknown) => setProblem(rpcErrorMessage(error)))
      .finally(() => setBusy(false));
  };
  // A new control only when its kind or choices change, not with each value.
  const control = createMemo(() => controlFor(key, props.rule, props.valueOf(key)), undefined, {
    equals: same,
  });
  return (
    <Row
      ctx={ctx}
      action={`${SETTINGS_PAGE_ID}.${key}`}
      title={words.title}
      description={problem() ?? words.description}
      settingKey={instant ? `${key} · ${ctx.t("settings.savesAtOnce")}` : key}
      changed={draft.changedKeys().includes(key)}
      nested={props.nested}
      chips={
        <Show when={TUI_ONLY.has(key)}>
          <span class="oq-chip oq-tui">{ctx.t("settings.tuiOnly")}</span>
        </Show>
      }
    >
      <ControlView
        ctx={ctx}
        settingKey={key}
        title={words.title}
        control={control()}
        value={props.valueOf(key)}
        disabled={busy()}
        set={set}
      />
    </Row>
  );
}

/** A native select over `options`, whose values may be any JSON value or undefined. */
function Select(props: {
  label: string;
  options: readonly { value: unknown; label: string }[];
  value: unknown;
  disabled?: boolean;
  onPick: (value: unknown) => void;
}) {
  const index = () => props.options.findIndex((option) => same(option.value, props.value));
  return (
    <select
      class="oq-select"
      aria-label={props.label}
      disabled={props.disabled}
      onChange={(event) => {
        const picked = props.options[Number(event.currentTarget.value)];
        if (picked) props.onPick(picked.value);
      }}
    >
      <For each={props.options}>
        {(option, at) => (
          <option value={String(at())} selected={at() === index()}>
            {option.label}
          </option>
        )}
      </For>
    </select>
  );
}

function ControlView(props: {
  ctx: Context;
  settingKey: string;
  title: string;
  control: Control;
  value: unknown;
  disabled?: boolean;
  set: (value: unknown) => void;
}) {
  const { ctx } = props;
  const options = (list: readonly Option[]) =>
    list.map((option) => ({
      value: option.value,
      label: say(ctx, option.words, String(option.value)),
    }));
  return (
    <>
      {(() => {
        const control = props.control;
        switch (control.kind) {
          case "switch":
            return (
              <ctx.ui.Switch
                label={props.title}
                hideLabel
                checked={props.value === true}
                disabled={props.disabled}
                onChange={(checked) => props.set(checked)}
              />
            );
          case "select":
            return (
              <Select
                label={props.title}
                options={options(control.options)}
                value={props.value}
                disabled={props.disabled}
                onPick={props.set}
              />
            );
          case "number":
            return <NumberControl {...props} control={control} />;
          case "color":
            return <ColorControl {...props} options={options(control.options)} />;
          case "text":
            return (
              <input
                class="oq-input oq-mono"
                type="text"
                aria-label={props.title}
                maxLength={control.maxLength}
                ref={(input) => mirror(input, () => String(props.value ?? ""))}
                onChange={(event) => props.set(event.currentTarget.value)}
              />
            );
          case "none":
            return null;
        }
      })()}
    </>
  );
}

function NumberControl(props: {
  ctx: Context;
  title: string;
  control: Extract<Control, { kind: "number" }>;
  value: unknown;
  set: (value: unknown) => void;
}) {
  const { ctx } = props;
  const [invalid, setInvalid] = createSignal(false);
  const word = props.control.word;
  const usesWord = () => word !== undefined && props.value === word;
  const range = rangeWords(props.control);
  // A value set elsewhere (a preset, a snapshot, Reset, Discard) replaces refused text: `mirror`
  // shows it once the field is not focused.
  createEffect(
    on(
      () => props.value,
      () => setInvalid(false),
      { defer: true },
    ),
  );
  const input = () => (
    <input
      class="oq-input oq-number"
      type="number"
      aria-label={props.title}
      aria-invalid={invalid()}
      min={props.control.min ?? props.control.above}
      max={props.control.max}
      step={props.control.integer ? 1 : "any"}
      ref={(input) =>
        mirror(input, () => (typeof props.value === "number" ? String(props.value) : ""), invalid)
      }
      placeholder={range ? say(ctx, range) : undefined}
      onChange={(event) => {
        const value = typedNumber(props.control, event.currentTarget.value);
        setInvalid(value === undefined);
        if (value !== undefined) props.set(value);
      }}
    />
  );
  return (
    <span class="oq-ctl-line">
      <Show when={word !== undefined}>
        <Select
          label={props.title}
          options={[
            { value: true, label: String(word) },
            { value: false, label: ctx.t("settings.fixed") },
          ]}
          value={usesWord()}
          onPick={(picked) => {
            if (picked === true) props.set(word);
            else if (usesWord()) props.set(fixedStart(props.control));
          }}
        />
      </Show>
      <Show when={!usesWord()}>{input()}</Show>
      <Show when={range && !usesWord()}>
        <span class="oq-small oq-muted">{say(ctx, range as Words)}</span>
      </Show>
      <Show when={invalid()}>
        <span class="oq-small oq-bad">{ctx.t("settings.invalid")}</span>
      </Show>
    </span>
  );
}

/** The number a "fixed" pick starts from: 10 within the rule's bounds. */
function fixedStart(control: Extract<Control, { kind: "number" }>): number {
  return Math.min(control.max ?? 10, Math.max(control.min ?? 10, 10));
}

const HEX = /^#[0-9a-f]{6}$/iu;

function ColorControl(props: {
  ctx: Context;
  title: string;
  options: readonly { value: unknown; label: string }[];
  value: unknown;
  set: (value: unknown) => void;
}) {
  const isHex = () => typeof props.value === "string" && HEX.test(props.value);
  const custom = "#";
  return (
    <span class="oq-ctl-line">
      <Select
        label={props.title}
        options={[...props.options, { value: custom, label: props.ctx.t("settings.custom") }]}
        value={isHex() ? custom : props.value}
        onPick={(picked) => props.set(picked === custom ? "#89b4fa" : picked)}
      />
      <Show when={isHex()}>
        <input
          class="oq-color"
          type="color"
          aria-label={props.title}
          ref={(input) => mirror(input, () => String(props.value))}
          onChange={(event) => props.set(event.currentTarget.value.toLowerCase())}
        />
      </Show>
    </span>
  );
}

function PresetRow(props: SectionProps & { name: PresetName }) {
  const { ctx, draft } = props;
  const current = () => presetChoice(props.name, props.valueOf);
  const pick = (choice: string) => {
    for (const [key, value] of Object.entries(PRESET_CHOICES[props.name][choice] ?? {})) {
      if (Object.hasOwn(props.rules, key)) draft.set(key, value);
    }
  };
  return (
    <Row
      ctx={ctx}
      action={`${SETTINGS_PAGE_ID}.preset.${props.name}`}
      title={ctx.t(`preset.${props.name}`)}
      description={ctx.t("preset.description")}
    >
      <span class="oq-seg" role="group" aria-label={ctx.t(`preset.${props.name}`)}>
        <For each={presetNames(props.name)}>
          {(choice) => (
            <button type="button" aria-pressed={current() === choice} onClick={() => pick(choice)}>
              {say(ctx, { key: `preset.${props.name}.${choice}` }, choice)}
            </button>
          )}
        </For>
      </span>
    </Row>
  );
}

/** Each built-in provider's switch with its own settings nested, then the custom providers. */
function ProvidersView(props: SectionProps) {
  const { ctx, draft } = props;
  const off = () => (draft.value(PROVIDERS_KEY) as string[] | undefined) ?? [];
  const savedOff = () => (draft.saved()?.values[PROVIDERS_KEY] as string[] | undefined) ?? [];
  const providers = () => draft.saved()?.providers ?? [];
  const custom = () => draft.saved()?.custom ?? [];
  const state = (id: string) => {
    if (id === "custom") {
      const count = custom().length;
      return ctx.t(count === 1 ? "providers.defined.one" : "providers.defined.other", { count });
    }
    const found = props.snapshot()?.providers.find((provider) => provider.providerId === id);
    if (!found) return ctx.t("providers.notFound");
    return ctx.t(found.error ? "providers.failing" : "providers.found");
  };
  const failing = (id: string) =>
    props.snapshot()?.providers.some((provider) => provider.providerId === id && provider.error);
  return (
    <>
      <List heading={ctx.t("providers.builtIn")}>
        <For each={providers()}>
          {(provider) => {
            const on = () => isTicked(off(), provider.id);
            return (
              <>
                <Row
                  ctx={ctx}
                  action={`${SETTINGS_PAGE_ID}.provider.${provider.id}`}
                  title={provider.label}
                  settingKey={provider.id}
                  changed={isTicked(savedOff(), provider.id) !== on()}
                  chips={
                    <span class="oq-chip" classList={{ "oq-bad": failing(provider.id) === true }}>
                      {state(provider.id)}
                    </span>
                  }
                >
                  <ctx.ui.Switch
                    label={ctx.t("providers.switch", { name: provider.label })}
                    hideLabel
                    checked={on()}
                    onChange={(checked) =>
                      draft.set(PROVIDERS_KEY, withTick(off(), provider.id, checked))
                    }
                  />
                </Row>
                <Show when={on()}>
                  <For
                    each={(PROVIDER_KEYS[provider.id] ?? []).filter((key) =>
                      Object.hasOwn(props.rules, key),
                    )}
                  >
                    {(key) => (
                      <SettingRow
                        {...props}
                        settingKey={key}
                        rule={props.rules[key] as SettingRule}
                        nested
                      />
                    )}
                  </For>
                </Show>
              </>
            );
          }}
        </For>
      </List>
      <Show when={custom().length > 0}>
        <List heading={ctx.t("providers.custom")}>
          <For each={custom()}>{(entry) => <CustomRow {...props} entry={entry} />}</For>
        </List>
      </Show>
    </>
  );
}

function CustomRow(props: SectionProps & { entry: CustomProviderSwitch }) {
  const { ctx, draft, entry } = props;
  const request = entry.request;
  const where = () => {
    const parts = [
      draft.changedSinceReview(entry.id) ? ctx.t("providers.custom.changed") : "",
      request
        ? ctx.t("providers.custom.remote", { key: request.key, url: request.url })
        : ctx.t("providers.custom.local"),
      request?.insecure ? ctx.t("providers.custom.insecure") : "",
    ];
    return parts.filter(Boolean).join(" ");
  };
  return (
    <Row
      ctx={ctx}
      action={`${SETTINGS_PAGE_ID}.custom.${entry.id}`}
      title={entry.label}
      description={where()}
      settingKey={entry.id}
      changed={draft.customOn(entry.id) !== entry.enabled}
    >
      <ctx.ui.Switch
        label={ctx.t("providers.switch", { name: entry.label })}
        hideLabel
        checked={draft.customOn(entry.id)}
        onChange={(checked) => draft.switchCustom(entry.id, checked)}
      />
    </Row>
  );
}

/** A window's name: "lowest left", or its short name ("5h"). */
function windowName(ctx: Context, choice: WindowChoice): string {
  return choice === "lowest" ? ctx.t("settings.window.lowest") : WINDOWS[choice].short;
}

/** A surface's providers (and rows on Side panel and Toasts): show, hide, order, name, window. */
function TreeView(props: SectionProps & { surface: Surface }) {
  const { ctx } = props;
  const editor = createMemo(() => surfaceEditor(props.surface, props.snapshot()));
  const lines = createMemo(() => editor().lines(props.shown(), props.nowMs()));
  /** The lines' ids: a row stays (its rename input too) while only its words change. */
  const ids = createMemo(() => lines().map((line) => line.id), undefined, { equals: same });
  const lineOf = (id: string) => lines().find((line) => line.id === id);
  const names = props.surface === "sidebar" || props.surface === "toast";
  const windows = props.surface === "collapsed" || props.surface === "statusLine";
  const summary = names
    ? ctx.t("editor.summaryNames")
    : windows
      ? ctx.t("editor.summaryWindow")
      : ctx.t("editor.summary");
  /** "For all providers": lowest, and every window a provider of the snapshot has. */
  const allChoices = (): WindowChoice[] => {
    const found = new Set(
      (props.snapshot()?.providers ?? []).flatMap((provider) =>
        provider.rows.flatMap((row) =>
          row.window && row.percentRemaining !== undefined ? [row.window] : [],
        ),
      ),
    );
    return [
      "lowest",
      ...(Object.keys(WINDOWS) as QuotaWindow[]).filter((window) => found.has(window)),
    ];
  };
  const allPick = (): WindowChoice =>
    (props.shown()[props.surface as "collapsed" | "statusLine"].window[ALL_PROVIDERS] as
      | WindowChoice
      | undefined) ?? "lowest";
  return (
    <details class="oq-tree-box">
      <summary>{summary}</summary>
      <Show when={lines().length > 0} fallback={<p class="oq-note">{ctx.t("editor.empty")}</p>}>
        <div data-component="settings-list" class="oq-tree">
          <Show when={windows}>
            <div class="oq-tr">
              <span />
              <span>
                <b>{ctx.t("editor.allProviders")}</b>{" "}
                <span class="oq-small oq-muted">{ctx.t("editor.allProvidersNote")}</span>
              </span>
              <Select
                label={ctx.t("editor.allProviders")}
                options={allChoices().map((choice) => ({
                  value: choice,
                  label: windowName(ctx, choice),
                }))}
                value={allPick()}
                onPick={(picked) =>
                  props.apply((settings) =>
                    setIn(
                      settings,
                      [props.surface, "window", ALL_PROVIDERS],
                      picked === "lowest" ? undefined : picked,
                    ),
                  )
                }
              />
              <span />
            </div>
          </Show>
          <For each={ids()}>
            {(id) => (
              <Show when={lineOf(id)}>
                {(line) => <TreeRow {...props} line={line} editor={editor} names={names} />}
              </Show>
            )}
          </For>
        </div>
      </Show>
    </details>
  );
}

function TreeRow(
  props: SectionProps & {
    surface: Surface;
    line: () => TreeLine;
    editor: () => ReturnType<typeof surfaceEditor>;
    names: boolean;
  },
) {
  const { ctx, editor } = props;
  const line = props.line;
  const id = line().id;
  const choices = () => (line().row ? [] : editor().windowChoices(id, props.shown()));
  const rename = () => (line().row && props.names ? editor().rename(id) : undefined);
  const namesKey = props.surface === "toast" ? "toast" : "sidebar";
  const ownName = () => (props.shown()[namesKey].names[id] as string | undefined) ?? "";
  /** The window the provider follows without a pick of its own: picking it removes the pick. */
  const followsAll = (choice: WindowChoice) => {
    const windowsKey = props.surface as "collapsed" | "statusLine";
    const picked = editor().pickWindow(id, choice)(props.shown());
    return picked[windowsKey].window[id] === undefined;
  };
  const windowLabel = (choice: WindowChoice) =>
    followsAll(choice)
      ? `${windowName(ctx, choice)} (${ctx.t("editor.sameAsAll")})`
      : windowName(ctx, choice);
  return (
    <div
      class="oq-tr"
      classList={{
        "oq-tr-row": line().row,
        "oq-tr-muted": line().muted,
        "oq-tr-hidden": line().hidden,
      }}
    >
      <input
        type="checkbox"
        checked={!line().hidden}
        aria-label={ctx.t("editor.show", { name: line().label })}
        onChange={() => props.apply(editor().toggleHidden(id))}
      />
      <span class="oq-tr-name">
        {line().row ? line().label : <b>{line().label}</b>}
        <Show when={line().detail}>
          <span class="oq-small oq-muted"> {line().detail}</span>
        </Show>
      </span>
      <Show
        when={rename()}
        fallback={
          <Show when={choices().length > 0} fallback={<span />}>
            <Select
              label={ctx.t("editor.window", { name: line().label })}
              options={choices().map((choice) => ({ value: choice, label: windowLabel(choice) }))}
              value={line().window}
              onPick={(picked) => props.apply(editor().pickWindow(id, picked as WindowChoice))}
            />
          </Show>
        }
      >
        {(row) => (
          <input
            class="oq-input"
            type="text"
            aria-label={ctx.t("editor.rename", { name: line().label })}
            placeholder={line().label}
            ref={(input) => mirror(input, ownName)}
            onChange={(event) => props.apply(row().apply(event.currentTarget.value))}
          />
        )}
      </Show>
      <span class="oq-mv">
        <button
          type="button"
          aria-label={ctx.t("editor.up", { name: line().label })}
          onClick={() => props.apply(editor().move(id, -1))}
        >
          ▲
        </button>
        <button
          type="button"
          aria-label={ctx.t("editor.down", { name: line().label })}
          onClick={() => props.apply(editor().move(id, 1))}
        >
          ▼
        </button>
      </span>
    </div>
  );
}

/** The notices and the setup check with Copy, asked for at each visit. */
function PluginExtras(props: SectionProps) {
  const { ctx, data } = props;
  const [notices, setNotices] = createSignal<Notice[]>();
  const [status, setStatus] = createSignal<string>();
  const [problem, setProblem] = createSignal<string>();
  const [statusProblem, setStatusProblem] = createSignal<string>();
  const [copied, setCopied] = createSignal(false);
  void data.notices().then(setNotices, (error: unknown) => setProblem(rpcErrorMessage(error)));
  // The setup check of the session shown, again when it changes; a late answer for another drops.
  createEffect(() => {
    const sessionID = props.sessionID();
    let current = true;
    onCleanup(() => {
      current = false;
    });
    setStatus(undefined);
    setStatusProblem(undefined);
    void data.status(sessionID).then(
      (text) => {
        if (current) setStatus(text);
      },
      (error: unknown) => {
        if (current) setStatusProblem(rpcErrorMessage(error));
      },
    );
  });
  const copy = () => {
    const text = status();
    if (text === undefined) return;
    void ctx.system
      .copy(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2_000);
      })
      .catch(() => {});
  };
  return (
    <>
      <Show when={problem() ?? statusProblem()}>
        {(message) => <p class="oq-error">{ctx.t("plugin.loadFailed", { message: message() })}</p>}
      </Show>
      <List heading={ctx.t("plugin.notices")}>
        <Show
          when={notices()}
          fallback={
            <p class="oq-notice">
              <ctx.ui.Loader />
            </p>
          }
        >
          {(list) => (
            <Show
              when={list().length > 0}
              fallback={<p class="oq-notice oq-muted">{ctx.t("plugin.noNotices")}</p>}
            >
              <For each={list()}>
                {(notice) => (
                  <p class="oq-notice">
                    {notice.message}
                    <Show when={notice.url}>
                      {(url) => (
                        <>
                          {" "}
                          <a
                            href={url()}
                            onClick={(event) => {
                              event.preventDefault();
                              ctx.system.openExternal(url());
                            }}
                          >
                            {url()}
                          </a>
                        </>
                      )}
                    </Show>
                  </p>
                )}
              </For>
            </Show>
          )}
        </Show>
      </List>
      <div class="oq-sgroup-part">
        <div class="oq-subhead-action">
          <h4 class="oq-subhead">{ctx.t("plugin.status")}</h4>
          <ctx.ui.Button size="small" disabled={status() === undefined} onClick={copy}>
            {copied() ? ctx.t("plugin.copied") : ctx.t("plugin.copy")}
          </ctx.ui.Button>
        </div>
        <Show when={status()} fallback={<p class="oq-note">{ctx.t("plugin.statusLoading")}</p>}>
          {(text) => <pre class="oq-status">{text()}</pre>}
        </Show>
      </div>
    </>
  );
}

/** The settings only settings.jsonc sets, with its default, and the file itself. */
function FileOnlyView(props: SectionProps) {
  const { ctx, draft } = props;
  const desktop = ctx.desktop;
  const valueText = (key: string) => {
    if (key === "providers.custom") {
      const count = draft.saved()?.custom.length ?? 0;
      return ctx.t(count === 1 ? "providers.defined.one" : "providers.defined.other", { count });
    }
    return ctx.t("file.default", { value: JSON.stringify(props.rules[key]?.default ?? null) });
  };
  return (
    <List>
      <For each={fileOnlyKeys(props.rules)}>
        {(key) => {
          const words = settingWords(ctx, key);
          return (
            <Row
              ctx={ctx}
              action={`${SETTINGS_PAGE_ID}.${key}`}
              title={words.title}
              description={words.description}
              settingKey={key}
            >
              <span class="oq-mono oq-small">{valueText(key)}</span>
            </Row>
          );
        }}
      </For>
      <div data-component="settings-row" class="oq-srow">
        <div data-slot="settings-row-copy">
          <div data-slot="settings-row-description">
            <span class="oq-key oq-path">{props.path}</span>
          </div>
        </div>
        <div data-slot="settings-row-control" class="oq-actions">
          {/* Open and Reveal only ever hand the app the quota settings file. */}
          <Show when={isSettingsFilePath(props.path) && desktop}>
            {(app) => (
              <>
                <ctx.ui.Button
                  icon="open-file"
                  onClick={() =>
                    void app()
                      .launch(props.path)
                      .catch(() => {})
                  }
                >
                  {ctx.t("file.open")}
                </ctx.ui.Button>
                <ctx.ui.Button
                  icon="folder"
                  onClick={() =>
                    void app()
                      .reveal(props.path)
                      .catch(() => {})
                  }
                >
                  {ctx.t("file.reveal")}
                </ctx.ui.Button>
              </>
            )}
          </Show>
          <ctx.ui.Button
            icon="copy"
            onClick={() => void ctx.system.copy(props.path).catch(() => {})}
          >
            {ctx.t("file.copyPath")}
          </ctx.ui.Button>
        </div>
      </div>
    </List>
  );
}

/** What OpenCode keeps: the Quota tab's open state, and the theme the colors follow. */
function OpenCodeView(props: SectionProps) {
  const { ctx } = props;
  return (
    <List>
      <Row
        ctx={ctx}
        action={`${SETTINGS_PAGE_ID}.opencode.panel`}
        title={ctx.t("opencode.panel")}
        description={ctx.t("opencode.panel.description")}
      >
        <ctx.ui.Switch
          label={ctx.t("opencode.panel")}
          hideLabel
          checked={props.panel.open()}
          onChange={(open) => props.panel.set(open)}
        />
      </Row>
      <Row
        ctx={ctx}
        action={`${SETTINGS_PAGE_ID}.opencode.theme`}
        title={ctx.t("opencode.theme")}
        description={ctx.t("opencode.theme.description")}
      >
        <ctx.ui.Button onClick={() => ctx.layout?.settings("general")}>
          {ctx.t("opencode.openSettings")}
        </ctx.ui.Button>
      </Row>
    </List>
  );
}
