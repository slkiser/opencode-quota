/**
 * A fake OpenCode TUI host: the parts of OpenCode's TUI context the quota TUI uses (slots,
 * keymap layers, dialogs, toasts, plugin storage, the renderer and which renderable has the
 * keyboard). A test draws a slot and presses keys on the TUI's named layers; a press on a layer
 * or key that does not exist throws, so a renamed or renumbered layer fails loudly.
 */
import { createRoot } from "solid-js";
import { vi } from "vite-plus/test";
import { KEY_LAYERS, type KeyLayerName } from "../../src/tui/key-layers.js";

export type KeyCommand = {
  id?: string;
  bind?: string;
  title?: string;
  group?: string;
  palette?: boolean;
  slash?: { name: string };
  run: () => unknown;
};
export type KeyLayer = {
  mode?: string;
  priority?: number;
  target?: () => unknown;
  enabled?: () => boolean;
  commands: KeyCommand[];
};
export type Route = { type: "home" } | { type: "session"; sessionID: string };
type Listener = (event: { data: Record<string, unknown> }) => void;
type SlotRender = (props?: { sessionID?: string }) => unknown;

/** A renderable that can have the keyboard; focusing one blurs the last one, as in OpenTUI. */
export type FakeBox = {
  isDestroyed: boolean;
  focused: boolean;
  on(event: string, listener: () => void): void;
  focus(): void;
  blur(): void;
  destroy(): void;
  scrollTo(): void;
  scrollBy(): void;
  scrollChildIntoView(): void;
};

export type FakeTuiHostOptions = {
  /**
   * What `client.rpc(QuotaRpc)` returns, or a function that answers that call (a bridge to the
   * server plugin, `createQuotaRpcBridge`).
   */
  rpc?: unknown;
  route?: Route;
  /** OpenCode's version, as `app.version`; absent on versions without it. */
  version?: string;
  /** OpenCode's `client.session.command`, which runs a server slash command. */
  sessionCommand?: (input: { sessionID: string; name: string; text: string }) => unknown;
  /** OpenCode draws the app slot inside a Solid owner, where colored toasts can be made. */
  appOwner?: boolean;
  theme?: unknown;
  width?: number;
};

export type FakeTuiHost = ReturnType<typeof createFakeTuiHost>;

export function createFakeTuiHost(options: FakeTuiHostOptions = {}) {
  const keyboard: { current?: FakeBox } = {};
  const layers: KeyLayer[] = [];
  const listeners = new Map<string, Listener>();
  const renderers = new Map<string, SlotRender>();
  const resizeListeners: Array<() => void> = [];
  const copied: string[] = [];
  /** OpenCode's plugin storage: one live object per key. */
  const stored = new Map<string, any>();
  let renderApp: () => unknown = () => null;

  /** A new renderable; `node` gives a JSX node the renderable's methods. */
  function box<Node extends object>(node?: Node): FakeBox & Node {
    const boxListeners = new Map<string, Array<() => void>>();
    const emit = (event: string) => {
      for (const listener of boxListeners.get(event) ?? []) listener();
    };
    const self = (node ?? {}) as FakeBox & Node;
    Object.assign(self, {
      isDestroyed: false,
      focused: false,
      on: (event: string, listener: () => void) =>
        boxListeners.set(event, [...(boxListeners.get(event) ?? []), listener]),
      focus() {
        if (self.isDestroyed || self.focused) return;
        self.focused = true;
        const previous = keyboard.current;
        keyboard.current = self;
        previous?.blur();
        emit("focused");
      },
      blur() {
        if (!self.focused) return;
        if (keyboard.current === self) keyboard.current = undefined;
        self.focused = false;
        emit("blurred");
      },
      // OpenTUI marks a renderable destroyed, then blurs it.
      destroy() {
        self.isDestroyed = true;
        self.blur();
      },
      scrollTo: () => {},
      scrollBy: () => {},
      scrollChildIntoView: () => {},
    } satisfies FakeBox);
    return self;
  }

  const editor = { plainText: "", clear: vi.fn() };
  const renderer = {
    width: options.width ?? 120,
    currentFocusedEditor: null as typeof editor | null,
    root: { on: () => {}, off: () => {} },
    on: (_event: "resize", listener: () => void) => resizeListeners.push(listener),
    off: (_event: "resize", listener: () => void) =>
      resizeListeners.splice(resizeListeners.indexOf(listener), 1),
    get currentFocusedRenderable() {
      return keyboard.current ?? null;
    },
    copyToClipboardOSC52: (text: string) => {
      copied.push(text);
      return true;
    },
  };
  const dialog = { show: vi.fn(), clear: vi.fn(), prompt: vi.fn(), set: vi.fn() };
  const context = {
    ...(options.version ? { app: { version: options.version, channel: "latest" } } : {}),
    location: { directory: process.cwd() },
    theme: options.theme,
    renderer,
    client: {
      rpc: vi.fn(
        typeof options.rpc === "function"
          ? (options.rpc as (definition: unknown) => unknown)
          : () => options.rpc,
      ),
      ...(options.sessionCommand ? { session: { command: options.sessionCommand } } : {}),
    },
    storage: {
      store: vi.fn((key: string, store: { initial: unknown }) => {
        if (!stored.has(key)) stored.set(key, structuredClone(store.initial));
        const value = stored.get(key);
        return [value, async (mutation: (draft: any) => void) => mutation(value)];
      }),
    },
    data: {
      session: { get: vi.fn((_sessionID: string): { parentID?: string } | undefined => ({})) },
      location: { default: () => ({ directory: process.cwd() }) },
      on: vi.fn((name: string, listener: Listener) => {
        listeners.set(name, listener);
        return vi.fn(() => listeners.delete(name));
      }),
    },
    keymap: {
      layer: vi.fn((build: () => KeyLayer) => {
        layers.push(build());
      }),
      dispatch: vi.fn(),
    },
    ui: {
      slot: vi.fn((claim: { append: string; render: SlotRender }) => {
        renderers.set(claim.append, claim.render);
        if (claim.append === "app") {
          renderApp = options.appOwner ? () => createRoot(() => claim.render()) : claim.render;
          renderApp();
        }
        return vi.fn();
      }),
      toast: { show: vi.fn() },
      router: { current: () => options.route ?? { type: "home" } },
      dialog,
    },
  };

  /** The newest layer named `name`. */
  function layer(name: KeyLayerName): KeyLayer {
    const found = layers.filter((item) => item.priority === KEY_LAYERS[name]).at(-1);
    if (!found) throw new Error(`no "${name}" key layer is registered`);
    return found;
  }

  function runKey(found: KeyLayer, where: string, bind: string): unknown {
    const key = found.commands.find((command) => command.bind === bind);
    if (!key) throw new Error(`the ${where} key layer has no "${bind}" key`);
    return key.run();
  }

  /** The palette commands of the newest mount. */
  function commands(): KeyCommand[] {
    return layers.filter((item) => item.mode === "global").at(-1)?.commands ?? [];
  }

  return {
    context,
    layers,
    listeners,
    editor,
    dialog,
    stored,
    copied,
    keyboard,
    resizeListeners,
    toast: context.ui.toast.show,
    dispatch: context.keymap.dispatch,
    sessionGet: context.data.session.get,
    box,
    layer,
    /** Presses `bind` on the newest layer named `name`, and gives back what the key returns. */
    press: (name: KeyLayerName, bind: string): unknown => runKey(layer(name), name, bind),
    commands,
    /** The palette command `quota.<id>`. */
    command(id: string): KeyCommand {
      const found = commands().find((item) => item.id === `quota.${id}`);
      if (!found) throw new Error(`no palette command quota.${id}`);
      return found;
    },
    /** Types `text` in the message box and presses Enter; gives back what the Enter key returns. */
    typed(text: string): unknown {
      editor.plainText = text;
      renderer.currentFocusedEditor = editor;
      return runKey(layer("typedCommand"), "typedCommand", "return");
    },
    /** Draws `slot` as OpenCode does. */
    render: (slot: string, props?: { sessionID?: string }) => {
      const render = renderers.get(slot);
      if (!render) throw new Error(`nothing claimed the ${slot} slot`);
      return render(props);
    },
    /** OpenCode mounts the "app" slot again, for example after it reconnects to its server. */
    mountAppAgain: () => renderApp(),
    emit: (name: string, data: Record<string, unknown>) => listeners.get(name)?.({ data }),
    /** The terminal changes size: OpenTUI calls every resize listener, in the order they came. */
    resize() {
      for (const listener of resizeListeners.slice()) listener();
    },
  };
}

/**
 * JSX as plain `{ type, props }` nodes, through a stubbed `React.createElement`. Function
 * components run unless `components` is "keep". With `renderables`, every node is also one of
 * that host's renderables: a `ref` gets it (an `<input>` excepted: a test hands an input its own
 * renderable) and `focused` gives it the keyboard.
 */
export function stubJsx(
  options: { components?: "call" | "keep"; renderables?: FakeTuiHost } = {},
): void {
  vi.stubGlobal("React", {
    createElement: (
      type: unknown,
      props: Record<string, unknown> | null,
      ...children: unknown[]
    ) => {
      const all = { ...props, children: children.length > 1 ? children : children[0] };
      if (typeof type === "function" && options.components !== "keep") return type(all);
      const host = options.renderables;
      if (!host) return { type, props: all };
      const node = host.box({ type, props: all });
      if (typeof all.ref === "function" && type !== "input") all.ref(node);
      if (all.focused === true) node.focus();
      return node;
    },
  });
}
