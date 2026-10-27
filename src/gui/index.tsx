/** @jsxImportSource solid-js */
/**
 * OpenCode Quota's GUI part for OpenCode Desktop and Web: the package's `./gui-experimental`,
 * built into one CommonJS file by `.github/scripts/build-gui.mjs`. OpenCode's GUI plugin API is
 * experimental; OpenCode releases without it never load this file.
 *
 * It adds the window's CSS, the Quota command, which opens the usage window (`window.tsx`) for
 * the folder and session on screen, and the always-on surfaces, each following the settings of
 * its TUI counterpart (`surfaces-model.ts`):
 * - a Quota tab in the session's side region (the sidebar panel), pinned in every session's
 *   strip while the sidebar shows, and listed in its + menu; plugin storage remembers whether
 *   it is open or folded;
 * - a titlebar pill (the collapsed sidebar), a pill above the composer (the current model's
 *   limit) and the session menu's "Quota usage for this session", which open the usage window;
 * - a strip at the bottom of the window (the status line);
 * - the quota toasts (`toasts.ts`).
 * A surface whose registry this OpenCode lacks is left out; the others still show.
 *
 * While the window runs, it keeps the quota of the folder and session on screen loaded, as the
 * TUI does, and a Quota tab keeps its own session's loaded.
 */
import {
  Command,
  ComposerPill,
  type Context,
  MenuItem,
  type MountedSession,
  Panel,
  type PanelTab,
  type Persisted,
  Plugin,
  type Registry,
  Slot,
  Style,
  TitlebarItem,
} from "@opencode/plugin/gui";
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import { createGuiQuota, type GuiQuotaHost } from "./bridge.js";
import { en } from "./i18n.js";
import { QuotaPanel } from "./panel.js";
import { StatusStrip } from "./status-strip.js";
import { STYLE } from "./style.js";
import { surfaceSettings } from "./surface-settings.js";
import {
  currentModelPick,
  levelTone,
  pickedGroups,
  pickedText,
  statusStripShows,
} from "./surfaces-model.js";
import { createGuiToasts, type GuiToasts } from "./toasts.js";
import { UsageWindow } from "./window.js";

const PANEL_ID = "quota";
/** The titlebar pill names this many providers, then "+N". */
const TITLEBAR_PROVIDERS = 2;
const CLOCK_MS = 60_000;

/** The Quota tab: open or folded. */
type PanelState = { open: boolean };
const PANEL_INITIAL: PanelState = { open: true };
type PanelStore = Pick<Persisted<PanelState>, "value" | "update">;
type StoreSchema = Parameters<Context["storage"]["store"]>[1]["schema"];
/** The part of Effect the store's schema needs. */
type EffectModule = {
  Schema: { Struct(fields: Record<string, unknown>): StoreSchema; readonly Boolean: unknown };
};

/** Adds an item to a registry this OpenCode may not have; a missing one leaves it out. */
function addSafely<T>(
  ctx: Context,
  registry: Registry<T> | undefined,
  item: T | (() => T | undefined),
): void {
  if (!registry) return;
  try {
    ctx.add(registry, item as () => T | undefined);
  } catch (error) {
    console.warn(`[opencode-quota] OpenCode did not take a GUI item: ${String(error)}`);
  }
}

/**
 * The Quota tab's state in plugin storage, opened on first use. The store's schema comes from
 * Effect, which the app lends its plugins; without it, or without storage, the state lasts until
 * the window reloads.
 */
function createPanelState(ctx: Context) {
  const [store, setStore] = createSignal<PanelStore>();
  let asked = false;
  const memoryStore = () => {
    try {
      const [value, update] = ctx.storage.memory("sidebar", { initial: { ...PANEL_INITIAL } });
      setStore({ value, update: (mutate) => update((draft) => void mutate(draft)) });
    } catch {
      const [value, setValue] = createSignal({ ...PANEL_INITIAL });
      setStore({
        get value() {
          return value();
        },
        update(mutate) {
          const next = { ...value() };
          mutate(next);
          setValue(next);
        },
      });
    }
  };
  const load = () => {
    if (asked) return;
    asked = true;
    try {
      // The bundle's `require` is the app's, which lends Effect to its plugins (build-gui.mjs).
      const { Schema } = require("effect") as EffectModule;
      const schema = Schema.Struct({ open: Schema.Boolean });
      const stored = ctx.storage.store("sidebar", { schema, initial: { ...PANEL_INITIAL } });
      setStore(stored as Persisted<PanelState>);
    } catch {
      memoryStore();
    }
  };
  return {
    load,
    open: () => store()?.value?.open ?? PANEL_INITIAL.open,
    set(change: Partial<PanelState>) {
      store()?.update((draft) => {
        Object.assign(draft, change);
      });
    },
  };
}

export default Plugin.define({
  i18n: { en },
  setup(ctx) {
    // The folder and session a quota call names: a session's on the app's own server, else none.
    const directoryOf = (session: MountedSession | undefined) =>
      session?.server.builtin ? session.directory : undefined;
    const sessionIDOf = (session: MountedSession | undefined) =>
      session?.server.builtin ? session.id : undefined;
    const directory = () => directoryOf(ctx.sessions.current());
    const sessionID = () => sessionIDOf(ctx.sessions.current());
    let toasts: GuiToasts | undefined;
    const data = createGuiQuota({
      // OpenCode types RPC event data as any object; the quota RPC's schema checks the snapshot.
      client: () => ctx.client as unknown as ReturnType<GuiQuotaHost["client"]>,
      directory,
      onSnapshot: (snapshot) => toasts?.receive(snapshot),
    });
    toasts = createGuiToasts(ctx, data);
    createEffect(() => {
      onCleanup(data.watch(directory(), sessionID()));
    });

    const [nowMs, setNowMs] = createSignal(Date.now());
    const clock = setInterval(() => setNowMs(Date.now()), CLOCK_MS);
    onCleanup(() => clearInterval(clock));

    const snapshotOf = (session: MountedSession | undefined) =>
      data.snapshot(directoryOf(session), sessionIDOf(session));
    const current = () => data.snapshot(directory(), sessionID());
    const currentSettings = createMemo(() => surfaceSettings(current()));
    const unchecked = () => ctx.t("panel.notChecked");

    /** The usage window for the folder and session on screen, or on Cost for `scoped`. */
    const openWindow = (scoped?: MountedSession) => {
      ctx.dialogs.open(() =>
        scoped ? (
          <UsageWindow
            ctx={ctx}
            data={data}
            directory={() => directoryOf(scoped)}
            sessionID={() => sessionIDOf(scoped)}
            view="cost"
            scope="session"
          />
        ) : (
          <UsageWindow ctx={ctx} data={data} directory={directory} sessionID={sessionID} />
        ),
      );
    };

    ctx.add(Style, STYLE);
    ctx.add(Command, () => ({
      id: "quota",
      title: ctx.t("command.quota"),
      description: ctx.t("command.quota.description"),
      keywords: "usage limits tokens cost",
      run: () => openWindow(),
    }));

    // The Quota tab, as the sidebar panel: pinned in each session's strip, as the TUI's sidebar
    // shows in each session.
    const panelKey = `${ctx.id}:${PANEL_ID}`;
    const panelState = createPanelState(ctx);
    let tab: PanelTab | undefined;
    const panelTab = () => {
      const title = ctx.t("panel.tab");
      if (tab?.title !== title) tab = { id: PANEL_ID, title, pinned: true };
      return tab;
    };
    addSafely(ctx, Panel, {
      id: PANEL_ID,
      region: "side",
      // Only the app's own server runs this plugin's server part, so other servers get no tab.
      list: (input) =>
        input.session.server.builtin && surfaceSettings(snapshotOf(input.session)).sidebar.show
          ? [panelTab()]
          : [],
      render: (props) => {
        createEffect(() => {
          onCleanup(data.watch(directoryOf(props.session), sessionIDOf(props.session)));
        });
        panelState.load();
        return (
          <QuotaPanel
            ctx={ctx}
            snapshot={() => snapshotOf(props.session)}
            settings={() => surfaceSettings(snapshotOf(props.session))}
            open={panelState.open}
            setOpen={(open) => panelState.set({ open })}
          />
        );
      },
    });
    addSafely(ctx, MenuItem, () => {
      if (!currentSettings().sidebar.show) return undefined;
      const session = ctx.sessions.current();
      const state = session && ctx.layout?.state(panelKey, session);
      const opened = state !== undefined && state !== "closed";
      return {
        menu: "session.panel" as const,
        id: PANEL_ID,
        title: ctx.t("panel.tab"),
        icon: "status" as const,
        ...(opened ? { opened: true } : {}),
        run: () => {
          const shown = ctx.sessions.current();
          if (shown) ctx.layout.open(panelKey, shown);
        },
      };
    });
    // The titlebar pill, as the collapsed sidebar.
    addSafely(ctx, TitlebarItem, () => {
      const shown = current();
      const settings = currentSettings();
      if (!shown || !settings.collapsed.show) return undefined;
      const groups = pickedGroups(shown, settings, "collapsed", nowMs());
      if (groups.length === 0) return undefined;
      const text = groups
        .slice(0, TITLEBAR_PROVIDERS)
        .map((group) => pickedText(group, unchecked()))
        .join(" · ");
      const more = groups.length - TITLEBAR_PROVIDERS;
      const label = more > 0 ? ctx.t("titlebar.more", { text, count: more }) : text;
      return {
        id: "quota",
        label,
        title: ctx.t("titlebar.title", { text: label }),
        icon: "status" as const,
        run: () => openWindow(),
      };
    });

    // The composer pill: the current model's limit, as the status line's "one" detail.
    addSafely(ctx, ComposerPill, {
      id: "quota",
      show(input) {
        const shown = snapshotOf(input.session);
        if (!shown) return undefined;
        const settings = surfaceSettings(shown);
        if (!settings.statusLine.show) return undefined;
        const pick = currentModelPick(shown, settings, nowMs());
        if (!pick?.row) return undefined;
        const tone = levelTone(pick.row.level);
        return {
          label: pickedText(pick, unchecked(), true),
          icon: "status" as const,
          ...(tone ? { tone } : {}),
          title: ctx.t("composer.title"),
          run: () => openWindow(),
        };
      },
    });

    // The bottom strip, as the status line.
    addSafely(ctx, Slot, {
      at: "window.bottom",
      render: () => {
        const shows = () => {
          const session = ctx.sessions.current();
          const panelOnScreen =
            session !== undefined && ctx.layout?.state(panelKey, session) === "visible";
          return (
            current() !== undefined &&
            statusStripShows(currentSettings(), { home: session === undefined, panelOnScreen })
          );
        };
        return (
          <Show when={shows()}>
            <StatusStrip
              ctx={ctx}
              snapshot={current}
              settings={currentSettings}
              openWindow={() => openWindow()}
            />
          </Show>
        );
      },
    });

    // The session menu's item: the usage window on Cost, for that session.
    addSafely(ctx, Slot, {
      at: "session.location.menu",
      render: (input) => (
        <ctx.ui.Button variant="ghost" onClick={() => openWindow(input.session)}>
          {ctx.t("menu.sessionUsage")}
        </ctx.ui.Button>
      ),
    });
  },
});
