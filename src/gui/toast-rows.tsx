/** @jsxImportSource solid-js */
/**
 * A quota toast's rows as the open Quota panel draws them (`QuotaRows`), then the session's
 * tokens: an element, with the panel's surface colors (`.oq-surface`), that `toasts.ts` puts in
 * the app's toast. It is hidden from assistive tech, which reads the toast's own text.
 */
import type { Context } from "@opencode/plugin/gui";
import { createRoot, Show } from "solid-js";
import { QuotaRows } from "./panel.js";
import { type PanelView, roleCss, type RowSettings } from "./surfaces-model.js";

/** Pixels between providers in a toast. */
const PROVIDER_GAP = 6;

/** The rows' element (not yet in the page) and the cleanup that ends its Solid root. */
export type DrawnRows = { element: Element; dispose: () => void };

export function drawToastRows(ctx: Context, view: PanelView, settings: RowSettings): DrawnRows {
  return createRoot((dispose) => {
    const state = (group: { error?: string; unchecked: boolean }) =>
      group.error ?? (group.unchecked ? ctx.t("panel.notChecked") : undefined);
    const element = (
      <div class="oq-surface oq-toast-rows" data-mode={ctx.appearance.mode()} aria-hidden="true">
        <QuotaRows groups={view.groups} settings={settings} state={state} gap={PROVIDER_GAP} />
        <Show when={view.session}>
          {(session) => (
            <div class="oq-psession" style={{ "margin-top": `${PROVIDER_GAP}px` }}>
              <b style={{ color: roleCss(settings, "label") }}>{ctx.t("panel.session")}</b>{" "}
              <span style={{ color: roleCss(settings, "value") }}>{session()}</span>
            </div>
          )}
        </Show>
      </div>
    ) as Element;
    return { element, dispose };
  });
}
