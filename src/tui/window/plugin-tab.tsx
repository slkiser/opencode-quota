/** @jsxImportSource @opentui/solid */
/**
 * The quota window's Plugin tab: the maintainer notices, the switches for other tools (each
 * saves straight away), and the status report with Copy, each under its own title. Each show
 * asks the server again; an answer that arrives after a newer question is dropped.
 */
import type { JSX } from "@opentui/solid";
import { createSignal } from "solid-js";
import { sanitizeDisplayText } from "../../lib/display-sanitize.js";
import { QuotaRpc } from "../../rpc.js";
import { errorToast, quotaCallOptions, rpcErrorMessage } from "../client.js";
import { activateLine, type OptionLine, stepLine, stepSelection } from "./option-line.js";
import { OptionRow, type SettingsEditor } from "./settings.js";
import type { WindowHost } from "./shell.js";
import { type NoticeReport, NoticesView, type StatusReport, StatusView } from "./views.js";

type SystemSwitch = { key: string; group: string; title: string; note?: string };

/** Plugin's switches (`system`), under their group's title; each saves straight away. */
const SYSTEM_SWITCHES: ReadonlyArray<SystemSwitch> = [
  {
    key: "system.oldCommands",
    group: "tui.plugin.commands",
    title: "tui.plugin.oldCommands",
    note: "tui.plugin.oldCommands.note",
  },
  {
    key: "system.exportFile",
    group: "tui.plugin.otherTools",
    title: "tui.plugin.quotaFile",
    note: "tui.plugin.quotaFile.note",
  },
  {
    key: "system.telemetry",
    group: "tui.plugin.otherTools",
    title: "tui.plugin.telemetry",
  },
];

/** Copies `text` and says in a toast titled `title` whether the terminal let it. */
export type CopyWithToast = (
  text: string,
  title: string,
  messages: { copied: string; failed: string },
) => void;

export type PluginTab = ReturnType<typeof createPluginTab>;

export function createPluginTab(api: WindowHost, settings: SettingsEditor, copy: CopyWithToast) {
  const [selected, setSelected] = createSignal("");
  const [notices, setNotices] = createSignal<NoticeReport>({ state: "loading" });
  const [status, setStatus] = createSignal<StatusReport>({ state: "loading" });
  /** Numbers the notice and status requests; only the newest one's answer shows. */
  let noticeRequest = 0;
  let statusRequest = 0;
  /** Plugin switches whose save is not back yet; another flip of the same one is ignored. */
  const savingSwitches = new Set<string>();
  // The RPC client is made per call, so nothing reaches OpenCode during plugin setup.
  const rpc = () => api.client.rpc(QuotaRpc);
  const options = () => quotaCallOptions(api);

  async function loadNotices(): Promise<void> {
    const request = ++noticeRequest;
    setNotices({ state: "loading" });
    try {
      const board = await rpc().noticeList({}, options());
      if (request === noticeRequest) setNotices({ state: "ready", board });
    } catch (error) {
      if (request !== noticeRequest) return;
      setNotices({ state: "failed", message: sanitizeDisplayText(rpcErrorMessage(error)) });
    }
  }

  async function loadStatus(sessionID: string | undefined): Promise<void> {
    const request = ++statusRequest;
    setStatus({ state: "loading" });
    try {
      const output = await rpc().status(sessionID ? { sessionID } : {}, options());
      if (request === statusRequest) setStatus({ state: "ready", text: output.text });
    } catch (error) {
      if (request !== statusRequest) return;
      setStatus({ state: "failed", message: sanitizeDisplayText(rpcErrorMessage(error)) });
    }
  }

  async function flipSwitch(key: string, on: boolean): Promise<void> {
    if (savingSwitches.has(key)) return;
    savingSwitches.add(key);
    try {
      await settings.saveSwitch(key, on);
    } catch (error) {
      api.ui.toast.show(errorToast(error, api.t("tui.toast.title")));
    } finally {
      savingSwitches.delete(key);
    }
  }

  function copyReport(): void {
    const report = status();
    if (report.state !== "ready") return;
    copy(report.text, api.t("tui.plugin.statusReport"), {
      copied: api.t("tui.plugin.copied"),
      failed: api.t("tui.plugin.copyFailed"),
    });
  }

  /**
   * The lines that ↑↓ can select, under the notices: the switches (‹ on ›) once the saved
   * settings arrived, then Copy (▸) above the status report.
   */
  function lines(): OptionLine[] {
    const copyLine: OptionLine = {
      id: "copy",
      group: api.t("tui.plugin.copyGroup"),
      title: api.t("tui.plugin.copyReport"),
      value: () => api.t("tui.plugin.copy"),
      run: copyReport,
      note: () => api.t("tui.plugin.pasteIssue"),
    };
    const switches = SYSTEM_SWITCHES.flatMap(({ key, group, title, note }, index): OptionLine[] => {
      const on = settings.savedSwitch(key);
      if (on === undefined) return [];
      return [
        {
          id: key,
          ...(group !== SYSTEM_SWITCHES[index - 1]?.group ? { group: api.t(group) } : {}),
          title: api.t(title),
          value: () => api.t(on ? "tui.action.on" : "tui.action.off"),
          cycle: () => void flipSwitch(key, !on),
          ...(note ? { note: () => api.t(note) } : {}),
        },
      ];
    });
    const language = settings.savedValue("system.language");
    const languageLine: OptionLine[] =
      typeof language === "string"
        ? [
            {
              id: "system.language",
              group: api.t("tui.plugin.language"),
              title: api.t("tui.plugin.language"),
              value: () =>
                api.t(`option.system.language.${String(settings.savedValue("system.language"))}`),
              cycle: (delta) => {
                if (savingSwitches.has("system.language")) return;
                const choices = ["auto", "en", "zh-Hans"] as const;
                const current = choices.indexOf(language as (typeof choices)[number]);
                const next = choices[(current + delta + choices.length) % choices.length];
                if (!next) return;
                savingSwitches.add("system.language");
                void settings
                  .saveValue("system.language", next)
                  .catch((error: unknown) =>
                    api.ui.toast.show(errorToast(error, api.t("tui.toast.title"))),
                  )
                  .finally(() => savingSwitches.delete("system.language"));
              },
              note: () => api.t("tui.plugin.language.note"),
            },
          ]
        : [];
    return [...switches, ...languageLine, copyLine];
  }

  const selectedLine = () => lines().find((line) => line.id === selected());

  return {
    /**
     * The tab shows: the notices and the status report are asked again, and the saved settings
     * read, so the switches show even if a snapshot is late. Copy is selected, so enter copies.
     */
    show(sessionID: string | undefined): void {
      void loadNotices();
      void loadStatus(sessionID);
      settings.loadSaved().catch(() => {});
      setSelected("copy");
    },
    /** ↑↓: the next line; false past the first or last one, where the window scrolls. */
    select(delta: number): boolean {
      const ids = lines().map((line) => line.id);
      const next = stepSelection(ids.length, ids.indexOf(selected()), delta);
      if (next === undefined) return false;
      setSelected(ids[next] as string);
      return true;
    },
    /** Space or enter. */
    activate(): void {
      const line = selectedLine();
      if (line) activateLine(line);
    },
    /** ←/→. */
    step(delta: number): void {
      const line = selectedLine();
      if (line) stepLine(line, delta);
    },
    View(props: { width: number }): JSX.Element {
      return (
        <>
          <NoticesView
            theme={api.theme}
            report={notices()}
            title={api.t("tui.plugin.notices")}
            t={api.t}
          />
          {lines().map((line) => (
            <OptionRow
              line={line}
              theme={api.theme}
              active={selected() === line.id}
              click={settings.click}
              press={() => setSelected(line.id)}
              use={() => activateLine(line)}
              valueWidth={line.cycle ? 3 : 9}
              width={props.width}
            />
          ))}
          <StatusView
            theme={api.theme}
            report={status()}
            width={props.width}
            title={api.t("tui.plugin.setupCheck")}
            t={api.t}
          />
        </>
      );
    },
  };
}
