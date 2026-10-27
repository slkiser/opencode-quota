/** @jsxImportSource solid-js */
/**
 * OpenCode Quota's GUI part for OpenCode Desktop and Web: the package's `./gui-experimental`,
 * built into one CommonJS file by `.github/scripts/build-gui.mjs`. OpenCode's GUI plugin API is
 * experimental; OpenCode releases without it never load this file.
 *
 * For now it adds one command, Quota, whose dialog lists the raw quota snapshot: each provider,
 * its rows, the percent left and the reset time.
 */
import { Command, Plugin } from "@opencode/plugin/gui";
import { For, onCleanup, Show } from "solid-js";
import type { QuotaRow } from "../core/types.js";
import { createGuiQuota, type GuiQuotaHost } from "./bridge.js";

function rowName(row: QuotaRow): string {
  return row.account ? `${row.label} (${row.account})` : row.label;
}

function percentText(row: QuotaRow): string {
  return row.percentRemaining === undefined ? "" : `${Math.round(row.percentRemaining)}%`;
}

export default Plugin.define({
  i18n: {
    en: {
      "command.quota": "Quota",
      "command.quota.description": "Quota limits from OpenCode Quota",
      "dialog.title": "Quota",
      "dialog.close": "Close",
      "dialog.loading": "Asking the server for quota…",
      "dialog.noProviders": "No provider is enabled and signed in.",
      "column.row": "Row",
      "column.percent": "Left",
      "column.reset": "Resets at",
    },
  },
  setup(ctx) {
    const data = createGuiQuota({
      // OpenCode types RPC event data as any object; the quota RPC's schema checks the snapshot.
      client: () => ctx.client as unknown as ReturnType<GuiQuotaHost["client"]>,
      directory: () => {
        const session = ctx.sessions.current();
        return session?.server.builtin ? session.directory : undefined;
      },
    });
    const stop = data.quota.start();

    const SnapshotDialog = (props: { close: () => void }) => {
      const ui = ctx.ui;
      onCleanup(data.quota.watch());
      return (
        <ui.Dialog
          title={ctx.t("dialog.title")}
          size="large"
          footer={
            <ui.Button variant="contrast" onClick={props.close}>
              {ctx.t("dialog.close")}
            </ui.Button>
          }
        >
          <Show when={data.quota.snapshot()} fallback={<p>{ctx.t("dialog.loading")}</p>}>
            {(snapshot) => (
              <For each={snapshot().providers} fallback={<p>{ctx.t("dialog.noProviders")}</p>}>
                {(provider) => (
                  <section>
                    <h3>{provider.label}</h3>
                    <Show when={provider.error}>{(error) => <p>{error().code}</p>}</Show>
                    <table>
                      <thead>
                        <tr>
                          <th>{ctx.t("column.row")}</th>
                          <th>{ctx.t("column.percent")}</th>
                          <th>{ctx.t("column.reset")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        <For each={provider.rows}>
                          {(row) => (
                            <tr>
                              <td>{rowName(row)}</td>
                              <td>{percentText(row)}</td>
                              <td>{row.resetsAt ?? ""}</td>
                            </tr>
                          )}
                        </For>
                      </tbody>
                    </table>
                  </section>
                )}
              </For>
            )}
          </Show>
        </ui.Dialog>
      );
    };

    ctx.add(Command, () => ({
      id: "quota",
      title: ctx.t("command.quota"),
      description: ctx.t("command.quota.description"),
      keywords: "usage limits tokens",
      run: () => {
        ctx.dialogs.open((dialog) => <SnapshotDialog close={dialog.close} />);
      },
    }));

    return stop;
  },
});
