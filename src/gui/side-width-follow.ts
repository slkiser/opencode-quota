/**
 * Makes the Quota tab open Desktop's side panel narrow, and gives the width back to the other
 * tabs. While the Quota tab is the only tab on screen in the side panel, the panel is as narrow
 * as the app allows (Quota's content is small), or the width the user last gave it; when another
 * tab shows, the panel gets the width it had before Quota showed. Quota in the panel's split
 * pane, next to another tab, or in the bottom pane counts as another tab: the app's tab state
 * says "visible" for all of those, so `side-width.ts` reads the page for where Quota is. A
 * hand-resize while a tab shows becomes that tab's remembered width: Quota's, or the one every
 * other tab shares. Both widths stay in plugin storage across restarts.
 *
 * The plugin API cannot set the width, so `side-width.ts` drags the divider through Desktop's
 * page (an unofficial trick); what to drag and what to remember is `side-width-model.ts`. The
 * check runs when the tab state, the side panel or the session changes, and, while Quota is
 * visible, when a tab moves between the panes (the state does not change then). Only that
 * changes anything: a window resize, a session switch to a tab already sized, or a side panel
 * that is closed, on a narrow screen or on Home leaves the width to the app. A window resize is
 * not a hand-resize, so it remembers nothing; the app keeps the chat panel's width and the side
 * panel takes the rest, and Quota's width is put back the next time Quota shows after another
 * tab. If the trick fails anywhere, the app's own width stays.
 */
import type { Context, Persisted } from "@opencode/plugin/gui";
import { createEffect, createSignal, onCleanup } from "solid-js";
import {
  remember,
  SIDE_WIDTHS_INITIAL,
  type SideTab,
  type SideWidths,
  widthStep,
} from "./side-width-model.js";
import {
  dragSide,
  type SidePanel,
  watchHandDrags,
  watchSideTabs,
  whenSideStill,
} from "./side-width.js";

type WidthsStore = Pick<Persisted<SideWidths>, "value" | "ready" | "set">;
type StoreSchema = Parameters<Context["storage"]["store"]>[1]["schema"];
/** The part of Effect the store's schema needs. */
type EffectModule = {
  Schema: { Struct(fields: Record<string, unknown>): StoreSchema; readonly Finite: unknown };
};

/**
 * The remembered widths in plugin storage. Opened at once: plugin storage belongs to the owner
 * that opens it, and an effect's owner is disposed on its next run. The store's schema comes
 * from Effect, which the app lends its plugins; without it, or without storage, they last until
 * the window reloads.
 */
function openSideWidths(ctx: Context): WidthsStore {
  try {
    // The bundle's `require` is the app's, which lends Effect to its plugins (build-gui.mjs).
    const { Schema } = require("effect") as EffectModule;
    const schema = Schema.Struct({ quota: Schema.Finite, other: Schema.Finite });
    return ctx.storage.store("side-width", {
      schema,
      initial: { ...SIDE_WIDTHS_INITIAL },
    }) as Persisted<SideWidths>;
  } catch {
    const [value, setValue] = createSignal<SideWidths>({ ...SIDE_WIDTHS_INITIAL });
    return {
      get value() {
        return value();
      },
      ready: () => true,
      set: setValue,
    };
  }
}

/** @param panelKey the Quota tab's key, `${ctx.id}:quota`. */
export function followSideWidth(ctx: Context, panelKey: string): void {
  const widths = openSideWidths(ctx);
  const remembered = (): SideWidths => widths.value ?? SIDE_WIDTHS_INITIAL;
  /** For each session (by key), the tab whose width its side panel holds, as far as this window knows. */
  const held = new Map<string, SideTab>();
  /** Stops the wait for the panel to sit still, which a hand-resize ends. */
  let stopWaiting: (() => void) | undefined;
  let stopWatching: (() => void) | undefined;
  let warned = false;
  const fail = (error: unknown) => {
    if (warned) return;
    warned = true;
    console.warn(`[opencode-quota] the side panel's width is left to OpenCode: ${String(error)}`);
  };

  createEffect(() => {
    try {
      if (!widths.ready()) return;
      stopWatching ??= watchHandDrags(
        () => {
          stopWaiting?.();
          stopWaiting = undefined;
        },
        (panel) => {
          try {
            const session = ctx.sessions?.current();
            if (!session?.server.builtin) return;
            const tab = panel.quotaAlone ? "quota" : "other";
            held.set(session.key, tab);
            widths.set(remember(remembered(), tab, panel.width));
          } catch (error) {
            fail(error);
          }
        },
      );

      const layout = ctx.layout;
      const session = ctx.sessions?.current();
      if (!layout || !session?.server.builtin || layout.narrow()) return;
      if (!layout.side.opened(session)) return;
      const quotaVisible = layout.state(panelKey, session) === "visible";

      let stopTabs = () => {};
      let watchedPanel: HTMLElement | undefined;
      const wait = () => {
        stopWaiting?.();
        stopWaiting = whenSideStill(settle);
      };
      const settle = (panel: SidePanel) => {
        try {
          // The state says "visible" for Quota in the bottom pane and the split pane too, and
          // does not change when a tab moves between the panes, so the panes are watched.
          if (quotaVisible && panel.element !== watchedPanel) {
            stopTabs();
            watchedPanel = panel.element;
            stopTabs = watchSideTabs(panel, wait);
          }
          const shows: SideTab = quotaVisible && panel.quotaAlone ? "quota" : "other";
          const before = remembered();
          const current = Math.round(panel.width);
          const step = widthStep({ shows, held: held.get(session.key), current, widths: before });
          if (step.narrowerBy !== undefined && !dragSide(panel, step.narrowerBy)) return;
          held.set(session.key, shows);
          if (step.widths !== before) widths.set(step.widths);
        } catch (error) {
          fail(error);
        }
      };
      wait();
      onCleanup(() => {
        stopWaiting?.();
        stopWaiting = undefined;
        stopTabs();
      });
    } catch (error) {
      fail(error);
    }
  });
  onCleanup(() => stopWatching?.());
}
