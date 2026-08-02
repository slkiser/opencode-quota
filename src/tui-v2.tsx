/** @jsxImportSource @opentui/solid */
import type { JSX } from "@opentui/solid";
import { RGBA } from "@opentui/core";
import { Show, createSignal, onCleanup } from "solid-js";

import { sanitizeDisplayText } from "./lib/display-sanitize.js";
import { formatQuotaRows } from "./lib/format.js";
import { collectQuotaRenderData } from "./lib/quota-render-data.js";
import {
  createQuotaRuntimeRequestContext,
  resolveQuotaRuntimeContext,
  type QuotaSessionModelContext,
} from "./lib/quota-runtime-context.js";
import { resolveQuotaFormatStyle } from "./lib/quota-format-style.js";
import { buildSidebarQuotaPanelLines } from "./lib/tui-sidebar-format.js";

const terminalForeground = RGBA.defaultForeground();

type TuiEvent = { data?: Record<string, unknown> };
type Toast = {
  variant?: "info" | "success" | "warning" | "error";
  title?: string;
  message: string;
  duration?: number;
};
type TuiContext = {
  client: unknown;
  data: { on: (event: string, handler: (event: TuiEvent) => void) => () => void };
  ui: {
    slot: {
      (name: "app", render: () => null): () => void;
      (name: "sidebar.content", render: (props: { sessionID: string }) => JSX.Element): () => void;
    };
    toast: { show: (toast: Toast) => void };
  };
};

function getSessionID(event: TuiEvent): string | undefined {
  const sessionID = event.data?.sessionID;
  return typeof sessionID === "string" && sessionID ? sessionID : undefined;
}

async function getSessionModelMeta(
  client: unknown,
  sessionID: string,
): Promise<QuotaSessionModelContext> {
  const session = (
    client as { session?: { get?: (input: { sessionID: string }) => Promise<{ data?: unknown }> } }
  ).session;
  const response = await session?.get?.({ sessionID });
  const model = (response?.data as { model?: { id?: string; providerID?: string } } | undefined)
    ?.model;
  return model ? { modelID: model.id, providerID: model.providerID } : {};
}

async function getQuotaMessage(
  context: TuiContext,
  sessionID: string,
  surface: "sidebar" | "idle" | "compacted" | "question",
): Promise<{ message: string; duration: number } | undefined> {
  const runtime = await resolveQuotaRuntimeContext({
    client: context.client as never,
    roots: { fallbackDirectory: process.cwd() },
    sessionID,
    resolveSessionMeta: (id) => getSessionModelMeta(context.client, id),
    includeSessionMeta: (config) => config.onlyCurrentModel,
  });
  const config = runtime.config;
  if (!config.enabled) return;
  if (surface === "sidebar") {
    if (!config.tuiSidebarPanel.enabled) return;
  } else if (!config.enableToast) {
    return;
  }
  if (
    (surface === "idle" && !config.showOnIdle) ||
    (surface === "compacted" && !config.showOnCompact) ||
    (surface === "question" && !config.showOnQuestion)
  ) {
    return;
  }

  const formatStyle = resolveQuotaFormatStyle(config.formatStyle);
  const result = await collectQuotaRenderData({
    client: runtime.client,
    resolveRuntimeProviderIds: runtime.resolveRuntimeProviderIds,
    config,
    configMeta: runtime.configMeta,
    request: createQuotaRuntimeRequestContext(runtime),
    surfaceExplicitProviderIssues: true,
    formatStyle,
    providers: runtime.providers,
  });
  const data = result.data;
  const message =
    surface === "sidebar"
      ? data
        ? buildSidebarQuotaPanelLines({
            data,
            config: {
              ...config,
              formatStyle: config.tuiSidebarPanel.formatStyle
                ? resolveQuotaFormatStyle(config.tuiSidebarPanel.formatStyle)
                : formatStyle,
            },
          }).join("\n")
        : undefined
      : data?.entries.length || data?.sessionTokens
        ? formatQuotaRows({
            version: "2.0.0",
            layout: config.layout,
            entries: data?.entries ?? [],
            errors: data?.errors ?? [],
            style: resolveQuotaFormatStyle(config.formatStyle),
            percentDisplayMode: config.percentDisplayMode,
            resetTimeDecimals: config.resetTimeDecimals,
            sessionTokens: data?.sessionTokens,
          })
        : config.showOnBothFail && data?.errors.length
          ? data.errors.map((error) => `${error.label}: ${error.message}`).join("\n")
          : undefined;
  return message
    ? { message: sanitizeDisplayText(message), duration: config.toastDurationMs }
    : undefined;
}

function reportFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[opencode-quota] failed to load quota: ${message}`);
}

function SidebarQuotaView(props: { context: TuiContext; sessionID: string }): JSX.Element {
  const [quota, setQuota] = createSignal<{ message: string; duration: number } | undefined>(
    undefined,
  );
  const refresh = () => {
    void getQuotaMessage(props.context, props.sessionID, "sidebar")
      .then((result) => setQuota(result))
      .catch(reportFailure);
  };
  refresh();
  const unsubscribe = props.context.data.on("session.step.ended", (event) => {
    if (getSessionID(event) === props.sessionID) refresh();
  });
  onCleanup(unsubscribe);

  return (
    <box flexDirection="column">
      <text fg={terminalForeground}>
        <b>Quota</b>
      </text>
      <Show when={quota()} fallback={<text fg={terminalForeground}>No quota data available</text>}>
        {(value: () => { message: string; duration: number }) =>
          value()
            .message.split("\n")
            .map((line) => (
              <text fg={terminalForeground} wrapMode="none">
                {line || " "}
              </text>
            ))
        }
      </Show>
    </box>
  );
}

const plugin = {
  id: "@slkiser/opencode-quota",
  setup(context: TuiContext) {
    let disposeEvents: (() => void) | undefined;
    const disposeApp = context.ui.slot("app", () => {
      if (disposeEvents) return null;
      const trigger = (event: TuiEvent, reason: "idle" | "compacted" | "question") => {
        const sessionID = getSessionID(event);
        if (!sessionID) return;
        void getQuotaMessage(context, sessionID, reason)
          .then((quota) => {
            if (!quota) return;
            context.ui.toast.show({
              variant: "info",
              title: "OpenCode Quota",
              message: quota.message,
              duration: quota.duration,
            });
          })
          .catch(reportFailure);
      };
      const onStepEnded = context.data.on("session.step.ended", (event) => trigger(event, "idle"));
      const onCompacted = context.data.on("session.compacted", (event) =>
        trigger(event, "compacted"),
      );
      const onQuestion = context.data.on("session.tool.success", (event) => {
        if (event.data?.tool === "question") trigger(event, "question");
      });
      disposeEvents = () => {
        onStepEnded();
        onCompacted();
        onQuestion();
      };
      return null;
    });
    const disposeSidebar = context.ui.slot("sidebar.content", (props) => (
      <SidebarQuotaView context={context} sessionID={props.sessionID} />
    ));
    return () => {
      disposeEvents?.();
      disposeApp();
      disposeSidebar();
    };
  },
};

export default plugin;
