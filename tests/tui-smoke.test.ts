import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  buildQuotaDialogCommandOutput,
  cleanupFns,
  createTuiQuotaClient,
  disposeQuotaTelemetryOwner,
  getTuiRuntimeRootHints,
  getTuiSessionModelMeta,
  loadTuiHomeBottomStatus,
  loadTuiSessionQuotaSurfaces,
  normalizeTuiSessionID,
  resolveTuiSurfaceRegistration,
  writeTuiQuotaExportIfEnabled,
} = vi.hoisted(() => ({
  buildQuotaDialogCommandOutput: vi.fn(),
  cleanupFns: [] as Array<() => void>,
  createTuiQuotaClient: vi.fn(() => ({ config: {} })),
  disposeQuotaTelemetryOwner: vi.fn(),
  getTuiRuntimeRootHints: vi.fn(() => ({
    worktreeRoot: "/tmp/worktree",
    activeDirectory: "/tmp/worktree",
    fallbackDirectory: "/tmp/worktree",
  })),
  getTuiSessionModelMeta: vi.fn(),
  loadTuiHomeBottomStatus: vi.fn(),
  loadTuiSessionQuotaSurfaces: vi.fn(),
  normalizeTuiSessionID: vi.fn((value: unknown) =>
    typeof value === "string" && value.trim() && !value.includes("{") ? value.trim() : undefined,
  ),
  resolveTuiSurfaceRegistration: vi.fn(),
  writeTuiQuotaExportIfEnabled: vi.fn(),
}));

vi.mock("../src/lib/tui-runtime.js", () => ({
  createTuiQuotaClient,
  getTuiRuntimeRootHints,
  getTuiSessionModelMeta,
  loadTuiHomeBottomStatus,
  loadTuiSessionQuotaSurfaces,
  normalizeTuiSessionID,
  resolveTuiSurfaceRegistration,
  writeTuiQuotaExportIfEnabled,
}));

vi.mock("../src/lib/quota-telemetry.js", () => ({
  disposeQuotaTelemetryOwner,
}));

vi.mock("../src/lib/quota-dialog-commands.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/quota-dialog-commands.js")>();
  return {
    ...actual,
    buildQuotaDialogCommandOutput,
  };
});

const TUI_COMMAND_IDS = [
  "quota",
  "quota_status",
  "quota_announcements",
  "pricing_refresh",
  "tokens_today",
  "tokens_daily",
  "tokens_weekly",
  "tokens_monthly",
  "tokens_all",
  "tokens_session",
  "tokens_session_all",
  "tokens_between",
] as const;

const TUI_COMMAND_GROUPS = [
  ["quota", "quota_status"],
  ["quota_announcements", "pricing_refresh"],
  ["tokens_today", "tokens_daily"],
  ["tokens_weekly", "tokens_monthly"],
  ["tokens_all", "tokens_session"],
  ["tokens_session_all", "tokens_between"],
] as const;

vi.mock("solid-js", () => ({
  Show: (props: { when: unknown; children?: unknown; fallback?: unknown }) => {
    if (!props.when) return props.fallback ?? null;
    return typeof props.children === "function"
      ? (props.children as (value: unknown) => unknown)(props.when)
      : props.children;
  },
  createEffect: (fn: () => void) => fn(),
  createSignal: <T>(initial: T) => {
    let value = initial;
    return [
      () => value,
      (next: T | ((previous: T) => T)) => {
        value = typeof next === "function" ? (next as (previous: T) => T)(value) : next;
        return value;
      },
    ];
  },
  onCleanup: (fn: () => void) => {
    cleanupFns.push(fn);
  },
}));

vi.mock("@opentui/solid/jsx-runtime", () => ({
  Fragment: Symbol.for("Fragment"),
  jsx: (type: unknown, props: Record<string, unknown>) =>
    typeof type === "function" ? type(props) : { type, props },
  jsxs: (type: unknown, props: Record<string, unknown>) =>
    typeof type === "function" ? type(props) : { type, props },
}));

function createElement(
  type: unknown,
  props: Record<string, unknown> | null,
  ...children: unknown[]
) {
  const nextProps = {
    ...(props ?? {}),
    ...(children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }),
  };
  return typeof type === "function" ? type(nextProps) : { type, props: nextProps };
}

function createApi() {
  const keymapLayers: Array<{ commands: Array<Record<string, unknown>> }> = [];
  const dialog = {
    setSize: vi.fn(),
    replace: vi.fn(),
    clear: vi.fn(),
  };
  const registered: Array<{
    order?: number;
    slots: Record<string, (ctx: unknown, props: any) => unknown>;
  }> = [];
  const unsubscribers: Array<ReturnType<typeof vi.fn>> = [];
  const eventHandlers = new Map<string, Array<(event: any) => void>>();
  const kvStore = new Map<string, unknown>();
  const api = {
    route: {
      current: {
        name: "session",
        params: { sessionID: "session-route" },
      },
    },
    state: {
      provider: [],
      path: {
        worktree: "/tmp/worktree",
        directory: "/tmp/worktree",
      },
      session: {
        messages: vi.fn(() => []),
      },
    },
    theme: {
      current: {
        text: "text",
        textMuted: "muted",
      },
    },
    ui: {
      Prompt: vi.fn((props: Record<string, unknown>) => ({ type: "Prompt", props })),
      DialogPrompt: vi.fn((props: Record<string, unknown>) => ({ type: "DialogPrompt", props })),
      dialog,
      toast: vi.fn(),
    },
    event: {
      on: vi.fn((eventName: string, handler: (event: any) => void) => {
        const handlers = eventHandlers.get(eventName) ?? [];
        handlers.push(handler);
        eventHandlers.set(eventName, handlers);
        const unsubscribe = vi.fn();
        unsubscribers.push(unsubscribe);
        return unsubscribe;
      }),
    },
    kv: {
      get: vi.fn((key: string, fallback?: unknown) =>
        kvStore.has(key) ? kvStore.get(key) : fallback,
      ),
      set: vi.fn((key: string, value: unknown) => {
        kvStore.set(key, value);
      }),
    },
    slots: {
      register: vi.fn(
        (plugin: {
          order?: number;
          slots: Record<string, (ctx: unknown, props: any) => unknown>;
        }) => {
          registered.push(plugin);
          return `slot-${registered.length}`;
        },
      ),
    },
    lifecycle: {
      onDispose: vi.fn(),
    },
    keymap: {
      registerLayer: vi.fn((layer: { commands: Array<Record<string, unknown>> }) => {
        keymapLayers.push(layer);
        return vi.fn();
      }),
    },
    client: {
      app: { log: vi.fn().mockResolvedValue(undefined) },
      session: {
        prompt: vi.fn(),
        command: vi.fn(),
      },
    },
  };

  return {
    api,
    registered,
    unsubscribers,
    eventHandlers,
    kvStore,
    keymapLayers,
    dialog,
  };
}

const tuiPlugin = (await import("../src/tui.tsx")).default;

async function loadTuiModule() {
  return tuiPlugin;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function startTui(
  plugin: Awaited<ReturnType<typeof loadTuiModule>>,
  api: ReturnType<typeof createApi>["api"],
): Promise<void> {
  await plugin.tui(api as any, undefined, {} as any);
  await flushPromises();
}

describe("tui plugin smoke", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as any).React = { createElement };
    cleanupFns.length = 0;
    buildQuotaDialogCommandOutput.mockReset();
    buildQuotaDialogCommandOutput.mockResolvedValue({
      state: "output",
      command: "quota",
      title: "OpenCode Quota",
      output: "Quota line 1\n\nQuota line 3",
      dialogSize: "xlarge",
    });
    createTuiQuotaClient.mockClear();
    disposeQuotaTelemetryOwner.mockClear();
    getTuiRuntimeRootHints.mockClear();
    getTuiSessionModelMeta.mockReset();
    getTuiSessionModelMeta.mockResolvedValue({ modelID: "gpt-5", providerID: "openai" });
    loadTuiHomeBottomStatus.mockReset();
    loadTuiHomeBottomStatus.mockResolvedValue({
      status: "ready",
      compact: { status: "ready", text: "Home quota" },
    });
    loadTuiSessionQuotaSurfaces.mockReset();
    loadTuiSessionQuotaSurfaces.mockResolvedValue({
      sidebar: { status: "ready", lines: ["Sidebar quota"] },
      compact: { status: "ready", text: "Session quota" },
    });
    resolveTuiSurfaceRegistration.mockReset();
    writeTuiQuotaExportIfEnabled.mockReset();
    writeTuiQuotaExportIfEnabled.mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const cleanup of cleanupFns.splice(0)) cleanup();
    vi.clearAllTimers();
    delete (globalThis as any).React;
    vi.useRealTimers();
  });

  it("registers stable neutral hosts before late surface resolution and activates once", async () => {
    const plugin = await loadTuiModule();
    const { api, keymapLayers, registered } = createApi();
    const registration = deferred<any>();
    resolveTuiSurfaceRegistration.mockReturnValueOnce(registration.promise);

    await plugin.tui(api as any, undefined, {} as any);

    expect(resolveTuiSurfaceRegistration).toHaveBeenCalledOnce();
    expect(keymapLayers).toHaveLength(1);
    expect(registered.map((entry) => entry.order)).toEqual([150, 90]);
    expect(Object.keys(registered[0]!.slots)).toEqual(["sidebar_content"]);
    expect(Object.keys(registered[1]!.slots)).toEqual(["session_prompt", "home_bottom"]);
    expect(registered[0]!.slots.sidebar_content({}, { session_id: "session-1" })).toBeNull();
    expect(registered[1]!.slots.session_prompt({}, { session_id: "session-1" })).toBeNull();
    expect(registered[1]!.slots.home_bottom({}, {})).toBeNull();
    expect(loadTuiSessionQuotaSurfaces).not.toHaveBeenCalled();
    expect(loadTuiHomeBottomStatus).not.toHaveBeenCalled();
    keymapLayers[0]!.commands[0]!.run?.();
    expect(buildQuotaDialogCommandOutput).not.toHaveBeenCalled();

    registration.resolve({
      commandDisplay: "inline",
      sidebar: { enabled: true },
      compact: {
        enabled: true,
        homeBottom: true,
        sessionPrompt: true,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: false },
      homeBottom: true,
    });
    await flushPromises();

    expect(api.keymap.registerLayer).toHaveBeenCalledOnce();
    expect(api.slots.register).toHaveBeenCalledTimes(2);
    expect(buildQuotaDialogCommandOutput).not.toHaveBeenCalled();

    keymapLayers[0]!.commands[0]!.run?.();
    await flushPromises();

    expect(buildQuotaDialogCommandOutput).toHaveBeenCalledOnce();
    expect(api.client.session.prompt).toHaveBeenCalledOnce();
    expect(registered[1]!.slots.session_prompt({}, { session_id: "session-1" })).not.toBeNull();
    expect(registered[1]!.slots.home_bottom({}, {})).not.toBeNull();
    expect(loadTuiSessionQuotaSurfaces).toHaveBeenCalledOnce();
    expect(loadTuiHomeBottomStatus).toHaveBeenCalledOnce();
  });

  it("uses independent one-shot session and home registration tickets", async () => {
    const plugin = await loadTuiModule();
    const { api, registered, eventHandlers } = createApi();
    const initialRuntimeSeed = { marker: "registration" };
    resolveTuiSurfaceRegistration.mockImplementationOnce(
      (
        _api: unknown,
        options?: { captureInitialRuntime?: (seed: typeof initialRuntimeSeed) => void },
      ) => {
        options?.captureInitialRuntime?.(initialRuntimeSeed);
        return Promise.resolve({
          commandDisplay: "inline",
          sidebar: { enabled: true },
          compact: {
            enabled: true,
            homeBottom: true,
            sessionPrompt: true,
            hasNativeProviderQuota: false,
            suppressedByNativeProviderQuota: false,
          },
          promptBar: { enabled: true },

          announcements: { homeBottom: false },
          homeBottom: true,
        });
      },
    );

    await startTui(plugin, api);
    registered[0]!.slots.sidebar_content({}, { session_id: "session-1" });
    registered[1]!.slots.session_prompt({}, { session_id: "session-1" });
    registered[1]!.slots.home_bottom({}, {});
    await flushPromises();

    expect(loadTuiSessionQuotaSurfaces).toHaveBeenCalledTimes(1);
    expect(loadTuiSessionQuotaSurfaces).toHaveBeenNthCalledWith(1, {
      api,
      sessionID: "session-1",
      initialRuntimeSeed,
    });
    expect(loadTuiHomeBottomStatus).toHaveBeenNthCalledWith(1, {
      api,
      initialRuntimeSeed,
    });

    for (const handler of eventHandlers.get("message.updated") ?? []) {
      handler({ properties: { info: { sessionID: "session-1" } } });
    }
    await vi.advanceTimersByTimeAsync(150);
    expect(loadTuiHomeBottomStatus).toHaveBeenNthCalledWith(2, { api });
    expect(loadTuiSessionQuotaSurfaces).toHaveBeenNthCalledWith(2, {
      api,
      sessionID: "session-1",
    });
  });

  it("consumes a session ticket when the initial load starts and does not pass it to a successor", async () => {
    const plugin = await loadTuiModule();
    const { api, registered } = createApi();
    const initialRuntimeSeed = { marker: "registration" };
    loadTuiSessionQuotaSurfaces.mockRejectedValueOnce(new Error("initial unavailable"));
    resolveTuiSurfaceRegistration.mockImplementationOnce(
      (
        _api: unknown,
        options?: { captureInitialRuntime?: (seed: typeof initialRuntimeSeed) => void },
      ) => {
        options?.captureInitialRuntime?.(initialRuntimeSeed);
        return Promise.resolve({
          commandDisplay: "inline",
          sidebar: { enabled: true },
          compact: {
            enabled: false,
            homeBottom: false,
            sessionPrompt: false,
            hasNativeProviderQuota: false,
            suppressedByNativeProviderQuota: false,
          },
          promptBar: { enabled: true },

          announcements: { homeBottom: false },
          homeBottom: false,
        });
      },
    );

    await startTui(plugin, api);
    const sidebar = registered[0]!.slots.sidebar_content;
    sidebar({}, { session_id: "session-1" });
    await flushPromises();
    expect(loadTuiSessionQuotaSurfaces).toHaveBeenNthCalledWith(1, {
      api,
      sessionID: "session-1",
      initialRuntimeSeed,
    });

    cleanupFns.pop()!();
    sidebar({}, { session_id: "session-1" });
    await flushPromises();
    expect(loadTuiSessionQuotaSurfaces).toHaveBeenNthCalledWith(2, {
      api,
      sessionID: "session-1",
    });
  });

  it("does not queue repeated commands while surface registration is pending", async () => {
    const plugin = await loadTuiModule();
    const { api, keymapLayers } = createApi();
    const registration = deferred<any>();
    resolveTuiSurfaceRegistration.mockReturnValueOnce(registration.promise);

    await plugin.tui(api as any, undefined, {} as any);
    for (let index = 0; index < 25; index += 1) keymapLayers[0]!.commands[0]!.run?.();

    registration.resolve({
      commandDisplay: "inline",
      sidebar: { enabled: false },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: false },
      homeBottom: false,
    });
    await flushPromises();

    expect(buildQuotaDialogCommandOutput).not.toHaveBeenCalled();
    keymapLayers[0]!.commands[0]!.run?.();
    await flushPromises();
    expect(buildQuotaDialogCommandOutput).toHaveBeenCalledOnce();
  });

  it("does not react to a pending command when resolution is followed by disposal", async () => {
    const plugin = await loadTuiModule();
    const { api, keymapLayers } = createApi();
    const registration = deferred<any>();
    resolveTuiSurfaceRegistration.mockReturnValueOnce(registration.promise);

    await plugin.tui(api as any, undefined, {} as any);
    keymapLayers[0]!.commands[0]!.run?.();
    registration.resolve({
      commandDisplay: "inline",
      sidebar: { enabled: false },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: false },
      homeBottom: false,
    });
    const dispose = api.lifecycle.onDispose.mock.calls[0]?.[0];
    dispose?.();
    await flushPromises();

    keymapLayers[0]!.commands[0]!.run?.();
    await flushPromises();
    expect(buildQuotaDialogCommandOutput).not.toHaveBeenCalled();
  });

  it("activates the existing inline-command and sidebar fallback after late failure", async () => {
    const plugin = await loadTuiModule();
    const { api, keymapLayers, registered } = createApi();
    const registration = deferred<any>();
    resolveTuiSurfaceRegistration.mockReturnValueOnce(registration.promise);

    await plugin.tui(api as any, undefined, {} as any);
    expect(keymapLayers).toHaveLength(1);
    expect(registered).toHaveLength(2);
    expect(registered[0]!.slots.sidebar_content({}, { session_id: "session-1" })).toBeNull();

    registration.reject(new Error("config unavailable"));
    await flushPromises();

    expect(api.keymap.registerLayer).toHaveBeenCalledOnce();
    expect(api.slots.register).toHaveBeenCalledTimes(2);
    registered[0]!.slots.sidebar_content({}, { session_id: "session-1" });
    expect(loadTuiSessionQuotaSurfaces).toHaveBeenCalledOnce();
    expect(registered[1]!.slots.session_prompt({}, { session_id: "session-1" })).toBeNull();
    expect(registered[1]!.slots.home_bottom({}, {})).toBeNull();
  });

  it("consumes late registration errors without retrying fallback", async () => {
    const plugin = await loadTuiModule();
    const { api, registered } = createApi();
    api.keymap.registerLayer.mockImplementationOnce(() => {
      throw new Error("registration unavailable");
    });
    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "inline",
      sidebar: { enabled: true },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: false },
      homeBottom: false,
    });

    await plugin.tui(api as any, undefined, {} as any);
    await flushPromises();

    expect(api.keymap.registerLayer).toHaveBeenCalledOnce();
    expect(registered).toEqual([]);
  });

  it.each([
    ["first", 1],
    ["second", 2],
  ] as const)("keeps the installed command layer active when the %s slot registration throws", async (_label, failedAttempt) => {
    const plugin = await loadTuiModule();
    const { api, keymapLayers, registered } = createApi();
    const registration = deferred<any>();
    resolveTuiSurfaceRegistration.mockReturnValueOnce(registration.promise);
    let attempts = 0;
    api.slots.register.mockImplementation((entry: any) => {
      attempts += 1;
      if (attempts === failedAttempt) throw new Error("slot registration unavailable");
      registered.push(entry);
      return `slot-${registered.length}`;
    });

    await plugin.tui(api as any, undefined, {} as any);
    expect(api.keymap.registerLayer).toHaveBeenCalledOnce();
    expect(api.slots.register).toHaveBeenCalledTimes(failedAttempt);
    expect(registered).toHaveLength(failedAttempt - 1);

    registration.resolve({
      commandDisplay: "inline",
      sidebar: { enabled: true },
      compact: {
        enabled: true,
        homeBottom: true,
        sessionPrompt: true,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: false },
      homeBottom: true,
    });
    await flushPromises();

    keymapLayers[0]!.commands[0]!.run?.();
    await flushPromises();
    expect(buildQuotaDialogCommandOutput).toHaveBeenCalledOnce();
    expect(api.client.session.prompt).toHaveBeenCalledOnce();
  });

  it("keeps eager hosts neutral and pending commands inert after disposal", async () => {
    const plugin = await loadTuiModule();
    const { api, keymapLayers, registered } = createApi();
    const registration = deferred<any>();
    resolveTuiSurfaceRegistration.mockReturnValueOnce(registration.promise);

    await plugin.tui(api as any, undefined, {} as any);
    expect(api.lifecycle.onDispose).toHaveBeenCalledTimes(2);
    expect(keymapLayers).toHaveLength(1);
    expect(registered).toHaveLength(2);

    keymapLayers[0]!.commands[0]!.run?.();
    const dispose = api.lifecycle.onDispose.mock.calls[0]?.[0];
    dispose?.();
    registration.reject(new Error("config unavailable"));
    await flushPromises();

    expect(api.keymap.registerLayer).toHaveBeenCalledOnce();
    expect(api.slots.register).toHaveBeenCalledTimes(2);
    expect(registered[0]!.slots.sidebar_content({}, { session_id: "session-1" })).toBeNull();
    expect(registered[1]!.slots.session_prompt({}, { session_id: "session-1" })).toBeNull();
    expect(registered[1]!.slots.home_bottom({}, {})).toBeNull();
    expect(buildQuotaDialogCommandOutput).not.toHaveBeenCalled();
    expect(loadTuiSessionQuotaSurfaces).not.toHaveBeenCalled();
    expect(loadTuiHomeBottomStatus).not.toHaveBeenCalled();
    expect(createTuiQuotaClient).toHaveBeenCalledOnce();
    expect(disposeQuotaTelemetryOwner).toHaveBeenCalledOnce();
  });

  it("registers every deterministic command through the palette keymap", async () => {
    const plugin = await loadTuiModule();
    const { api, keymapLayers, dialog } = createApi();

    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "inline",
      sidebar: { enabled: false },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: false },
      homeBottom: false,
    });

    await startTui(plugin, api);

    expect(api.keymap.registerLayer).toHaveBeenCalledOnce();
    expect(api.lifecycle.onDispose).toHaveBeenCalledTimes(2);
    const telemetryCleanup = api.lifecycle.onDispose.mock.calls[0]?.[0];
    expect(telemetryCleanup).toBeTypeOf("function");
    telemetryCleanup?.();
    expect(createTuiQuotaClient).toHaveBeenCalledOnce();
    expect(disposeQuotaTelemetryOwner).toHaveBeenCalledWith(
      createTuiQuotaClient.mock.results[0]?.value,
    );
    expect(keymapLayers[0]?.commands.map((command) => command.slashName)).toEqual(TUI_COMMAND_IDS);
    for (const slashName of TUI_COMMAND_IDS) {
      expect(
        keymapLayers[0]?.commands.filter((command) => command.slashName === slashName),
      ).toHaveLength(1);
    }
    expect(dialog.replace).not.toHaveBeenCalled();
  });

  describe.each(["inline", "dialog"] as const)("%s native command display", (commandDisplay) => {
    it.each(
      TUI_COMMAND_GROUPS,
    )("routes /%s and /%s once without model execution", async (...commands) => {
      const plugin = await loadTuiModule();
      const { api, keymapLayers, dialog } = createApi();

      resolveTuiSurfaceRegistration.mockResolvedValueOnce({
        commandDisplay,
        sidebar: { enabled: false },
        compact: {
          enabled: false,
          homeBottom: false,
          sessionPrompt: false,
          hasNativeProviderQuota: false,
          suppressedByNativeProviderQuota: false,
        },
        promptBar: { enabled: true },

        announcements: { homeBottom: false },
        homeBottom: false,
      });

      await startTui(plugin, api);
      for (const command of commands) {
        vi.clearAllMocks();
        const output = `${command} output`;
        buildQuotaDialogCommandOutput.mockResolvedValueOnce({
          state: "output",
          command,
          title: command,
          output,
          dialogSize: "xlarge",
        });
        const registeredCommand = keymapLayers[0]!.commands.find(
          (item) => item.slashName === command,
        )!;
        (registeredCommand.run as (input?: unknown) => void)({ arguments: "" });
        await Promise.resolve();
        await Promise.resolve();

        expect(buildQuotaDialogCommandOutput, command).toHaveBeenCalledOnce();
        expect(buildQuotaDialogCommandOutput, command).toHaveBeenCalledWith(
          expect.objectContaining({
            command,
            client: { config: {} },
            sessionID: "session-route",
          }),
        );
        if (commandDisplay === "inline") {
          expect(api.client.session.prompt, command).toHaveBeenCalledOnce();
          expect(api.client.session.prompt, command).toHaveBeenCalledWith({
            sessionID: "session-route",
            noReply: true,
            parts: [{ type: "text", text: output, ignored: true }],
          });
          expect(dialog.replace, command).not.toHaveBeenCalled();
        } else {
          expect(api.client.session.prompt, command).not.toHaveBeenCalled();
          expect(dialog.replace, command).toHaveBeenCalledTimes(2);
        }
        expect(api.client.session.command, command).not.toHaveBeenCalled();
      }
    });
  });

  it("selects Home dialog destination before executing an inline-configured command", async () => {
    const plugin = await loadTuiModule();
    const { api, keymapLayers, dialog } = createApi();
    (api.route.current as any) = { name: "home", params: {} };
    let dialogCallsAtExecution = 0;
    buildQuotaDialogCommandOutput.mockImplementationOnce(async () => {
      dialogCallsAtExecution = dialog.replace.mock.calls.length;
      return {
        state: "output",
        command: "quota",
        title: "OpenCode Quota",
        output: "Home quota output",
        dialogSize: "xlarge",
      };
    });
    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "inline",
      sidebar: { enabled: false },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: false },
      homeBottom: false,
    });

    await startTui(plugin, api);
    const quota = keymapLayers[0]!.commands.find((command) => command.slashName === "quota")!;
    (quota.run as (input?: unknown) => void)({ arguments: "" });
    await Promise.resolve();
    await Promise.resolve();

    expect(dialogCallsAtExecution).toBe(1);
    expect(buildQuotaDialogCommandOutput).toHaveBeenCalledOnce();
    expect(api.client.session.prompt).not.toHaveBeenCalled();
    expect(dialog.replace).toHaveBeenCalledTimes(2);
    expect(api.client.session.command).not.toHaveBeenCalled();
  });

  it.each([
    "inline",
    "dialog",
  ] as const)("keeps command no-op behavior in %s mode", async (commandDisplay) => {
    const plugin = await loadTuiModule();
    const { api, keymapLayers, dialog } = createApi();
    buildQuotaDialogCommandOutput.mockResolvedValueOnce({
      state: "noop",
      command: "pricing_refresh",
      reason: "disabled",
    });
    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay,
      sidebar: { enabled: false },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: false },
      homeBottom: false,
    });

    await startTui(plugin, api);
    const refresh = keymapLayers[0]!.commands.find(
      (command) => command.slashName === "pricing_refresh",
    )!;
    (refresh.run as (input?: unknown) => void)({ arguments: "" });
    await Promise.resolve();
    await Promise.resolve();

    expect(buildQuotaDialogCommandOutput).toHaveBeenCalledOnce();
    expect(api.client.session.prompt).not.toHaveBeenCalled();
    expect(api.client.session.command).not.toHaveBeenCalled();
    if (commandDisplay === "inline") {
      expect(dialog.replace).not.toHaveBeenCalled();
      expect(dialog.clear).not.toHaveBeenCalled();
    } else {
      expect(dialog.replace).toHaveBeenCalledOnce();
      expect(dialog.clear).toHaveBeenCalledOnce();
    }
  });

  it("shows the command error without falling back to quota output dialog when inline injection fails", async () => {
    const plugin = await loadTuiModule();
    const { api, keymapLayers, dialog } = createApi();
    api.client.session.prompt.mockRejectedValueOnce(new Error("prompt unavailable"));

    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "inline",
      sidebar: { enabled: false },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: false },
      homeBottom: false,
    });

    await startTui(plugin, api);
    const quota = keymapLayers[0]!.commands.find((command) => command.slashName === "quota")!;
    (quota.run as (input?: unknown) => void)();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(api.client.session.prompt).toHaveBeenCalledOnce();
    expect(dialog.replace).toHaveBeenCalledOnce();
    const errorDialog = dialog.replace.mock.calls[0]![0]() as any;
    expect(errorDialog.props.children).not.toContain("Quota line 1");
    expect(api.ui.toast).toHaveBeenCalledWith({
      variant: "error",
      message: "OpenCode Quota command failed",
    });
    expect(api.client.session.command).not.toHaveBeenCalled();
  });

  it("collects arguments with DialogPrompt before running an argument-capable command", async () => {
    const plugin = await loadTuiModule();
    const { api, keymapLayers, dialog } = createApi();

    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "inline",
      sidebar: { enabled: false },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: false },
      homeBottom: false,
    });

    await startTui(plugin, api);
    const status = keymapLayers[0]!.commands.find(
      (command) => command.slashName === "quota_status",
    )!;
    (status.run as (input?: unknown) => void)();

    expect(buildQuotaDialogCommandOutput).not.toHaveBeenCalled();
    const prompt = dialog.replace.mock.calls[0]![0]() as any;
    expect(prompt).toEqual(
      expect.objectContaining({
        type: "DialogPrompt",
        props: expect.objectContaining({
          title: "OpenCode Quota Status Options",
        }),
      }),
    );

    prompt.props.onConfirm('  {"force":true}  ');
    await Promise.resolve();
    await Promise.resolve();

    expect(buildQuotaDialogCommandOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "quota_status",
        arguments: '{"force":true}',
      }),
    );
    expect(api.client.session.prompt).toHaveBeenCalledOnce();
    expect(api.client.session.prompt).toHaveBeenCalledWith({
      sessionID: "session-route",
      noReply: true,
      parts: [
        {
          type: "text",
          text: "Quota line 1\n\nQuota line 3",
          ignored: true,
        },
      ],
    });
    expect(api.client.session.command).not.toHaveBeenCalled();

    (status.run as (input?: unknown) => void)();
    const blankPrompt = dialog.replace.mock.calls.at(-1)![0]() as any;
    blankPrompt.props.onConfirm("   ");
    await Promise.resolve();
    await Promise.resolve();
    expect(buildQuotaDialogCommandOutput).toHaveBeenLastCalledWith(
      expect.objectContaining({ command: "quota_status", arguments: undefined }),
    );
    expect(api.client.session.prompt).toHaveBeenCalledTimes(2);

    const announcements = keymapLayers[0]!.commands.find(
      (command) => command.slashName === "quota_announcements",
    )!;
    (announcements.run as (input?: unknown) => void)();
    expect(buildQuotaDialogCommandOutput).toHaveBeenCalledTimes(2);
    const announcementsPrompt = dialog.replace.mock.calls.at(-1)![0]() as any;
    announcementsPrompt.props.onConfirm("   ");
    await Promise.resolve();
    await Promise.resolve();
    expect(buildQuotaDialogCommandOutput).toHaveBeenLastCalledWith(
      expect.objectContaining({ command: "quota_announcements" }),
    );
    expect(api.client.session.prompt).toHaveBeenCalledTimes(3);
    expect(api.client.session.command).not.toHaveBeenCalled();
  });

  it("keeps argument input in a dialog and routes final output to configured Dialog mode", async () => {
    const plugin = await loadTuiModule();
    const { api, keymapLayers, dialog } = createApi();
    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "dialog",
      sidebar: { enabled: false },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: false },
      homeBottom: false,
    });

    await startTui(plugin, api);
    const between = keymapLayers[0]!.commands.find(
      (command) => command.slashName === "tokens_between",
    )!;
    (between.run as (input?: unknown) => void)();
    expect(buildQuotaDialogCommandOutput).not.toHaveBeenCalled();

    const prompt = dialog.replace.mock.calls[0]![0]() as any;
    prompt.props.onConfirm("2026-01-01 2026-01-15");
    await Promise.resolve();
    await Promise.resolve();

    expect(buildQuotaDialogCommandOutput).toHaveBeenCalledOnce();
    expect(buildQuotaDialogCommandOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "tokens_between",
        arguments: "2026-01-01 2026-01-15",
      }),
    );
    expect(dialog.replace).toHaveBeenCalledTimes(3);
    expect(api.client.session.prompt).not.toHaveBeenCalled();
    expect(api.client.session.command).not.toHaveBeenCalled();
  });

  it("keeps stable hosts registered while activating sidebar and compact surfaces independently", async () => {
    const plugin = await loadTuiModule();
    const sidebarOnly = createApi();

    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
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
    });

    await startTui(plugin, sidebarOnly.api);

    expect(sidebarOnly.registered).toHaveLength(2);
    expect(sidebarOnly.registered.map((entry) => entry.order)).toEqual([150, 90]);
    sidebarOnly.registered[0].slots.sidebar_content({}, { session_id: "session-1" });
    await flushPromises();
    expect(
      sidebarOnly.registered[0].slots.sidebar_content({}, { session_id: "session-1" }),
    ).not.toBeNull();
    expect(
      sidebarOnly.registered[1].slots.session_prompt({}, { session_id: "session-1" }),
    ).toBeNull();
    expect(sidebarOnly.registered[1].slots.home_bottom({}, {})).toBeNull();

    const compactOnly = createApi();
    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "inline",
      sidebar: { enabled: false },
      compact: {
        enabled: true,
        homeBottom: true,
        sessionPrompt: true,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: true },
      homeBottom: true,
    });

    await startTui(plugin, compactOnly.api);

    expect(compactOnly.registered).toHaveLength(2);
    expect(compactOnly.registered.map((entry) => entry.order)).toEqual([150, 90]);
    expect(
      compactOnly.registered[0].slots.sidebar_content({}, { session_id: "session-1" }),
    ).toBeNull();
    expect(
      compactOnly.registered[1].slots.session_prompt({}, { session_id: "session-1" }),
    ).not.toBeNull();
    expect(compactOnly.registered[1].slots.home_bottom({}, {})).not.toBeNull();

    const enabled = createApi();
    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "inline",
      sidebar: { enabled: true },
      compact: {
        enabled: true,
        homeBottom: true,
        sessionPrompt: true,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: true },
      homeBottom: true,
    });

    await startTui(plugin, enabled.api);

    expect(enabled.registered).toHaveLength(2);
    expect(enabled.registered[0].order).toBe(150);
    expect(Object.keys(enabled.registered[0].slots)).toEqual(["sidebar_content"]);
    expect(enabled.registered[1].order).toBe(90);
    expect(Object.keys(enabled.registered[1].slots)).toEqual(["session_prompt", "home_bottom"]);
  });

  it("renders sidebar summary count from runtime state and persists detail toggles", async () => {
    const plugin = await loadTuiModule();
    const { api, registered } = createApi();

    loadTuiSessionQuotaSurfaces.mockResolvedValueOnce({
      sidebar: {
        status: "ready",
        lines: ["OpenCode Go Five-hour 98%"],
        linesExpanded: [
          "[OpenCode Go]",
          "Five-hour window 98%",
          "Weekly window 53%",
          "Monthly window 33%",
        ],
        providerCount: 2,
      },
      compact: { status: "ready", text: "Session quota" },
    });
    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "inline",
      sidebar: { enabled: true },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: false },
      homeBottom: false,
    });

    await startTui(plugin, api);

    const sidebarRegistration = registered.find((registration) => registration.order === 150);
    expect(sidebarRegistration).toBeDefined();

    sidebarRegistration!.slots.sidebar_content({}, { session_id: "session-1" });
    await Promise.resolve();

    const collapsed = sidebarRegistration!.slots.sidebar_content(
      {},
      { session_id: "session-1" },
    ) as any;
    const collapsedHeader = collapsed.props.children[0];
    expect(collapsedHeader.props.children[0].props.children.props.children).toBe("▶ Quota");
    expect(collapsedHeader.props.children[1].props.children).toEqual([" (", 2, " providers)"]);
    expect(
      collapsed.props.children[1].props.children.map((line: any) => line.props.children),
    ).toEqual(["OpenCode Go Five-hour 98%"]);

    collapsedHeader.props.children[0].props.onMouseDown();

    expect(api.kv.set).toHaveBeenCalledWith("quota-sidebar-collapsed", false);

    const expanded = sidebarRegistration!.slots.sidebar_content(
      {},
      { session_id: "session-1" },
    ) as any;
    const expandedHeader = expanded.props.children[0];
    expect(expandedHeader.props.children[0].props.children.props.children).toBe("▼ Quota");
    expect(
      expanded.props.children[1].props.children.map((line: any) => line.props.children),
    ).toEqual(["[OpenCode Go]", "Five-hour window 98%", "Weekly window 53%", "Monthly window 33%"]);
  });

  it("renders the percent mode indicator in the sidebar header when set", async () => {
    const plugin = await loadTuiModule();
    const { api, registered } = createApi();

    loadTuiSessionQuotaSurfaces.mockResolvedValueOnce({
      sidebar: {
        status: "ready",
        lines: ["OpenCode Go Five-hour 98%"],
        linesExpanded: ["[OpenCode Go]", "Five-hour window 98%"],
        headerPercentMode: "used",
      },
      compact: { status: "disabled" },
    });
    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "inline",
      sidebar: { enabled: true },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: false },
      homeBottom: false,
    });

    await startTui(plugin, api);

    const sidebarRegistration = registered.find((registration) => registration.order === 150);
    sidebarRegistration!.slots.sidebar_content({}, { session_id: "session-1" });
    await Promise.resolve();

    const collapsed = sidebarRegistration!.slots.sidebar_content(
      {},
      { session_id: "session-1" },
    ) as any;
    expect(collapsed.props.children[0].props.children[0].props.children.props.children).toBe(
      "▶ Quota [Used]",
    );

    collapsed.props.children[0].props.children[0].props.onMouseDown();

    const expanded = sidebarRegistration!.slots.sidebar_content(
      {},
      { session_id: "session-1" },
    ) as any;
    expect(expanded.props.children[0].props.children[0].props.children.props.children).toBe(
      "▼ Quota [Used]",
    );
  });

  it("keeps non-expandable empty sidebar panels visible while collapsed", async () => {
    const plugin = await loadTuiModule();
    const { api, registered } = createApi();

    loadTuiSessionQuotaSurfaces.mockResolvedValueOnce({
      sidebar: { status: "ready", lines: [] },
      compact: { status: "ready", text: "Session quota" },
    });
    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "inline",
      sidebar: { enabled: true },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: false },
      homeBottom: false,
    });

    await startTui(plugin, api);

    const sidebarRegistration = registered.find((registration) => registration.order === 150);
    expect(sidebarRegistration).toBeDefined();

    sidebarRegistration!.slots.sidebar_content({}, { session_id: "session-1" });
    await Promise.resolve();

    const rendered = sidebarRegistration!.slots.sidebar_content(
      {},
      { session_id: "session-1" },
    ) as any;
    const header = rendered.props.children[0];
    expect(header.props.children[0].props.children.props.children).toBe("Quota");
    expect(rendered.props.children[1].props.children[0].props.children).toBe("Unavailable");
  });

  it("activates only the sidebar host when surface resolution fails", async () => {
    const plugin = await loadTuiModule();
    const fallback = createApi();

    resolveTuiSurfaceRegistration.mockRejectedValueOnce(new Error("config unavailable"));

    await startTui(plugin, fallback.api);

    expect(fallback.registered).toHaveLength(2);
    expect(fallback.registered.map((entry) => entry.order)).toEqual([150, 90]);
    fallback.registered[0].slots.sidebar_content({}, { session_id: "session-1" });
    await flushPromises();
    expect(
      fallback.registered[0].slots.sidebar_content({}, { session_id: "session-1" }),
    ).not.toBeNull();
    expect(fallback.registered[1].slots.session_prompt({}, { session_id: "session-1" })).toBeNull();
    expect(fallback.registered[1].slots.home_bottom({}, {})).toBeNull();
    expect(loadTuiSessionQuotaSurfaces).toHaveBeenCalledWith({
      api: fallback.api,
      sessionID: "session-1",
    });
  });

  it("does not register right-side compact slots", async () => {
    const plugin = await loadTuiModule();
    const { api, registered } = createApi();

    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "inline",
      sidebar: { enabled: true },
      compact: {
        enabled: true,
        homeBottom: true,
        sessionPrompt: true,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: true },
      homeBottom: true,
    });

    await startTui(plugin, api);

    const slotNames = registered.flatMap((registration) => Object.keys(registration.slots));
    expect(slotNames).toContain("session_prompt");
    expect(slotNames).toContain("home_bottom");
    expect(slotNames).not.toContain("session_prompt_right");
    expect(slotNames).not.toContain("home_prompt_right");
  });

  it("preserves session refresh delays, event filtering, interval refresh, and mount recovery", async () => {
    const plugin = await loadTuiModule();
    const { api, registered, eventHandlers } = createApi();
    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "inline",
      sidebar: { enabled: true },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: false },
      homeBottom: false,
    });

    await startTui(plugin, api);
    registered[0]!.slots.sidebar_content({}, { session_id: "session-1" });
    await flushPromises();
    expect(loadTuiSessionQuotaSurfaces).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(loadTuiSessionQuotaSurfaces).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(loadTuiSessionQuotaSurfaces).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(loadTuiSessionQuotaSurfaces).toHaveBeenCalledTimes(4);

    eventHandlers.get("session.updated")![0]!({ properties: { info: { id: "other" } } });
    await vi.advanceTimersByTimeAsync(600);
    expect(loadTuiSessionQuotaSurfaces).toHaveBeenCalledTimes(4);

    eventHandlers.get("session.updated")![0]!({ properties: { info: { id: "session-1" } } });
    await vi.advanceTimersByTimeAsync(149);
    expect(loadTuiSessionQuotaSurfaces).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(loadTuiSessionQuotaSurfaces).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(450);
    expect(loadTuiSessionQuotaSurfaces).toHaveBeenCalledTimes(6);

    await vi.advanceTimersByTimeAsync(54_800);
    expect(loadTuiSessionQuotaSurfaces).toHaveBeenCalledTimes(7);
  });

  it("coalesces in-flight session refreshes and accepts the active completion before its follow-up", async () => {
    const plugin = await loadTuiModule();
    const { api, registered } = createApi();
    const first = deferred<{
      sidebar: { status: "ready"; lines: string[] };
      compact: { status: "ready"; text: string };
    }>();
    const second = deferred<{
      sidebar: { status: "ready"; lines: string[] };
      compact: { status: "ready"; text: string };
    }>();
    loadTuiSessionQuotaSurfaces.mockReset();
    loadTuiSessionQuotaSurfaces
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "inline",
      sidebar: { enabled: true },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: false },
      homeBottom: false,
    });

    await startTui(plugin, api);
    const sidebar = registered[0]!.slots.sidebar_content;
    sidebar({}, { session_id: "session-1" });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(loadTuiSessionQuotaSurfaces).toHaveBeenCalledOnce();

    first.resolve({
      sidebar: { status: "ready", lines: ["initial"] },
      compact: { status: "ready", text: "initial" },
    });
    await flushPromises();
    expect(loadTuiSessionQuotaSurfaces).toHaveBeenCalledTimes(2);
    let rendered = sidebar({}, { session_id: "session-1" }) as any;
    expect(rendered.props.children[1].props.children[0].props.children).toBe("initial");

    second.resolve({
      sidebar: { status: "ready", lines: ["refreshed"] },
      compact: { status: "ready", text: "refreshed" },
    });
    await flushPromises();
    rendered = sidebar({}, { session_id: "session-1" });
    expect(rendered.props.children[1].props.children[0].props.children).toBe("refreshed");
  });

  it("keeps shared session resources alive until the final release and then disposes them", async () => {
    const plugin = await loadTuiModule();
    const { api, registered, unsubscribers } = createApi();
    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "inline",
      sidebar: { enabled: true },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: false },
      homeBottom: false,
    });

    await startTui(plugin, api);
    const sidebar = registered[0]!.slots.sidebar_content;
    sidebar({}, { session_id: "session-1" });
    sidebar({}, { session_id: "session-1" });
    await flushPromises();
    expect(loadTuiSessionQuotaSurfaces).toHaveBeenCalledOnce();

    cleanupFns.shift()!();
    expect(unsubscribers.every((unsubscribe) => !unsubscribe.mock.calls.length)).toBe(true);
    cleanupFns.shift()!();
    expect(unsubscribers).toHaveLength(4);
    expect(unsubscribers.every((unsubscribe) => unsubscribe.mock.calls.length === 1)).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(loadTuiSessionQuotaSurfaces).toHaveBeenCalledOnce();
  });

  it("keeps home free of mount recovery and exports only accepted refreshes", async () => {
    const plugin = await loadTuiModule();
    const { api, registered, eventHandlers } = createApi();
    const first = deferred<HomeBottomState>();
    const second = deferred<HomeBottomState>();
    loadTuiHomeBottomStatus.mockReset();
    loadTuiHomeBottomStatus.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "inline",
      sidebar: { enabled: false },
      compact: {
        enabled: true,
        homeBottom: true,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: false },
      homeBottom: true,
    });

    await startTui(plugin, api);
    registered.find((registration) => registration.order === 90)!.slots.home_bottom({}, {});
    await vi.advanceTimersByTimeAsync(4_000);
    expect(loadTuiHomeBottomStatus).toHaveBeenCalledOnce();

    eventHandlers.get("message.updated")![0]!({ properties: {} });
    await vi.advanceTimersByTimeAsync(600);
    expect(loadTuiHomeBottomStatus).toHaveBeenCalledOnce();

    first.resolve({
      status: "ready",
      compact: { status: "ready", text: "initial" },
    });
    await flushPromises();
    expect(loadTuiHomeBottomStatus).toHaveBeenCalledTimes(2);
    expect(writeTuiQuotaExportIfEnabled).toHaveBeenCalledOnce();

    second.resolve({
      status: "ready",
      compact: { status: "ready", text: "refreshed" },
    });
    await flushPromises();
    expect(writeTuiQuotaExportIfEnabled).toHaveBeenCalledTimes(2);
  });

  it("ignores rejected and disposed home completions without exporting", async () => {
    const plugin = await loadTuiModule();
    const rejected = createApi();
    loadTuiHomeBottomStatus.mockRejectedValueOnce(new Error("unavailable"));
    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "inline",
      sidebar: { enabled: false },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: true },
      homeBottom: true,
    });
    await startTui(plugin, rejected.api);
    rejected.registered
      .find((registration) => registration.order === 90)!
      .slots.home_bottom({}, {});
    await flushPromises();
    expect(writeTuiQuotaExportIfEnabled).not.toHaveBeenCalled();

    const disposed = createApi();
    const pending = deferred<HomeBottomState>();
    loadTuiHomeBottomStatus.mockReturnValueOnce(pending.promise);
    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "inline",
      sidebar: { enabled: false },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: true },
      homeBottom: true,
    });
    await startTui(plugin, disposed.api);
    disposed.registered
      .find((registration) => registration.order === 90)!
      .slots.home_bottom({}, {});
    cleanupFns.pop()!();
    pending.resolve({ status: "ready", compact: { status: "disabled" } });
    await flushPromises();
    expect(writeTuiQuotaExportIfEnabled).not.toHaveBeenCalled();
  });

  it("renders home compact status centered with a blank line above it", async () => {
    const plugin = await loadTuiModule();
    const { api, registered } = createApi();

    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "inline",
      sidebar: { enabled: false },
      compact: {
        enabled: true,
        homeBottom: true,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: true },
      homeBottom: true,
    });

    await startTui(plugin, api);

    const compactRegistration = registered.find((registration) => registration.order === 90);
    expect(compactRegistration).toBeDefined();

    const loading = compactRegistration!.slots.home_bottom({}, {}) as any;
    expect(loading).toMatchObject({
      type: "box",
      props: {
        children: [
          { type: "text", props: { children: " " } },
          null,
          {
            type: "box",
            props: {
              children: {
                type: "text",
                props: { children: "Quota loading…" },
              },
            },
          },
        ],
      },
    });

    await Promise.resolve();

    const rendered = compactRegistration!.slots.home_bottom({}, {}) as any;
    expect(rendered).toMatchObject({
      type: "box",
      props: {
        gap: 0,
        children: [
          {
            type: "text",
            props: { children: " " },
          },
          null,
          {
            type: "box",
            props: {
              flexDirection: "row",
              justifyContent: "center",
              children: {
                type: "text",
                props: {
                  fg: "muted",
                  wrapMode: "none",
                  children: "Home quota",
                },
              },
            },
          },
        ],
      },
    });
  });

  it("keeps announcement-only home host empty until a delayed announcement populates it", async () => {
    const plugin = await loadTuiModule();
    const { api, registered } = createApi();
    let resolveBottom!: (value: {
      status: "ready";
      announcementText: string;
      compact: { status: "disabled" };
    }) => void;
    loadTuiHomeBottomStatus.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveBottom = resolve;
      }),
    );
    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "inline",
      sidebar: { enabled: false },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: true },
      homeBottom: true,
    });

    await startTui(plugin, api);

    const homeBottom = registered.find((registration) => registration.order === 90)!.slots
      .home_bottom;
    const empty = homeBottom({}, {}) as any;
    expect(empty).toEqual({
      type: "box",
      props: { gap: 0, children: [null, null, null] },
    });

    resolveBottom({
      status: "ready",
      announcementText: "Notice: Maintainer announcement available. Run /quota_announcements.",
      compact: { status: "disabled" },
    });
    await Promise.resolve();

    const populated = homeBottom({}, {}) as any;
    expect(populated.type).toBe("box");
    expect(populated.props.children[0]).toMatchObject({
      type: "text",
      props: { children: " " },
    });
    expect(populated.props.children[1]).toMatchObject({
      type: "box",
      props: {
        children: {
          type: "text",
          props: {
            children: "Notice: Maintainer announcement available. Run /quota_announcements.",
          },
        },
      },
    });
    expect(populated.props.children[2]).toBeNull();
  });

  it("keeps export-only home host empty while still writing the export", async () => {
    const plugin = await loadTuiModule();
    const { api, registered } = createApi();
    loadTuiHomeBottomStatus.mockResolvedValueOnce({
      status: "disabled",
      compact: { status: "disabled" },
    });
    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "inline",
      sidebar: { enabled: false },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: false },
      homeBottom: true,
    });

    await startTui(plugin, api);

    const rendered = registered
      .find((registration) => registration.order === 90)!
      .slots.home_bottom({}, {}) as any;
    expect(rendered).toEqual({
      type: "box",
      props: { gap: 0, children: [null, null, null] },
    });
    await Promise.resolve();
    expect(writeTuiQuotaExportIfEnabled).toHaveBeenCalledOnce();
    expect(writeTuiQuotaExportIfEnabled).toHaveBeenCalledWith({ api });
  });

  it("wraps api.ui.Prompt and forwards session prompt props and ref exactly", async () => {
    const plugin = await loadTuiModule();
    const { api, registered } = createApi();
    const onSubmit = vi.fn();
    const ref = vi.fn();

    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "inline",
      sidebar: { enabled: true },
      compact: {
        enabled: true,
        homeBottom: false,
        sessionPrompt: true,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },

      announcements: { homeBottom: false },
      homeBottom: false,
    });

    loadTuiSessionQuotaSurfaces.mockResolvedValueOnce({
      sidebar: { status: "disabled", lines: [] },
      compact: { status: "disabled" },
      promptBar: {
        status: "ready",
        entry: {
          name: "Copilot 5h",
          percentRemaining: 50,
          resetTimeIso: "2099-01-01T00:00:00.000Z",
        },
        percentDisplayMode: "remaining",
      },
    });

    await startTui(plugin, api);

    const compactRegistration = registered.find((registration) => registration.order === 90);
    expect(compactRegistration).toBeDefined();

    const promptProps = {
      session_id: "session-1",
      visible: false,
      disabled: true,
      on_submit: onSubmit,
      ref,
    };
    compactRegistration!.slots.session_prompt({}, promptProps);
    await flushPromises();
    const rendered = compactRegistration!.slots.session_prompt({}, promptProps) as any;

    const hint = rendered.props.children[1];
    expect(hint.type).toBe("box");
    expect(hint.props).toMatchObject({
      flexDirection: "row",
      justifyContent: "flex-end",
      gap: 1,
    });
    expect(hint.props).not.toHaveProperty("position");
    expect(hint.props).not.toHaveProperty("left");
    expect(hint.props).not.toHaveProperty("bottom");
    expect(hint.props.children[1].props.children).toHaveLength(12);
    expect(hint.props.children[2].props.children).toContain(" | ");
    expect(hint.props.children[2].props.children).not.toContain("·");

    expect(api.ui.Prompt).toHaveBeenCalledTimes(2);
    expect(api.ui.Prompt).toHaveBeenCalledWith({
      sessionID: "session-1",
      visible: false,
      disabled: true,
      onSubmit,
      ref,
    });
  });

  it("renders a structured prompt-bar value without percentage bar cells", async () => {
    const plugin = await loadTuiModule();
    const { api, registered } = createApi();

    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      commandDisplay: "inline",
      sidebar: { enabled: false },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
      promptBar: { enabled: true },
      announcements: { homeBottom: false },
      homeBottom: false,
    });
    loadTuiSessionQuotaSurfaces.mockResolvedValueOnce({
      sidebar: { status: "disabled", lines: [] },
      compact: { status: "disabled" },
      promptBar: {
        status: "ready",
        entry: { semanticSegment: "Cursor: Known API spend USD 12.50" },
        percentDisplayMode: "remaining",
      },
    });

    await startTui(plugin, api);
    const registration = registered.find((item) => item.order === 90)!;
    registration.slots.session_prompt({}, { session_id: "session-rich" });
    await flushPromises();
    const rendered = registration.slots.session_prompt({}, { session_id: "session-rich" }) as any;
    const hint = rendered.props.children[1];

    expect(hint.props.children[0].props.children).toBe("Cursor: Known API spend USD 12.50");
    expect(JSON.stringify(hint)).not.toMatch(/[█░▓▒]/u);
  });
});
