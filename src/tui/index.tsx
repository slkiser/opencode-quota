/** @jsxImportSource @opentui/solid */
/**
 * OpenCode Quota's TUI plugin. It draws the server's quota snapshot: the Quota panel in the
 * session sidebar, the status line under the message box (and on Home when turned on), the
 * toasts, and the quota window that `/quota`, `/quota_usage`, `/quota_status` and
 * `/quota_settings` open above the message box (`window/`).
 * It reads all settings through the quota RPC; plugin storage keeps only the sidebar state.
 *
 * The quota slash commands typed in the prompt run in the TUI: on Enter, before OpenCode submits
 * the prompt, a prompt that starts with /quota, /quota_usage, /quota_status or /quota_settings is
 * cleared and runs its TUI action with the rest of the prompt as its arguments. So no report
 * shows in the chat, and on Home no session is created for one. The "/" list names each once:
 * the server lists /quota, /quota_usage and /quota_status, the TUI /quota_settings.
 * The 4.x and 5.x names run here too: each /tokens_* opens the Usage tab on its range while
 * `system.oldCommands` is on (the server lists them then), and names its /quota_usage range while
 * it is off (an open TUI's "/" list keeps them until OpenCode restarts).
 */
import { Plugin } from "@opencode/plugin/tui";
import type { JSX } from "@opentui/solid";
import { getOwner, type Owner, onCleanup, Show } from "solid-js";
import { OLD_USAGE_COMMANDS, parseUsageArguments, type UsageRange } from "../core/usage-ranges.js";
import { QuotaRpc } from "../rpc.js";
import { type ClientHost, createQuotaClient, quotaCallOptions, reportFailure } from "./client.js";
import { createFileDisplay } from "./display.js";
import { createServerSettings } from "./server-settings.js";
import { SidebarPanel, type SurfaceHost } from "./sidebar.js";
import { HomeFooter, StatusLine } from "./status-line.js";
import type { Theme } from "./theme.js";
import { createToastShow } from "./toast-colors.js";
import { createToasts, TOAST_TITLE, type TurnEnd } from "./toasts.js";
import { createSettingsEditor } from "./window/settings.js";
import { createQuotaWindow, type WindowHost } from "./window/shell.js";

type SidebarState = { open: boolean };
type TuiEvent = { data?: Record<string, unknown> };

/** What the plugin needs from OpenCode's TUI context, besides the window's needs. */
type TuiContext = WindowHost &
  ClientHost & {
    theme: Theme & WindowHost["theme"];
    storage: {
      store<Value extends object>(
        key: string,
        options: { readonly initial: Value },
      ): readonly [Value, (mutation: (draft: Value) => void) => Promise<void>];
    };
    data: WindowHost["data"] & {
      on: (event: string, handler: (event: TuiEvent) => void) => () => void;
      session: { get: (sessionID: string) => { parentID?: string } | undefined };
    };
    ui: WindowHost["ui"] & {
      slot: (
        claim:
          | { append: "app"; render: () => null }
          | { append: "sidebar.content"; render: (props: { sessionID: string }) => JSX.Element }
          | { append: "prompt.footer"; render: (props: { sessionID?: string }) => JSX.Element }
          | { append: "home.footer.status"; render: () => JSX.Element }
          | {
              append: "session.composer.top";
              render: (props: { sessionID: string }) => JSX.Element;
            },
      ) => () => void;
    };
  };

function eventSessionID(event: TuiEvent): string | undefined {
  const sessionID = event.data?.sessionID;
  return typeof sessionID === "string" && sessionID ? sessionID : undefined;
}

function eventToolCallID(event: TuiEvent): string | undefined {
  const id = event.data?.id;
  return typeof id === "string" ? id : undefined;
}

const plugin = Plugin.define({
  // OpenCode names this plugin's storage files after its id (`plugin.<id>.<key>.json`), so the
  // id may hold only letters, digits, ".", "_" and "-".
  id: "slkiser.opencode-quota",
  setup(context) {
    const api = context as unknown as TuiContext;
    // Plugin storage is first read when a surface draws, never during setup.
    const server = createServerSettings({
      settings: () => api.client.rpc(QuotaRpc).settings({}, quotaCallOptions(api)),
      saveSettings: (input) => api.client.rpc(QuotaRpc).saveSettings(input, quotaCallOptions(api)),
    });
    const display = createFileDisplay(server);
    let sidebarStore: ReturnType<TuiContext["storage"]["store"]> | undefined;
    const sidebarState = () => {
      sidebarStore ??= api.storage.store<SidebarState>("sidebar", { initial: { open: true } });
      return sidebarStore as readonly [
        SidebarState,
        (mutation: (draft: SidebarState) => void) => Promise<void>,
      ];
    };

    const isChildSession = (sessionID: string) =>
      Boolean(api.data.session.get(sessionID)?.parentID);
    let conversionShown = false;
    const quota = createQuotaClient(api, (snapshot) => {
      const current = quota.snapshot()?.settings;
      if (current) server.receive(current);
      toasts.showResetNotices(settings.withDraftWords(snapshot) ?? snapshot);
      if (snapshot.settingsConverted && !conversionShown) {
        conversionShown = true;
        api.ui.toast.show({
          variant: "info",
          title: TOAST_TITLE,
          message: "Your 4.x or 5.x settings are now in settings.jsonc, details in /quota_status",
          duration: 15_000,
        });
      }
    });
    /** The app slot's Solid owner while it is mounted: colored toasts are made under it. */
    let appOwner: Owner | undefined;
    const showToast = createToastShow({
      show: (toast) => api.ui.toast.show(toast),
      theme: () => api.theme,
      display: display.shown,
      owner: () => appOwner,
    });
    const settings = createSettingsEditor(api, display, showToast);
    const draftQuota = {
      ...quota,
      snapshot: (sessionID?: string) => settings.withDraftWords(quota.snapshot(sessionID)),
      refresh: async (reason: Parameters<typeof quota.refresh>[0], sessionID?: string) =>
        settings.withDraftWords(await quota.refresh(reason, sessionID)),
    };
    const toasts = createToasts({
      show: showToast,
      display: display.shown,
      terminalWidth: () => api.renderer.width,
      quota: draftQuota,
      isChildSession,
    });
    const host: SurfaceHost = {
      theme: () => api.theme,
      display: display.shown,
      // While All places has unsaved words, every surface shows them.
      quota: draftQuota,
      editing: settings,
    };
    const quotaWindow = createQuotaWindow(api, host, settings);
    /** `/quota_usage [range]`: the Usage tab, on the typed range or Today; a wrong range says why. */
    const openUsage = (argumentsText: string) => {
      const parsed = parseUsageArguments(argumentsText);
      if (parsed.ok) quotaWindow.openUsage(parsed);
      else api.ui.toast.show({ variant: "warning", title: TOAST_TITLE, message: parsed.error });
    };
    /** A 4.x or 5.x `/tokens_*` command: `/quota_usage` on its range, or a hint while off. */
    const oldUsage = (range: UsageRange, argumentsText: string) => {
      if (server.value("system.oldCommands") === true) {
        openUsage(`${range} ${argumentsText}`.trim());
        return;
      }
      const now = range === "between" ? "between YYYY-MM-DD YYYY-MM-DD" : range;
      api.ui.toast.show({
        variant: "info",
        title: TOAST_TITLE,
        message: `Use /quota_usage ${now}. The old /tokens_* names turn on in /quota_status.`,
      });
    };
    /** The quota slash commands, by name, with what follows the name. */
    const quotaCommands: Record<string, (argumentsText: string) => void> = {
      quota: () => quotaWindow.open("limits"),
      quota_usage: openUsage,
      quota_status: () => quotaWindow.open("system"),
      quota_settings: () => quotaWindow.open("settings"),
      ...Object.fromEntries(
        Object.entries(OLD_USAGE_COMMANDS).map(([name, range]) => [
          name,
          (argumentsText: string) => oldUsage(range, argumentsText),
        ]),
      ),
    };

    let disposeMount: (() => void) | undefined;
    const questionToolCalls = new Set<string>();
    const disposeApp = api.ui.slot({
      append: "app",
      render: () => {
        // OpenCode mounts this slot again when it reconnects to its server, which can also
        // happen right after it starts. Leaving a mount drops its keymap layers and event
        // listeners, so each mount stops the last one's and registers everything again.
        disposeMount?.();
        const owner = getOwner() ?? undefined;
        appOwner = owner;
        const stopQuota = quota.start();
        // Load settings on Home too, including switches for otherwise hidden surfaces.
        queueMicrotask(() => {
          try {
            quota.watch()();
          } catch (error) {
            reportFailure(error);
          }
        });
        api.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "quota.limits",
              title: "Quota limits",
              group: "OpenCode Quota",
              palette: true,
              run: () => quotaWindow.open("limits"),
            },
            {
              id: "quota.usage",
              title: "Quota usage: tokens and API cost",
              group: "OpenCode Quota",
              palette: true,
              run: () => quotaWindow.open("usage"),
            },
            {
              id: "quota.status",
              title: "Quota status report",
              group: "OpenCode Quota",
              palette: true,
              run: () => quotaWindow.open("system"),
            },
            {
              id: "quota.settings",
              title: "Quota: settings",
              group: "OpenCode Quota",
              palette: true,
              // The server lists /quota, /quota_usage and /quota_status; this one is TUI-only.
              slash: { name: "quota_settings" },
              run: () => quotaWindow.open("settings"),
            },
          ],
        }));
        // The typed quota commands. Above OpenCode's textarea layer, which submits the prompt on
        // Enter; without a mode, so it is off while the "/" list or a dialog is open.
        api.keymap.layer(() => ({
          priority: 1,
          commands: [
            {
              bind: "return",
              // Synchronous on purpose: a returned promise counts as handled.
              run: () => {
                const editor = api.renderer.currentFocusedEditor;
                const trimmed = editor?.plainText.trim() ?? "";
                if (!editor || !trimmed.startsWith("/")) return false;
                // As in OpenCode, the command name ends at the first whitespace.
                const name = trimmed.slice(1).split(/\s/, 1)[0] ?? "";
                if (!Object.hasOwn(quotaCommands, name)) return false;
                editor.clear();
                quotaCommands[name](trimmed.slice(1 + name.length).trim());
              },
            },
          ],
        }));
        const afterTurn = (event: TuiEvent, trigger: TurnEnd) => {
          const sessionID = eventSessionID(event);
          if (sessionID) void toasts.afterTurn(trigger, sessionID).catch(reportFailure);
        };
        const listeners = [
          api.data.on("session.execution.succeeded", (event) => afterTurn(event, "reply")),
          api.data.on("session.compaction.ended", (event) => afterTurn(event, "compaction")),
          // Each step can use quota; the server skips a refresh that is not due yet.
          api.data.on("session.step.ended", (event) => {
            const sessionID = eventSessionID(event);
            if (sessionID && !isChildSession(sessionID)) void quota.refresh("turn", sessionID);
          }),
          api.data.on("session.tool.input.started", (event) => {
            const id = eventToolCallID(event);
            if (event.data?.name === "question" && id) questionToolCalls.add(id);
          }),
          api.data.on("session.tool.success", (event) => {
            const id = eventToolCallID(event);
            if (id && questionToolCalls.delete(id)) afterTurn(event, "question");
          }),
          api.data.on("session.tool.failed", (event) => {
            const id = eventToolCallID(event);
            if (id) questionToolCalls.delete(id);
          }),
        ];
        let disposed = false;
        const dispose = () => {
          if (disposed) return;
          disposed = true;
          if (disposeMount === dispose) disposeMount = undefined;
          if (appOwner === owner) appOwner = undefined;
          stopQuota();
          toasts.cancel();
          for (const stop of listeners) stop();
          questionToolCalls.clear();
        };
        disposeMount = dispose;
        onCleanup(dispose);
        return null;
      },
    });
    const disposeSidebar = api.ui.slot({
      append: "sidebar.content",
      render: (props) => {
        const [state, update] = sidebarState();
        return (
          <SidebarPanel
            host={host}
            sessionID={props.sessionID}
            open={() => state.open}
            setOpen={(open) => {
              void update((draft) => {
                draft.open = open;
              }).catch(reportFailure);
            }}
          />
        );
      },
    });
    const disposePrompt = api.ui.slot({
      append: "prompt.footer",
      // Home has a message box too; Home's status line sits in its own footer instead.
      render: (props) => (
        <Show when={props.sessionID && settings.statusLineShown()}>
          <StatusLine host={host} sessionID={props.sessionID} />
        </Show>
      ),
    });
    const disposeHome = api.ui.slot({
      append: "home.footer.status",
      render: () => <HomeFooter host={host} />,
    });
    const disposeWindow = api.ui.slot({
      append: "session.composer.top",
      render: (props) => <quotaWindow.Slot sessionID={props.sessionID} />,
    });
    return () => {
      disposeMount?.();
      disposeApp();
      disposeSidebar();
      disposePrompt();
      disposeHome();
      disposeWindow();
    };
  },
});

export default plugin;
