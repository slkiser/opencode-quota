/** @jsxImportSource @opentui/solid */
import type { JSX } from "@opentui/solid";
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
  TuiPromptRef,
} from "@opencode-ai/plugin/tui";
import { Show, createEffect, createSignal, onCleanup } from "solid-js";

import type { SessionTokenError } from "./lib/quota-status.js";
import type { CompactStatusState, HomeBottomState, SidebarPanelState } from "./lib/tui-panel-state.js";

import {
  getCompactStatusText,
  getHomeBottomAnnouncementText,
  getSidebarPanelLines,
  getSidebarPanelLinesExpanded,
  shouldRenderCompactStatus,
  shouldRenderHomeBottom,
  shouldRenderSidebarPanel,
} from "./lib/tui-panel-state.js";
import { getSidebarBodyLineColor } from "./lib/tui-line-style.js";
import {
  createTuiQuotaClient,
  getTuiRuntimeRootHints,
  getTuiSessionModelMeta,
  loadTuiHomeBottomStatus,
  normalizeTuiSessionID,
  loadTuiSessionQuotaSurfaces,
  resolveTuiSurfaceRegistration,
  writeTuiQuotaExportIfEnabled,
} from "./lib/tui-runtime.js";
import {
  QUOTA_DIALOG_COMMANDS,
  buildQuotaDialogCommandOutput,
  type QuotaDialogCommandId,
} from "./lib/quota-dialog-commands.js";

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
  retain: () => SessionQuotaResource;
  release: () => void;
};

type HomeBottomResource = {
  bottom: () => HomeBottomState;
  retain: () => HomeBottomResource;
  release: () => void;
};

const sessionResources = new WeakMap<TuiPluginApi, Map<string, SessionQuotaResource>>();
const homeResources = new WeakMap<TuiPluginApi, HomeBottomResource>();

function getSessionResourceMap(api: TuiPluginApi): Map<string, SessionQuotaResource> {
  const existing = sessionResources.get(api);
  if (existing) return existing;

  const next = new Map<string, SessionQuotaResource>();
  sessionResources.set(api, next);
  return next;
}

function createSessionQuotaResource(api: TuiPluginApi, sessionID: string): SessionQuotaResource {
  const [sidebar, setSidebar] = createSignal<SidebarPanelState>({
    status: "loading",
    lines: [],
  });
  const [compact, setCompact] = createSignal<CompactStatusState>({ status: "loading" });

  let refCount = 0;
  let disposed = false;
  let loadVersion = 0;
  let inFlight = false;
  let queued = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const reload = () => {
    if (disposed) return;

    if (inFlight) {
      queued = true;
      loadVersion += 1;
      return;
    }

    inFlight = true;
    const currentVersion = ++loadVersion;

    void loadTuiSessionQuotaSurfaces({ api, sessionID })
      .then((next) => {
        if (disposed || currentVersion !== loadVersion) return;
        setSidebar(next.sidebar);
        setCompact(next.compact);
      })
      .catch(() => {
        if (disposed || currentVersion !== loadVersion) return;
      })
      .finally(() => {
        if (disposed) return;
        inFlight = false;
        if (queued) {
          queued = false;
          reload();
        }
      });
  };

  const queueRefresh = (delay: number) => {
    if (disposed) return;

    const timer = setTimeout(() => {
      timers.delete(timer);
      reload();
    }, delay);
    timers.add(timer);
  };

  const scheduleRefresh = () => {
    for (const delay of EVENT_REFRESH_DELAYS_MS) queueRefresh(delay);
  };

  // TUI/session state can hydrate asynchronously after mount or session switch,
  // so retry a few times to recover from empty first-load reads.
  const scheduleMountRecovery = () => {
    for (const delay of MOUNT_RECOVERY_DELAYS_MS) queueRefresh(delay);
  };

  const interval = setInterval(reload, REFRESH_INTERVAL_MS);
  const unsubscribers = [
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
  ];

  const dispose = () => {
    if (disposed) return;

    disposed = true;
    clearInterval(interval);
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const unsubscribe of unsubscribers) unsubscribe();
    getSessionResourceMap(api).delete(sessionID);
  };

  const resource: SessionQuotaResource = {
    sessionID,
    sidebar,
    compact,
    retain: () => {
      refCount += 1;
      return resource;
    },
    release: () => {
      refCount -= 1;
      if (refCount <= 0) dispose();
    },
  };

  reload();
  scheduleMountRecovery();

  return resource;
}

function acquireSessionQuotaResource(api: TuiPluginApi, sessionID: string): SessionQuotaResource {
  const resources = getSessionResourceMap(api);
  const existing = resources.get(sessionID);
  if (existing) return existing.retain();

  const next = createSessionQuotaResource(api, sessionID).retain();
  resources.set(sessionID, next);
  return next;
}

function createHomeBottomResource(api: TuiPluginApi): HomeBottomResource {
  const [bottom, setBottom] = createSignal<HomeBottomState>({
    status: "loading",
    compact: { status: "loading" },
  });

  let refCount = 0;
  let disposed = false;
  let loadVersion = 0;
  let inFlight = false;
  let queued = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const reload = () => {
    if (disposed) return;

    if (inFlight) {
      queued = true;
      loadVersion += 1;
      return;
    }

    inFlight = true;
    const currentVersion = ++loadVersion;

    void loadTuiHomeBottomStatus({ api })
      .then((next) => {
        if (disposed || currentVersion !== loadVersion) return;
        setBottom(next);
        // Fire-and-forget: write export file if enabled. A failed write must
        // never affect TUI rendering, so log a warning and continue.
        void writeTuiQuotaExportIfEnabled({ api }).catch((err) => {
          console.warn(`[opencode-quota] quota export write failed: ${String(err)}`);
        });
      })
      .catch(() => {
        if (disposed || currentVersion !== loadVersion) return;
      })
      .finally(() => {
        if (disposed) return;
        inFlight = false;
        if (queued) {
          queued = false;
          reload();
        }
      });
  };

  const queueRefresh = (delay: number) => {
    if (disposed) return;

    const timer = setTimeout(() => {
      timers.delete(timer);
      reload();
    }, delay);
    timers.add(timer);
  };

  const scheduleRefresh = () => {
    for (const delay of EVENT_REFRESH_DELAYS_MS) queueRefresh(delay);
  };

  const interval = setInterval(reload, REFRESH_INTERVAL_MS);
  const unsubscribers = [
    api.event.on("session.updated", scheduleRefresh),
    api.event.on("message.updated", scheduleRefresh),
    api.event.on("message.removed", scheduleRefresh),
    api.event.on("tui.session.select", scheduleRefresh),
  ];

  const dispose = () => {
    if (disposed) return;

    disposed = true;
    clearInterval(interval);
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const unsubscribe of unsubscribers) unsubscribe();
    homeResources.delete(api);
  };

  const resource: HomeBottomResource = {
    bottom,
    retain: () => {
      refCount += 1;
      return resource;
    },
    release: () => {
      refCount -= 1;
      if (refCount <= 0) dispose();
    },
  };

  reload();

  return resource;
}

function acquireHomeBottomResource(api: TuiPluginApi): HomeBottomResource {
  const existing = homeResources.get(api);
  if (existing) return existing.retain();

  const next = createHomeBottomResource(api).retain();
  homeResources.set(api, next);
  return next;
}

function useSessionQuotaResource(
  api: TuiPluginApi,
  sessionID: () => string,
): () => SessionQuotaResource {
  let current = acquireSessionQuotaResource(api, sessionID());
  const [resource, setResource] = createSignal(current);

  createEffect(() => {
    const nextSessionID = sessionID();
    if (current.sessionID === nextSessionID) return;

    const previous = current;
    current = acquireSessionQuotaResource(api, nextSessionID);
    setResource(current);
    previous.release();
  });

  onCleanup(() => {
    current.release();
  });

  return resource;
}

function SidebarContentView(props: { api: TuiPluginApi; sessionID: string }) {
  const resource = useSessionQuotaResource(props.api, () => props.sessionID);
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

  return (
    <Show when={shouldRenderSidebarPanel(panel())}>
      <box gap={0}>
        <box flexDirection="row" gap={1} onMouseDown={toggleCollapsed}>
          <Show when={hasDetailLines()}>
            <text fg={props.api.theme.current.text}>
              {toggleIcon()}
            </text>
          </Show>
          <text fg={props.api.theme.current.text}>
            <b>Quota</b>
            <Show when={collapsed() && providerCount() > 0}>
              <span style={{ fg: props.api.theme.current.textMuted }}> ({providerCount()} providers)</span>
            </Show>
          </text>
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
  visible?: boolean;
  disabled?: boolean;
  onSubmit?: () => void;
  promptRef?: TuiPromptRefCallback;
}) {
  const resource = useSessionQuotaResource(props.api, () => props.sessionID);
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

function HomeBottomView(props: { api: TuiPluginApi }) {
  const resource = acquireHomeBottomResource(props.api);
  onCleanup(() => resource.release());

  const announcement = () => getHomeBottomAnnouncementText(resource.bottom());
  const compact = () => resource.bottom().compact;

  return (
    <Show when={shouldRenderHomeBottom(resource.bottom())}>
      <box gap={0}>
        <text> </text>
        <Show when={announcement()}>
          <box flexDirection="row" justifyContent="center">
            <text fg={props.api.theme.current.textMuted} wrapMode="none">
              {announcement()}
            </text>
          </box>
        </Show>
        <CompactStatusLine api={props.api} panel={compact} justifyContent="center" />
      </box>
    </Show>
  );
}

function getActiveTuiSessionID(api: TuiPluginApi): string | undefined {
  const route = (api as any).route?.current;
  if (route?.name !== "session" && route?.type !== "session") return undefined;

  return normalizeTuiSessionID(
    route.params?.sessionID ?? route.params?.session_id ?? route.params?.id ?? route.sessionID,
  );
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
    <box gap={1}>
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
    <box gap={1}>
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

function TokensBetweenPromptDialog(props: {
  api: TuiPluginApi;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}) {
  const DialogPrompt = (props.api as any).ui?.DialogPrompt;
  if (DialogPrompt) {
    return (
      <DialogPrompt
        title="OpenCode Quota Token Range"
        placeholder="YYYY-MM-DD YYYY-MM-DD"
        description={() => (
          <text fg={props.api.theme.current.textMuted} wrapMode="none">
            Enter start and end dates, for example: 2026-01-01 2026-01-15
          </text>
        )}
        onConfirm={props.onConfirm}
        onCancel={props.onCancel}
      />
    );
  }

  return (
    <CommandOutputDialog
      api={props.api}
      title="OpenCode Quota Token Range"
      output={
        "Missing arguments for /tokens_between\n\nExpected: /tokens_between YYYY-MM-DD YYYY-MM-DD\nExample: /tokens_between 2026-01-01 2026-01-15"
      }
    />
  );
}

function replaceDialog(api: TuiPluginApi, size: DialogSize, render: () => JSX.Element) {
  const dialog = (api as any).ui?.dialog;
  dialog?.replace?.(render);
  // OpenCode's dialog.replace() resets size to medium; xlarge is the widest supported dialog.
  dialog?.setSize?.(size);
}

function clearDialog(api: TuiPluginApi): void {
  (api as any).ui?.dialog?.clear?.();
}

async function runQuotaDialogCommandAsync(
  api: TuiPluginApi,
  command: QuotaDialogCommandId,
  rawInput?: unknown,
  state?: QuotaDialogCommandState,
): Promise<void> {
  const spec = QUOTA_DIALOG_COMMANDS.find((item) => item.id === command)!;
  const args = getTuiCommandArguments(rawInput);
  const sessionID = getActiveTuiSessionID(api);

  if (command === "tokens_between" && !args) {
    replaceDialog(api, "medium", () => (
      <TokensBetweenPromptDialog
        api={api}
        onCancel={() => clearDialog(api)}
        onConfirm={(value) => {
          const nextArgs = value.trim();
          if (!nextArgs) {
            replaceDialog(api, "large", () => (
              <CommandOutputDialog
                api={api}
                title={spec.title}
                output={
                  "Missing arguments for /tokens_between\n\nExpected: /tokens_between YYYY-MM-DD YYYY-MM-DD\nExample: /tokens_between 2026-01-01 2026-01-15"
                }
              />
            ));
            return;
          }

          runQuotaDialogCommand(api, command, { arguments: nextArgs }, state);
        }}
      />
    ));
    return;
  }

  replaceDialog(api, spec.dialogSize, () => <CommandLoadingDialog api={api} title={spec.title} />);

  try {
    const result = await buildQuotaDialogCommandOutput({
      command,
      arguments: args,
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
        await (api as any).client?.app?.log?.({
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
      clearDialog(api);
      return;
    }

    replaceDialog(api, result.dialogSize, () => (
      <CommandOutputDialog api={api} title={result.title} output={result.output} />
    ));
  } catch (error) {
    replaceDialog(api, "large", () => <CommandErrorDialog api={api} title={spec.title} error={error} />);
    (api as any).ui?.toast?.({
      variant: "error",
      message: "OpenCode Quota command failed",
    });
  }
}

function runQuotaDialogCommand(
  api: TuiPluginApi,
  command: QuotaDialogCommandId,
  rawInput?: unknown,
  state?: QuotaDialogCommandState,
): void {
  void runQuotaDialogCommandAsync(api, command, rawInput, state);
}

function registerQuotaDialogCommands(api: TuiPluginApi): void {
  const keymap = (api as any).keymap;
  if (!keymap?.registerLayer) return;

  const commandState: QuotaDialogCommandState = {};
  const dispose = keymap.registerLayer({
    commands: QUOTA_DIALOG_COMMANDS.map((spec) => ({
      namespace: "palette",
      name: `opencode-quota.${spec.id}`,
      title: spec.title,
      desc: spec.description,
      category: "OpenCode Quota",
      slashName: spec.slashName,
      run(input?: unknown) {
        runQuotaDialogCommand(api, spec.id, input, commandState);
      },
    })),
  });

  if (typeof dispose === "function") {
    api.lifecycle.onDispose(dispose);
  }
}

function registerSidebarSlots(api: TuiPluginApi): void {
  api.slots.register({
    order: SIDEBAR_ORDER,
    slots: {
      sidebar_content(_ctx, props: { session_id: string }) {
        return <SidebarContentView api={api} sessionID={props.session_id} />;
      },
    },
  });
}

const tui: TuiPlugin = async (api) => {
  registerQuotaDialogCommands(api);

  let surfaceRegistration;
  try {
    surfaceRegistration = await resolveTuiSurfaceRegistration(api);
  } catch {
    registerSidebarSlots(api);
    return;
  }

  if (surfaceRegistration.sidebar.enabled) {
    registerSidebarSlots(api);
  }

  const compactRegistration = surfaceRegistration.compact;
  if (!compactRegistration.enabled && !surfaceRegistration.homeBottom) return;

  const compactSlots: Record<string, (ctx: any, props: any) => JSX.Element | null> = {};

  if (compactRegistration.sessionPrompt) {
    compactSlots.session_prompt = (
      _ctx,
      props: {
        session_id: string;
        visible?: boolean;
        disabled?: boolean;
        on_submit?: () => void;
        ref?: TuiPromptRefCallback;
      },
    ) => (
      <SessionPromptWithCompactStatus
        api={api}
        sessionID={props.session_id}
        visible={props.visible}
        disabled={props.disabled}
        onSubmit={props.on_submit}
        promptRef={props.ref}
      />
    );
  }

  if (surfaceRegistration.homeBottom) {
    compactSlots.home_bottom = () => <HomeBottomView api={api} />;
  }

  if (Object.keys(compactSlots).length > 0) {
    api.slots.register({
      order: COMPACT_ORDER,
      slots: compactSlots,
    });
  }
};

const pluginModule: TuiPluginModule & { id: string } = {
  id,
  tui,
};

export default pluginModule;
