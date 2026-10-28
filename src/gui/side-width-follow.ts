/**
 * Makes the Quota tab open Desktop's side panel narrow, and gives the width back to the other
 * tabs. While the Quota tab is the one the side panel shows, the panel is as narrow as it goes
 * (Quota's content is small); when another tab shows, the panel gets the width it had before
 * Quota showed. A hand-resize while a tab shows becomes that tab's remembered width: Quota's, or
 * the one every other tab shares. Both widths stay in plugin storage across restarts.
 *
 * The plugin API cannot set the width, so `side-width.ts` drags the divider through Desktop's
 * page (an unofficial trick); what to drag and what to remember is `side-width-model.ts`. Only
 * the tab that shows changes anything: a window resize, a session switch to a tab already
 * sized, or a side panel that is closed, on a narrow screen or on Home leaves the width to the
 * app. A window resize is not a hand-resize, so it remembers nothing; the app keeps the chat
 * panel's width and the side panel takes the rest, and Quota's width is put back the next time
 * Quota shows after another tab. If the trick fails anywhere, the app's own width stays.
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
import { dragSide, watchHandDrags, whenSideStill } from "./side-width.js";

type WidthsStore = Pick<Persisted<SideWidths>, "value" | "ready" | "set">;
type StoreSchema = Parameters<Context["storage"]["store"]>[1]["schema"];
/** The part of Effect the store's schema needs. */
type EffectModule = {
  Schema: { Struct(fields: Record<string, unknown>): StoreSchema; readonly Finite: unknown };
};

/**
 * The remembered widths in plugin storage, opened on first use. The store's schema comes from
 * Effect, which the app lends its plugins; without it, or without storage, they last until the
 * window reloads.
 */
function createSideWidths(ctx: Context) {
  const [store, setStore] = createSignal<WidthsStore>();
  let asked = false;
  return {
    load() {
      if (asked) return;
      asked = true;
      try {
        // The bundle's `require` is the app's, which lends Effect to its plugins (build-gui.mjs).
        const { Schema } = require("effect") as EffectModule;
        const schema = Schema.Struct({ quota: Schema.Finite, other: Schema.Finite });
        const stored = ctx.storage.store("side-width", {
          schema,
          initial: { ...SIDE_WIDTHS_INITIAL },
        });
        setStore(stored as Persisted<SideWidths>);
      } catch {
        const [value, setValue] = createSignal<SideWidths>({ ...SIDE_WIDTHS_INITIAL });
        setStore({
          get value() {
            return value();
          },
          ready: () => true,
          set: setValue,
        });
      }
    },
    ready: () => store()?.ready() ?? false,
    value: (): SideWidths => store()?.value ?? SIDE_WIDTHS_INITIAL,
    set: (next: SideWidths) => store()?.set(next),
  };
}

/** @param panelKey the Quota tab's key, `${ctx.id}:quota`. */
export function followSideWidth(ctx: Context, panelKey: string): void {
  const widths = createSideWidths(ctx);
  /** For each session (by key), the tab whose width its side panel holds, as far as this window knows. */
  const held = new Map<string, SideTab>();
  /** Stops the wait for the panel to sit still, which the next change or a hand-resize ends. */
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
      widths.load();
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
            const tab = panel.showsQuota ? "quota" : "other";
            held.set(session.key, tab);
            widths.set(remember(widths.value(), tab, panel.width));
          } catch (error) {
            fail(error);
          }
        },
      );

      const layout = ctx.layout;
      const session = ctx.sessions?.current();
      if (!layout || !session?.server.builtin || layout.narrow()) return;
      if (!layout.side.opened(session)) return;
      const shows: SideTab = layout.state(panelKey, session) === "visible" ? "quota" : "other";

      const stop = whenSideStill((panel) => {
        try {
          const before = widths.value();
          const current = Math.round(panel.width);
          const step = widthStep({ shows, held: held.get(session.key), current, widths: before });
          if (step.narrowerBy !== undefined && !dragSide(panel, step.narrowerBy)) return;
          held.set(session.key, shows);
          if (step.widths !== before) widths.set(step.widths);
        } catch (error) {
          fail(error);
        }
      }, shows === "quota");
      stopWaiting = stop;
      onCleanup(() => {
        stop();
        if (stopWaiting === stop) stopWaiting = undefined;
      });
    } catch (error) {
      fail(error);
    }
  });
  onCleanup(() => stopWatching?.());
}
