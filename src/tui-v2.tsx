/** @jsxImportSource @opentui/solid */

import { RGBA } from "@opentui/core";
import type { JSX } from "@opentui/solid";
import { createSignal, onCleanup, Show } from "solid-js";

import { sanitizeDisplayText } from "./lib/display-sanitize.js";
import { formatQuotaRows } from "./lib/format.js";
import {
  buildQuotaDialogCommandOutput,
  QUOTA_DIALOG_COMMANDS,
  type QuotaDialogCommandId,
} from "./lib/quota-dialog-commands.js";
import { resolveQuotaFormatStyle } from "./lib/quota-format-style.js";
import { collectQuotaRenderData } from "./lib/quota-render-data.js";
import {
  createQuotaRuntimeRequestContext,
  type QuotaSessionModelContext,
  resolveQuotaRuntimeContext,
} from "./lib/quota-runtime-context.js";
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
  keymap: {
    layer: (
      build: () => {
        mode: "global";
        commands: Array<{
          id: string;
          title: string;
          group: string;
          palette: true;
          slash: { name: string };
          run: (input?: unknown) => void;
        }>;
      },
    ) => void;
  };
  ui: {
    slot: (
      claim:
        | { append: "app"; render: () => null }
        | { append: "sidebar.content"; render: (props: { sessionID: string }) => JSX.Element },
    ) => () => void;
    toast: { show: (toast: Toast) => void };
    dialog: {
      alert: (params: { title: string; message: string }) => Promise<unknown>;
      prompt: (params: { title: string; placeholder?: string }) => Promise<string | undefined>;
      set: (params: { size: "medium" | "large" | "xlarge" }) => void;
    };
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
): Promise<{ message: string; duration: number; activeProviderCount: number } | undefined> {
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
    ? {
        message: sanitizeDisplayText(message),
        duration: config.toastDurationMs,
        activeProviderCount: result.active.length,
      }
    : undefined;
}

function reportFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[opencode-quota] failed to load quota: ${message}`);
}

function getCommandArguments(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  for (const key of ["arguments", "args", "query"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

async function runQuotaCommand(
  context: TuiContext,
  command: QuotaDialogCommandId,
  sessionID: string | undefined,
  input?: unknown,
): Promise<void> {
  const spec = QUOTA_DIALOG_COMMANDS.find((item) => item.id === command)!;
  let argumentsText = getCommandArguments(input);
  if (spec.acceptsArguments && argumentsText === undefined) {
    const value = await context.ui.dialog.prompt({
      title: spec.title,
      placeholder: command === "tokens_between" ? "YYYY-MM-DD YYYY-MM-DD" : "Optional arguments",
    });
    if (value === undefined) return;
    argumentsText = value.trim() || undefined;
  }

  try {
    const result = await buildQuotaDialogCommandOutput({
      command,
      arguments: argumentsText,
      client: context.client as never,
      roots: { fallbackDirectory: process.cwd() },
      sessionID,
      resolveSessionMeta: (id) => getSessionModelMeta(context.client, id),
    });
    if (result.state === "noop") return;
    const alert = context.ui.dialog.alert({ title: result.title, message: result.output });
    context.ui.dialog.set({ size: result.dialogSize });
    await alert;
  } catch (error) {
    context.ui.toast.show({
      variant: "error",
      title: "OpenCode Quota",
      message: sanitizeDisplayText(error instanceof Error ? error.message : String(error)),
    });
  }
}

function registerQuotaCommands(context: TuiContext, getSessionID: () => string | undefined): void {
  context.keymap.layer(() => ({
    mode: "global",
    commands: QUOTA_DIALOG_COMMANDS.map((spec) => ({
      id: `quota.${spec.id}`,
      title: spec.title,
      group: "OpenCode Quota",
      palette: true,
      slash: { name: spec.slashName },
      run: (input?: unknown) => void runQuotaCommand(context, spec.id, getSessionID(), input),
    })),
  }));
}

function SidebarQuotaView(props: {
  context: TuiContext;
  sessionID: string;
  setActiveSessionID: (sessionID: string) => void;
}): JSX.Element {
  props.setActiveSessionID(props.sessionID);
  const [open, setOpen] = createSignal(true);
  const [quota, setQuota] = createSignal<
    { message: string; duration: number; activeProviderCount: number } | undefined
  >(undefined);
  const lines = () => quota()?.message.split("\n") ?? [];
  const expandable = () => lines().length > 2;
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
      <box
        flexDirection="row"
        gap={1}
        onMouseDown={() => expandable() && setOpen((value) => !value)}
      >
        <Show when={expandable()}>
          <text fg={terminalForeground}>{open() ? "▼" : "▶"}</text>
        </Show>
        <text fg={terminalForeground}>
          <b>Quota</b>
          <Show when={expandable() && !open() && quota()?.activeProviderCount}>
            {(count: () => number) => ` (${count()} active)`}
          </Show>
        </text>
      </box>
      <Show when={quota()} fallback={<text fg={terminalForeground}>No quota data available</text>}>
        <Show when={!expandable() || open()}>
          {lines().map((line) => (
            <text fg={terminalForeground} wrapMode="none">
              {line || " "}
            </text>
          ))}
        </Show>
      </Show>
    </box>
  );
}

const plugin = {
  id: "@slkiser/opencode-quota",
  setup(context: TuiContext) {
    let disposeEvents: (() => void) | undefined;
    let activeSessionID: string | undefined;
    const questionToolCalls = new Set<string>();
    const disposeApp = context.ui.slot({
      append: "app",
      render: () => {
        if (disposeEvents) return null;
        registerQuotaCommands(context, () => activeSessionID);
        const trigger = (event: TuiEvent, reason: "idle" | "compacted" | "question") => {
          const sessionID = getSessionID(event);
          if (!sessionID) return;
          activeSessionID = sessionID;
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
        const onStepEnded = context.data.on("session.step.ended", (event) =>
          trigger(event, "idle"),
        );
        const onCompacted = context.data.on("session.compaction.ended", (event) =>
          trigger(event, "compacted"),
        );
        const onQuestionStarted = context.data.on("session.tool.input.started", (event) => {
          const id = event.data?.id;
          if (event.data?.name === "question" && typeof id === "string") {
            questionToolCalls.add(id);
          }
        });
        const onQuestionSucceeded = context.data.on("session.tool.success", (event) => {
          const id = event.data?.id;
          if (typeof id === "string" && questionToolCalls.delete(id)) trigger(event, "question");
        });
        const onQuestionFailed = context.data.on("session.tool.failed", (event) => {
          const id = event.data?.id;
          if (typeof id === "string") questionToolCalls.delete(id);
        });
        disposeEvents = () => {
          onStepEnded();
          onCompacted();
          onQuestionStarted();
          onQuestionSucceeded();
          onQuestionFailed();
          questionToolCalls.clear();
        };
        return null;
      },
    });
    const disposeSidebar = context.ui.slot({
      append: "sidebar.content",
      render: (props) => (
        <SidebarQuotaView
          context={context}
          sessionID={props.sessionID}
          setActiveSessionID={(sessionID) => {
            activeSessionID = sessionID;
          }}
        />
      ),
    });
    return () => {
      disposeEvents?.();
      disposeApp();
      disposeSidebar();
    };
  },
};

export default plugin;
