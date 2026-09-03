/** @jsxImportSource @opentui/solid */

import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
  TuiPromptRef,
} from "@opencode-ai/plugin/tui";
import type { JSX } from "@opentui/solid";
import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import {
  formatDisplayedPercentLabel,
  formatResetCountdown,
  isResetTimeDecimals,
} from "./lib/format-utils.js";
import {
  buildQuotaDialogCommandOutput,
  QUOTA_DIALOG_COMMANDS,
  type QuotaDialogCommandId,
  type QuotaDialogCommandSpec,
} from "./lib/quota-dialog-commands.js";
import { extractSingleWindowWindowLabel } from "./lib/quota-entry-display.js";
import type { SessionTokenError } from "./lib/quota-status.js";
import { disposeQuotaTelemetryOwner } from "./lib/quota-telemetry.js";
import { getSidebarBodyLineColor } from "./lib/tui-line-style.js";
import type {
  CompactStatusState,
  HomeBottomState,
  PromptBarState,
  SidebarPanelState,
} from "./lib/tui-panel-state.js";
import {
  getCompactStatusText,
  getHomeBottomAnnouncementText,
  getSidebarPanelLines,
  getSidebarPanelLinesExpanded,
  shouldRenderCompactStatus,
  shouldRenderHomeBottom,
  shouldRenderSidebarPanel,
} from "./lib/tui-panel-state.js";
import { createTuiRefreshLifecycle } from "./lib/tui-refresh-lifecycle.js";
import {
  createTuiQuotaClient,
  getTuiRuntimeRootHints,
  getTuiSessionModelMeta,
  loadTuiHomeBottomStatus,
  loadTuiSessionQuotaSurfaces,
  normalizeTuiSessionID,
  resolveTuiSurfaceRegistration,
  type TuiInitialRuntimeSeed,
  type TuiSurfaceRegistration,
  writeTuiQuotaExportIfEnabled,
} from "./lib/tui-runtime.js";
import type { TuiCommandDisplay } from "./lib/types.js";

const id = "@slkiser/opencode-quota";
// Place Quota near the top so variable-height built-in sections
// (MCP/LSP/Todo/Files) do not push it below the visible fold.
const SIDEBAR_ORDER = 150;
const COMPACT_ORDER = 90;
const REFRESH_INTERVAL_MS = 60_000;
const EVENT_REFRESH_DELAYS_MS = [150, 600] as const;
const MOUNT_RECOVERY_DELAYS_MS = [500, 1_500, 4_000] as const;

type TuiPromptRefCallback = (ref: TuiPromptRef | undefined) => void;
type DialogSize = "medium" | "large" | "xlarge";

type QuotaDialogCommandState = {
  lastSessionTokenError?: SessionTokenError;
};
type SessionQuotaResource = {
  sessionID: string;
  sidebar: () => SidebarPanelState;
  compact: () => CompactStatusState;
  promptBar: () => PromptBarState;
  retain: () => SessionQuotaResource;
  release: () => void;
};

type HomeBottomResource = {
  bottom: () => HomeBottomState;
  retain: () => HomeBottomResource;
  release: () => void;
};

type TuiInitialLoadCoordinator = {
  takeInitialSession: () => TuiInitialRuntimeSeed | undefined;
  takeInitialHome: () => TuiInitialRuntimeSeed | undefined;
};

type TuiRegistrationState =
  | { status: "pending" }
  | {
      status: "active";
      registration: TuiSurfaceRegistration;
      initialLoads?: TuiInitialLoadCoordinator;
    }
  | { status: "disposed" };

type TuiRegistrationGate = {
  current: () => TuiRegistrationState;
  activate: (
    registration: TuiSurfaceRegistration,
    initialLoads?: TuiInitialLoadCoordinator,
  ) => void;
  dispose: () => void;
};

const FALLBACK_SURFACE_REGISTRATION: TuiSurfaceRegistration = {
  commandDisplay: "inline",
  sidebar: { enabled: true },
  compact: {
    enabled: false,
    homeBottom: false,
    sessionPrompt: false,
    hasNativeProviderQuota: false,
    suppressedByNativeProviderQuota: false,
  },
  promptBar: { enabled: false },
  announcements: { homeBottom: false },
  homeBottom: false,
};

function createTuiInitialLoadCoordinator(seed: TuiInitialRuntimeSeed): TuiInitialLoadCoordinator {
  let sessionAvailable = true;
  let homeAvailable = true;

  return {
    takeInitialSession() {
      if (!sessionAvailable) return undefined;
      sessionAvailable = false;
      return seed;
    },
    takeInitialHome() {
      if (!homeAvailable) return undefined;
      homeAvailable = false;
      return seed;
    },
  };
}

function createTuiRegistrationGate(): TuiRegistrationGate {
  const [current, setCurrent] = createSignal<TuiRegistrationState>({ status: "pending" });

  return {
    current,
    activate(registration, initialLoads) {
      if (current().status !== "pending") return;
      setCurrent({ status: "active", registration, initialLoads });
    },
    dispose() {
      if (current().status === "disposed") return;
      setCurrent({ status: "disposed" });
    },
  };
}

const sessionResources = new WeakMap<TuiPluginApi, Map<string, SessionQuotaResource>>();
const homeResources = new WeakMap<TuiPluginApi, HomeBottomResource>();

function getSessionResourceMap(api: TuiPluginApi): Map<string, SessionQuotaResource> {
  const existing = sessionResources.get(api);
  if (existing) return existing;

  const next = new Map<string, SessionQuotaResource>();
  sessionResources.set(api, next);
  return next;
}

function createSessionQuotaResource(
  api: TuiPluginApi,
  sessionID: string,
  initialLoads?: TuiInitialLoadCoordinator,
): SessionQuotaResource {
  const [sidebar, setSidebar] = createSignal<SidebarPanelState>({
    status: "loading",
    lines: [],
  });
  const [compact, setCompact] = createSignal<CompactStatusState>({ status: "loading" });
  const [promptBar, setPromptBar] = createSignal<PromptBarState>({ status: "loading" });

  let loadOrdinal = 0;
  const lifecycle = createTuiRefreshLifecycle({
    load: () => {
      const initialRuntimeSeed = loadOrdinal === 0 ? initialLoads?.takeInitialSession() : undefined;
      loadOrdinal += 1;
      return loadTuiSessionQuotaSurfaces({
        api,
        sessionID,
        ...(initialRuntimeSeed ? { initialRuntimeSeed } : {}),
      });
    },
    apply: (next) => {
      setSidebar(next.sidebar);
      setCompact(next.compact);
      setPromptBar(next.promptBar ?? { status: "loading" });
    },
    intervalMs: REFRESH_INTERVAL_MS,
    eventRefreshDelaysMs: EVENT_REFRESH_DELAYS_MS,
    // TUI/session state can hydrate asynchronously after mount or session switch,
    // so retry a few times to recover from empty first-load reads.
    recoveryDelaysMs: MOUNT_RECOVERY_DELAYS_MS,
    subscribe: (scheduleRefresh) => [
      api.event.on("session.updated", (event) => {
        if (event.properties?.info?.id === sessionID) {
          scheduleRefresh();
        }
      }),
      api.event.on("message.updated", (event) => {
        if (event.properties?.info?.sessionID === sessionID) {
          scheduleRefresh();
        }
      }),
      api.event.on("message.removed", (event) => {
        if (event.properties?.sessionID === sessionID) {
          scheduleRefresh();
        }
      }),
      api.event.on("tui.session.select", (event) => {
        if (event.properties?.sessionID === sessionID) {
          scheduleRefresh();
        }
      }),
    ],
    onDispose: () => {
      getSessionResourceMap(api).delete(sessionID);
    },
  });

  const resource: SessionQuotaResource = {
    sessionID,
    sidebar,
    compact,
    promptBar,
    retain: () => {
      lifecycle.retain();
      return resource;
    },
    release: lifecycle.release,
  };

  return resource;
}

function acquireSessionQuotaResource(
  api: TuiPluginApi,
  sessionID: string,
  initialLoads?: TuiInitialLoadCoordinator,
): SessionQuotaResource {
  const resources = getSessionResourceMap(api);
  const existing = resources.get(sessionID);
  if (existing) return existing.retain();

  const next = createSessionQuotaResource(api, sessionID, initialLoads).retain();
  resources.set(sessionID, next);
  return next;
}

function createHomeBottomResource(
  api: TuiPluginApi,
  compactHomeBottomEnabled: boolean,
  initialLoads?: TuiInitialLoadCoordinator,
): HomeBottomResource {
  const [bottom, setBottom] = createSignal<HomeBottomState>({
    status: "loading",
    compact: compactHomeBottomEnabled ? { status: "loading" } : { status: "disabled" },
  });

  let loadOrdinal = 0;
  const lifecycle = createTuiRefreshLifecycle({
    load: () => {
      const initialRuntimeSeed = loadOrdinal === 0 ? initialLoads?.takeInitialHome() : undefined;
      loadOrdinal += 1;
      return loadTuiHomeBottomStatus({
        api,
        ...(initialRuntimeSeed ? { initialRuntimeSeed } : {}),
      });
    },
    apply: setBottom,
    afterApply: () => {
      // Fire-and-forget: write export file if enabled. A failed write must
      // never affect TUI rendering, so log a warning and continue.
      void writeTuiQuotaExportIfEnabled({ api }).catch((err) => {
        console.warn(`[opencode-quota] quota export write failed: ${String(err)}`);
      });
    },
    intervalMs: REFRESH_INTERVAL_MS,
    eventRefreshDelaysMs: EVENT_REFRESH_DELAYS_MS,
    subscribe: (scheduleRefresh) => [
      api.event.on("session.updated", scheduleRefresh),
      api.event.on("message.updated", scheduleRefresh),
      api.event.on("message.removed", scheduleRefresh),
      api.event.on("tui.session.select", scheduleRefresh),
    ],
    onDispose: () => {
      homeResources.delete(api);
    },
  });

  const resource: HomeBottomResource = {
    bottom,
    retain: () => {
      lifecycle.retain();
      return resource;
    },
    release: lifecycle.release,
  };

  return resource;
}

function acquireHomeBottomResource(
  api: TuiPluginApi,
  compactHomeBottomEnabled: boolean,
  initialLoads?: TuiInitialLoadCoordinator,
): HomeBottomResource {
  const existing = homeResources.get(api);
  if (existing) return existing.retain();

  const next = createHomeBottomResource(api, compactHomeBottomEnabled, initialLoads).retain();
  homeResources.set(api, next);
  return next;
}

function useSessionQuotaResource(
  api: TuiPluginApi,
  sessionID: () => string,
  initialLoads?: TuiInitialLoadCoordinator,
): () => SessionQuotaResource {
  let current = acquireSessionQuotaResource(api, sessionID(), initialLoads);
  const [resource, setResource] = createSignal(current);

  createEffect(() => {
    const nextSessionID = sessionID();
    if (current.sessionID === nextSessionID) return;

    const previous = current;
    current = acquireSessionQuotaResource(api, nextSessionID, initialLoads);
    setResource(current);
    previous.release();
  });

  onCleanup(() => {
    current.release();
  });

  return resource;
}

function SidebarContentView(props: {
  api: TuiPluginApi;
  sessionID: string;
  initialLoads?: TuiInitialLoadCoordinator;
}) {
  const resource = useSessionQuotaResource(props.api, () => props.sessionID, props.initialLoads);
  const panel = () => resource().sidebar();

  const lines = () => getSidebarPanelLines(panel());
  const hasDetailLines = () => Boolean(panel().linesExpanded?.length);

  const [collapsed, setCollapsed] = createSignal(
    props.api.kv?.get("quota-sidebar-collapsed", true) ?? true,
  );

  const toggleCollapsed = () => {
    if (!hasDetailLines()) return;

    const next = !collapsed();
    setCollapsed(next);
    props.api.kv?.set("quota-sidebar-collapsed", next);
  };

  const displayLines = () => {
    if (!hasDetailLines()) return lines();
    return collapsed() ? lines() : getSidebarPanelLinesExpanded(panel());
  };

  const toggleIcon = () => (collapsed() ? "▶" : "▼");
  const providerCount = () => panel().providerCount ?? 0;
  const headerText = () => {
    const base = hasDetailLines() ? `${toggleIcon()} Quota` : "Quota";
    const mode = panel().headerPercentMode;
    return mode ? `${base} [${mode === "used" ? "Used" : "Remaining"}]` : base;
  };

  return (
    <Show when={shouldRenderSidebarPanel(panel())}>
      <box gap={0}>
        <box flexDirection="row">
          <text fg={props.api.theme.current.text} onMouseDown={toggleCollapsed}>
            <b>{headerText()}</b>
          </text>
          <Show when={collapsed() && providerCount() > 0}>
            <text fg={props.api.theme.current.textMuted}> ({providerCount()} providers)</text>
          </Show>
        </box>
        <box gap={0}>
          {displayLines().map((line) => (
            <text fg={getSidebarBodyLineColor(line, props.api.theme.current)} wrapMode="none">
              {line || " "}
            </text>
          ))}
        </box>
      </box>
    </Show>
  );
}

function CompactStatusLine(props: {
  api: TuiPluginApi;
  panel: () => CompactStatusState;
  justifyContent: "flex-start" | "center" | "flex-end";
  blankLineBefore?: boolean;
}) {
  const text = () => {
    const panel = props.panel();
    if (!shouldRenderCompactStatus(panel)) return "";
    return getCompactStatusText(panel);
  };

  const line = () => (
    <box flexDirection="row" justifyContent={props.justifyContent}>
      <text fg={props.api.theme.current.textMuted} wrapMode="none">
        {text()}
      </text>
    </box>
  );

  return (
    <Show when={text()}>
      <Show when={props.blankLineBefore} fallback={line()}>
        <box gap={0}>
          <text> </text>
          {line()}
        </box>
      </Show>
    </Show>
  );
}

function SessionPromptWithCompactStatus(props: {
  api: TuiPluginApi;
  sessionID: string;
  initialLoads?: TuiInitialLoadCoordinator;
  visible?: boolean;
  disabled?: boolean;
  onSubmit?: () => void;
  promptRef?: TuiPromptRefCallback;
}) {
  const resource = useSessionQuotaResource(props.api, () => props.sessionID, props.initialLoads);
  const panel = () => resource().compact();

  return (
    <box gap={0}>
      <props.api.ui.Prompt
        sessionID={props.sessionID}
        visible={props.visible}
        disabled={props.disabled}
        onSubmit={props.onSubmit}
        ref={props.promptRef}
      />
      <CompactStatusLine api={props.api} panel={panel} justifyContent="flex-end" />
    </box>
  );
}

const PROMPT_BAR_WIDTH = 12;

function shouldRenderPromptBar(
  bar: PromptBarState,
): bar is Extract<PromptBarState, { status: "ready" }> {
  return bar.status === "ready" && Boolean(bar.entry);
}

function useSessionRunning(api: TuiPluginApi, sessionID: () => string): () => boolean {
  const [running, setRunning] = createSignal(false);
  createEffect(() => {
    const id = sessionID();
    if (!id) {
      setRunning(false);
      return;
    }
    const update = () => {
      try {
        const sessionState = api.state.session as {
          status?: (sessionID: string) => { type?: string } | undefined;
        };
        const status = sessionState.status?.(id);
        setRunning(status?.type === "busy" || status?.type === "retry");
      } catch {
        setRunning(false);
      }
    };
    update();
    const disposers = [
      api.event.on("session.status", (event) => {
        if (event.properties?.sessionID === id) {
          update();
        }
      }),
      api.event.on("session.updated", (event) => {
        if (event.properties?.info?.id === id) {
          update();
        }
      }),
    ];
    onCleanup(() => {
      for (const dispose of disposers) {
        if (typeof dispose === "function") {
          dispose();
        }
      }
    });
  });
  return running;
}

function buildPromptBarParts(params: {
  bar: () => PromptBarState;
  running: () => boolean;
  phase: () => number;
}): { label: string; barText: string; meta: string } | undefined {
  const bar = params.bar();
  if (!shouldRenderPromptBar(bar)) return undefined;
  const entry = bar.entry;
  if (!entry) return undefined;
  const reset = entry.resetTimeIso
    ? formatResetCountdown(
        entry.resetTimeIso,
        isResetTimeDecimals(bar.resetTimeDecimals)
          ? { compactRounded: true, decimals: bar.resetTimeDecimals }
          : { spaced: bar.resetTimeSpaced },
      )
    : "";

  const hasPercent = Number.isFinite(entry.percentRemaining);
  if (entry.semanticSegment && !hasPercent) {
    return { label: entry.semanticSegment, barText: "", meta: reset };
  }

  const windowLabel =
    entry.semanticSegment ??
    extractSingleWindowWindowLabel(entry.label ?? "") ??
    extractSingleWindowWindowLabel(entry.name ?? "") ??
    "Quota";
  const percent = formatDisplayedPercentLabel(
    entry.percentRemaining ?? 0,
    bar.percentDisplayMode ?? "remaining",
    "bare",
  );
  const p = Math.max(0, Math.min(100, Math.round(entry.percentRemaining ?? 0)));
  const filled = Math.round((p / 100) * PROMPT_BAR_WIDTH);
  const empty = PROMPT_BAR_WIDTH - filled;
  let barText = "█".repeat(filled) + "░".repeat(empty);
  if (params.running() && filled > 0) {
    const cells = Array(filled).fill("▓");
    const center = params.phase() % filled;
    const gradient = ["▒", "▓", "█", "▓", "▒"];
    for (let offset = -2; offset <= 2; offset++) {
      const position = (center + offset + filled) % filled;
      cells[position] = gradient[offset + 2];
    }
    barText = cells.join("") + "░".repeat(empty);
  }
  return {
    label: windowLabel,
    barText,
    meta: entry.semanticSegment ? reset : [percent, reset].filter(Boolean).join(" | "),
  };
}

function PromptQuotaHint(props: {
  api: TuiPluginApi;
  bar: () => PromptBarState;
  running: () => boolean;
  phase: () => number;
}) {
  const parts = () => buildPromptBarParts(props);
  const barColor = () => props.api.theme.current.textMuted;
  const label = () => parts()?.label ?? "";
  const bar = () => parts()?.barText ?? "";
  const meta = () => parts()?.meta ?? "";

  return (
    <Show when={parts()}>
      <box flexDirection="row" justifyContent="flex-end" gap={1}>
        <text fg={props.api.theme.current.textMuted} wrapMode="none">
          {label()}
        </text>
        <text fg={barColor()} wrapMode="none">
          {bar()}
        </text>
        <text fg={props.api.theme.current.textMuted} wrapMode="none">
          {meta()}
        </text>
      </box>
    </Show>
  );
}

function SessionQuotaPromptBar(props: {
  api: TuiPluginApi;
  sessionID: string;
  initialLoads?: TuiInitialLoadCoordinator;
  visible?: boolean;
  disabled?: boolean;
  onSubmit?: () => void;
  promptRef?: TuiPromptRefCallback;
}) {
  const resource = useSessionQuotaResource(props.api, () => props.sessionID, props.initialLoads);
  const promptBar = () => resource().promptBar();
  const running = useSessionRunning(props.api, () => props.sessionID);
  const [phase, setPhase] = createSignal(0);
  createEffect(() => {
    if (!running() || !shouldRenderPromptBar(promptBar())) {
      setPhase(0);
      return;
    }
    const interval = setInterval(() => setPhase((p) => p + 1), 160);
    onCleanup(() => clearInterval(interval));
  });

  return (
    <box gap={0}>
      <props.api.ui.Prompt
        sessionID={props.sessionID}
        visible={props.visible}
        disabled={props.disabled}
        onSubmit={props.onSubmit}
        ref={props.promptRef}
      />
      <PromptQuotaHint api={props.api} bar={promptBar} running={running} phase={phase} />
    </box>
  );
}

function HomeBottomView(props: {
  api: TuiPluginApi;
  compactHomeBottomEnabled: boolean;
  initialLoads?: TuiInitialLoadCoordinator;
}) {
  const resource = acquireHomeBottomResource(
    props.api,
    props.compactHomeBottomEnabled,
    props.initialLoads,
  );
  onCleanup(() => resource.release());

  const announcement = () => getHomeBottomAnnouncementText(resource.bottom());
  const compact = () => resource.bottom().compact;
  const visible = () => shouldRenderHomeBottom(resource.bottom());

  return (
    <box gap={0}>
      <Show when={visible()}>
        <text> </text>
      </Show>
      <Show when={visible() && announcement()}>
        <box flexDirection="row" justifyContent="center">
          <text fg={props.api.theme.current.textMuted} wrapMode="none">
            {announcement()}
          </text>
        </box>
      </Show>
      <Show when={visible()}>
        <CompactStatusLine api={props.api} panel={compact} justifyContent="center" />
      </Show>
    </box>
  );
}

function getActiveTuiSessionID(api: TuiPluginApi): string | undefined {
  if (api.route.current.name !== "session") return undefined;
  return normalizeTuiSessionID(api.route.current.params?.sessionID);
}

function getTuiCommandArguments(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  for (const key of ["arguments", "args", "query"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function CommandLoadingDialog(props: { api: TuiPluginApi; title: string }) {
  return (
    <box gap={1} paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <text fg={props.api.theme.current.text}>
        <b>{props.title}</b>
      </text>
      <text fg={props.api.theme.current.textMuted}>Loading deterministic local output…</text>
    </box>
  );
}

function CommandOutputDialog(props: { api: TuiPluginApi; title: string; output: string }) {
  const lines = () => props.output.split("\n");
  const bodyHeight = () => Math.min(28, Math.max(6, lines().length));
  return (
    <box gap={1} width="100%" flexGrow={1} paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <text fg={props.api.theme.current.text}>
        <b>{props.title}</b>
      </text>
      <scrollbox width="100%" flexGrow={1} minHeight={bodyHeight()} maxHeight={28}>
        <box gap={0} width="100%" minWidth={0}>
          {lines().map((line) => (
            <text fg={props.api.theme.current.text} wrapMode="word" width="100%">
              {line || " "}
            </text>
          ))}
        </box>
      </scrollbox>
      <text fg={props.api.theme.current.textMuted}>esc closes</text>
    </box>
  );
}

function CommandErrorDialog(props: { api: TuiPluginApi; title: string; error: unknown }) {
  const message = props.error instanceof Error ? props.error.message : String(props.error);
  return (
    <box gap={1} paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <text fg={props.api.theme.current.text}>
        <b>{props.title}</b>
      </text>
      <text fg={props.api.theme.current.text}>OpenCode Quota command failed.</text>
      <text fg={props.api.theme.current.textMuted} wrapMode="none">
        {message || "Unknown error"}
      </text>
      <text fg={props.api.theme.current.textMuted}>esc closes</text>
    </box>
  );
}

function getCommandPromptCopy(spec: QuotaDialogCommandSpec): {
  title: string;
  placeholder: string;
  description: string;
} {
  switch (spec.id) {
    case "tokens_between":
      return {
        title: "OpenCode Quota Token Range",
        placeholder: "YYYY-MM-DD YYYY-MM-DD",
        description: "Enter start and end dates, for example: 2026-01-01 2026-01-15",
      };
    case "quota_status":
      return {
        title: "OpenCode Quota Status Options",
        placeholder: 'Optional JSON, e.g. {"refreshGoogleTokens":true}',
        description: "Leave blank for normal diagnostics, or enter one JSON options object.",
      };
    default:
      return {
        title: spec.title,
        placeholder: "Optional arguments",
        description: "Leave blank to run with no arguments.",
      };
  }
}

function replaceDialog(api: TuiPluginApi, size: DialogSize, render: () => JSX.Element): void {
  api.ui.dialog.replace(render);
  // OpenCode dialog.replace() resets size to medium.
  api.ui.dialog.setSize(size);
}

async function runQuotaDialogCommandAsync(
  api: TuiPluginApi,
  command: QuotaDialogCommandId,
  commandDisplay: TuiCommandDisplay,
  rawInput?: unknown,
  state?: QuotaDialogCommandState,
): Promise<void> {
  const spec = QUOTA_DIALOG_COMMANDS.find((item) => item.id === command)!;
  const argumentsText = getTuiCommandArguments(rawInput);
  const sessionID = getActiveTuiSessionID(api);

  if (spec.acceptsArguments && rawInput === undefined) {
    const prompt = getCommandPromptCopy(spec);
    replaceDialog(api, "medium", () => (
      <api.ui.DialogPrompt
        title={prompt.title}
        placeholder={prompt.placeholder}
        description={() => (
          <text fg={api.theme.current.textMuted} wrapMode="word">
            {prompt.description}
          </text>
        )}
        onCancel={() => api.ui.dialog.clear()}
        onConfirm={(value) => {
          void runQuotaDialogCommandAsync(
            api,
            command,
            commandDisplay,
            { arguments: value.trim() },
            state,
          );
        }}
      />
    ));
    return;
  }

  const destination =
    commandDisplay === "inline" && sessionID
      ? { type: "inline" as const, sessionID }
      : { type: "dialog" as const };
  if (destination.type === "dialog") {
    replaceDialog(api, spec.dialogSize, () => (
      <CommandLoadingDialog api={api} title={spec.title} />
    ));
  }

  try {
    const result = await buildQuotaDialogCommandOutput({
      command,
      arguments: argumentsText,
      client: createTuiQuotaClient(api),
      roots: getTuiRuntimeRootHints(api),
      sessionID,
      resolveSessionMeta: (id) => getTuiSessionModelMeta(api, id),
      lastSessionTokenError: state?.lastSessionTokenError,
      setLastSessionTokenError: state
        ? (error) => {
            state.lastSessionTokenError = error;
          }
        : undefined,
      log: async (message, extra) => {
        await api.client.app.log({
          body: {
            service: "quota-toast",
            level: "debug",
            message,
            extra,
          },
        });
      },
    });

    if (result.state === "noop") {
      if (destination.type === "dialog") api.ui.dialog.clear();
      return;
    }

    if (destination.type === "inline") {
      await api.client.session.prompt({
        sessionID: destination.sessionID,
        noReply: true,
        parts: [{ type: "text", text: result.output, ignored: true }],
      });
      return;
    }

    replaceDialog(api, result.dialogSize, () => (
      <CommandOutputDialog api={api} title={result.title} output={result.output} />
    ));
  } catch (error) {
    replaceDialog(api, "large", () => (
      <CommandErrorDialog api={api} title={spec.title} error={error} />
    ));
    api.ui.toast({
      variant: "error",
      message: "OpenCode Quota command failed",
    });
  }
}

function registerQuotaDialogCommands(api: TuiPluginApi, gate: TuiRegistrationGate): void {
  const commandState: QuotaDialogCommandState = {};
  const dispose = api.keymap.registerLayer({
    commands: QUOTA_DIALOG_COMMANDS.map((spec) => ({
      namespace: "palette",
      name: `opencode-quota.${spec.id}`,
      title: spec.title,
      desc: spec.description,
      category: "OpenCode Quota",
      slashName: spec.slashName,
      run(input?: unknown) {
        const state = gate.current();
        if (state.status !== "active") return;
        void runQuotaDialogCommandAsync(
          api,
          spec.id,
          state.registration.commandDisplay,
          input,
          commandState,
        );
      },
    })),
    bindings: [],
  });

  api.lifecycle.onDispose(dispose);
}

function registerStableTuiSlots(api: TuiPluginApi, current: () => TuiRegistrationState): void {
  api.slots.register({
    order: SIDEBAR_ORDER,
    slots: {
      sidebar_content(_ctx, props: { session_id: string }) {
        const state = current();
        if (state.status !== "active" || !state.registration.sidebar.enabled) return null;
        return (
          <SidebarContentView
            api={api}
            sessionID={props.session_id}
            initialLoads={state.initialLoads}
          />
        );
      },
    },
  });

  api.slots.register({
    order: COMPACT_ORDER,
    slots: {
      session_prompt(
        _ctx,
        props: {
          session_id: string;
          visible?: boolean;
          disabled?: boolean;
          on_submit?: () => void;
          ref?: TuiPromptRefCallback;
        },
      ) {
        const state = current();
        if (state.status !== "active") return null;
        if (state.registration.promptBar.enabled) {
          return (
            <SessionQuotaPromptBar
              api={api}
              sessionID={props.session_id}
              initialLoads={state.initialLoads}
              visible={props.visible}
              disabled={props.disabled}
              onSubmit={props.on_submit}
              promptRef={props.ref}
            />
          );
        }
        if (!state.registration.compact.sessionPrompt) return null;
        return (
          <SessionPromptWithCompactStatus
            api={api}
            sessionID={props.session_id}
            initialLoads={state.initialLoads}
            visible={props.visible}
            disabled={props.disabled}
            onSubmit={props.on_submit}
            promptRef={props.ref}
          />
        );
      },
      home_bottom() {
        const state = current();
        if (state.status !== "active" || !state.registration.homeBottom) return null;
        return (
          <HomeBottomView
            api={api}
            compactHomeBottomEnabled={state.registration.compact.homeBottom}
            initialLoads={state.initialLoads}
          />
        );
      },
    },
  });
}

async function initializeTuiRegistration(
  api: TuiPluginApi,
  gate: TuiRegistrationGate,
): Promise<void> {
  let initialRuntimeSeed: TuiInitialRuntimeSeed | undefined;
  let surfaceRegistration: Promise<{
    registration: TuiSurfaceRegistration;
    initialRuntimeSeed?: TuiInitialRuntimeSeed;
  }>;
  try {
    surfaceRegistration = resolveTuiSurfaceRegistration(api, {
      captureInitialRuntime(seed) {
        initialRuntimeSeed = seed;
      },
    })
      .then((registration) => ({ registration, initialRuntimeSeed }))
      .catch(() => ({ registration: FALLBACK_SURFACE_REGISTRATION }));
  } catch {
    surfaceRegistration = Promise.resolve({ registration: FALLBACK_SURFACE_REGISTRATION });
  }

  registerQuotaDialogCommands(api, gate);
  void surfaceRegistration.then(({ registration, initialRuntimeSeed }) =>
    gate.activate(
      registration,
      initialRuntimeSeed ? createTuiInitialLoadCoordinator(initialRuntimeSeed) : undefined,
    ),
  );
  registerStableTuiSlots(api, gate.current);
}

const tui: TuiPlugin = async (api) => {
  const registrationGate = createTuiRegistrationGate();
  api.lifecycle.onDispose(() => {
    registrationGate.dispose();
    disposeQuotaTelemetryOwner(createTuiQuotaClient(api));
  });

  void initializeTuiRegistration(api, registrationGate).catch(() => {});
};

const pluginModule: TuiPluginModule & { id: string } = {
  id,
  tui,
};

export default pluginModule;
