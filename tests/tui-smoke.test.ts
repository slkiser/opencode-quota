import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  cleanupFns,
  loadTuiHomeCompactStatus,
  loadTuiSessionQuotaSurfaces,
  resolveTuiSurfaceRegistration,
} = vi.hoisted(() => ({
  cleanupFns: [] as Array<() => void>,
  loadTuiHomeCompactStatus: vi.fn(),
  loadTuiSessionQuotaSurfaces: vi.fn(),
  resolveTuiSurfaceRegistration: vi.fn(),
}));

vi.mock("../src/lib/tui-runtime.js", () => ({
  loadTuiHomeCompactStatus,
  loadTuiSessionQuotaSurfaces,
  resolveTuiSurfaceRegistration,
}));

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
  const registered: Array<{
    order?: number;
    slots: Record<string, (ctx: unknown, props: any) => unknown>;
  }> = [];
  const unsubscribers: Array<() => void> = [];
  const kvStore = new Map<string, unknown>();
  const api = {
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
    },
    event: {
      on: vi.fn(() => {
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
    client: {},
  };

  return { api, registered, unsubscribers, kvStore };
}

async function loadTuiModule() {
  const mod = await import("../src/tui.tsx");
  return mod.default;
}

describe("tui plugin smoke", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as any).React = { createElement };
    cleanupFns.length = 0;
    loadTuiHomeCompactStatus.mockReset();
    loadTuiHomeCompactStatus.mockResolvedValue({ status: "ready", text: "Home quota" });
    loadTuiSessionQuotaSurfaces.mockReset();
    loadTuiSessionQuotaSurfaces.mockResolvedValue({
      sidebar: { status: "ready", lines: ["Sidebar quota"] },
      compact: { status: "ready", text: "Session quota" },
    });
    resolveTuiSurfaceRegistration.mockReset();
  });

  afterEach(() => {
    for (const cleanup of cleanupFns.splice(0)) cleanup();
    vi.clearAllTimers();
    delete (globalThis as any).React;
    vi.useRealTimers();
  });

  it("registers sidebar_content and compact slots independently", async () => {
    const plugin = await loadTuiModule();
    const sidebarOnly = createApi();

    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      sidebar: { enabled: true },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
    });

    await plugin.tui(sidebarOnly.api as any, undefined, {} as any);

    expect(sidebarOnly.registered).toHaveLength(1);
    expect(sidebarOnly.registered[0].order).toBe(150);
    expect(Object.keys(sidebarOnly.registered[0].slots)).toEqual(["sidebar_content"]);

    const compactOnly = createApi();
    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      sidebar: { enabled: false },
      compact: {
        enabled: true,
        homeBottom: true,
        sessionPrompt: true,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
    });

    await plugin.tui(compactOnly.api as any, undefined, {} as any);

    expect(compactOnly.registered).toHaveLength(1);
    expect(compactOnly.registered[0].order).toBe(90);
    expect(Object.keys(compactOnly.registered[0].slots)).toEqual(["session_prompt", "home_bottom"]);

    const enabled = createApi();
    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      sidebar: { enabled: true },
      compact: {
        enabled: true,
        homeBottom: true,
        sessionPrompt: true,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
    });

    await plugin.tui(enabled.api as any, undefined, {} as any);

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
        lines: ["Copilot 5h 82%"],
        linesExpanded: ["[Copilot]", "5h window 82%", "Weekly window 58%"],
        providerCount: 2,
      },
      compact: { status: "ready", text: "Session quota" },
    });
    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      sidebar: { enabled: true },
      compact: {
        enabled: false,
        homeBottom: false,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
    });

    await plugin.tui(api as any, undefined, {} as any);

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
    expect(collapsed.props.children[1].props.children[0].props.children).toBe("Copilot 5h 82%");

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
    ).toEqual(["[Copilot]", "5h window 82%", "Weekly window 58%"]);
  });

  it("falls back to sidebar-only registration when surface resolution fails", async () => {
    const plugin = await loadTuiModule();
    const fallback = createApi();

    resolveTuiSurfaceRegistration.mockRejectedValueOnce(new Error("config unavailable"));

    await plugin.tui(fallback.api as any, undefined, {} as any);

    expect(fallback.registered).toHaveLength(1);
    expect(fallback.registered[0].order).toBe(150);
    expect(Object.keys(fallback.registered[0].slots)).toEqual(["sidebar_content"]);
  });

  it("does not register right-side compact slots", async () => {
    const plugin = await loadTuiModule();
    const { api, registered } = createApi();

    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      sidebar: { enabled: true },
      compact: {
        enabled: true,
        homeBottom: true,
        sessionPrompt: true,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
    });

    await plugin.tui(api as any, undefined, {} as any);

    const slotNames = registered.flatMap((registration) => Object.keys(registration.slots));
    expect(slotNames).toContain("session_prompt");
    expect(slotNames).toContain("home_bottom");
    expect(slotNames).not.toContain("session_prompt_right");
    expect(slotNames).not.toContain("home_prompt_right");
  });

  it("renders home compact status centered with a blank line above it", async () => {
    const plugin = await loadTuiModule();
    const { api, registered } = createApi();

    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      sidebar: { enabled: false },
      compact: {
        enabled: true,
        homeBottom: true,
        sessionPrompt: false,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
    });

    await plugin.tui(api as any, undefined, {} as any);

    const compactRegistration = registered.find((registration) => registration.order === 90);
    expect(compactRegistration).toBeDefined();

    compactRegistration!.slots.home_bottom({}, {});
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

  it("wraps api.ui.Prompt and forwards session prompt props and ref exactly", async () => {
    const plugin = await loadTuiModule();
    const { api, registered } = createApi();
    const onSubmit = vi.fn();
    const ref = vi.fn();

    resolveTuiSurfaceRegistration.mockResolvedValueOnce({
      sidebar: { enabled: true },
      compact: {
        enabled: true,
        homeBottom: false,
        sessionPrompt: true,
        hasNativeProviderQuota: false,
        suppressedByNativeProviderQuota: false,
      },
    });

    await plugin.tui(api as any, undefined, {} as any);

    const compactRegistration = registered.find((registration) => registration.order === 90);
    expect(compactRegistration).toBeDefined();

    compactRegistration!.slots.session_prompt(
      {},
      {
        session_id: "session-1",
        visible: false,
        disabled: true,
        on_submit: onSubmit,
        ref,
      },
    );

    expect(api.ui.Prompt).toHaveBeenCalledTimes(1);
    expect(api.ui.Prompt).toHaveBeenCalledWith({
      sessionID: "session-1",
      visible: false,
      disabled: true,
      onSubmit,
      ref,
    });
  });
});
