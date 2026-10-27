/** @jsxImportSource solid-js */
/**
 * OpenCode Quota's GUI part for OpenCode Desktop and Web: the package's `./gui-experimental`,
 * built into one CommonJS file by `.github/scripts/build-gui.mjs`. OpenCode's GUI plugin API is
 * experimental; OpenCode releases without it never load this file.
 *
 * It adds the window's CSS and one command, Quota, which opens the usage window (`window.tsx`)
 * for the folder and session on screen. Nothing asks the server before the window opens.
 */
import { Command, Plugin, Style } from "@opencode/plugin/gui";
import { createGuiQuota, type GuiQuotaHost } from "./bridge.js";
import { en } from "./i18n.js";
import { STYLE } from "./style.js";
import { UsageWindow } from "./window.js";

export default Plugin.define({
  i18n: { en },
  setup(ctx) {
    // The folder and session on screen, when that session runs on the app's own server.
    const onBuiltinServer = () => {
      const session = ctx.sessions.current();
      return session?.server.builtin ? session : undefined;
    };
    const directory = () => onBuiltinServer()?.directory;
    const sessionID = () => onBuiltinServer()?.id;
    const data = createGuiQuota({
      // OpenCode types RPC event data as any object; the quota RPC's schema checks the snapshot.
      client: () => ctx.client as unknown as ReturnType<GuiQuotaHost["client"]>,
      directory,
    });

    ctx.add(Style, STYLE);
    ctx.add(Command, () => ({
      id: "quota",
      title: ctx.t("command.quota"),
      description: ctx.t("command.quota.description"),
      keywords: "usage limits tokens cost",
      run: () => {
        ctx.dialogs.open(() => (
          <UsageWindow ctx={ctx} data={data} directory={directory} sessionID={sessionID} />
        ));
      },
    }));
  },
});
