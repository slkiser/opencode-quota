import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { compileFunction } from "node:vm";
import * as gui from "@opencode/plugin/gui";
import { describe, expect, it, vi } from "vite-plus/test";

type Command = { id: string; title: string; run: () => void };
type Definition = {
  i18n: { en: Record<string, string> };
  setup: (ctx: unknown) => (() => void) | void;
};

const requireModule = createRequire(import.meta.url);

/**
 * Loads the built `dist/gui-experimental.cjs` (run after `pnpm build`) as the OpenCode app does:
 * one CommonJS file whose `require` finds only the modules the app provides.
 */
async function loadGui(
  replaced: Record<string, unknown> = {},
): Promise<{ definition: Definition; required: string[] }> {
  const source = await readFile(new URL("../dist/gui-experimental.cjs", import.meta.url), "utf8");
  const provided: Record<string, unknown> = {
    "@opencode/plugin/gui": gui,
    "solid-js": requireModule("solid-js"),
    // Solid makes its templates and delegates its events when the file loads; the rest only
    // renders, and no test renders.
    "solid-js/web": { template: () => () => null, delegateEvents: () => {} },
    ...replaced,
  };
  const required: string[] = [];
  const appRequire = (id: string) => {
    required.push(id);
    if (!Object.hasOwn(provided, id)) throw new Error(`the app does not provide ${id}`);
    return provided[id];
  };
  const module = { exports: {} as { default?: Definition } };
  compileFunction(source, ["exports", "require", "module"])(module.exports, appRequire, module);
  if (!module.exports.default) throw new Error("the bundle has no default export");
  return { definition: module.exports.default, required };
}

function fakeWindow() {
  const rpc = {
    snapshot: vi.fn(),
    refresh: vi.fn(),
    notices: vi.fn(),
    events: { on: vi.fn(() => () => {}) },
  };
  const added: Array<{ registry: unknown; item: unknown }> = [];
  const ctx = {
    client: { rpc: () => rpc },
    sessions: { current: () => undefined },
    add: (registry: unknown, item: unknown) => {
      added.push({ registry, item });
      return () => {};
    },
    t: (key: string) => key,
    dialogs: { open: vi.fn() },
  };
  return { ctx, rpc, added };
}

describe("GUI bundle (dist/gui-experimental.cjs)", () => {
  it("needs only modules the OpenCode app provides", async () => {
    const { required } = await loadGui();
    expect(required.sort()).toEqual(["@opencode/plugin/gui", "solid-js", "solid-js/web"]);
  });

  it("adds its CSS, a Quota command whose run opens a dialog, and the always-on surfaces", async () => {
    const { definition } = await loadGui();
    expect(definition.i18n.en["command.quota"]).toBe("Quota");
    const { ctx, rpc, added } = fakeWindow();

    const cleanup = definition.setup(ctx);

    expect(added.map((entry) => entry.registry)).toEqual([
      gui.Style,
      gui.Command,
      gui.Panel,
      gui.MenuItem,
      gui.TitlebarItem,
      gui.ComposerPill,
      gui.Slot,
      gui.Slot,
    ]);
    expect(added.slice(6).map((entry) => (entry.item as { at: string }).at)).toEqual([
      "window.bottom",
      "session.location.menu",
    ]);
    expect(added[0]?.item).toEqual(expect.stringContaining(".oq-window"));
    const command = (added[1]?.item as (() => Command) | undefined)?.();
    expect(command).toMatchObject({ id: "quota", title: "command.quota" });
    expect(rpc.snapshot).not.toHaveBeenCalled();
    command?.run();
    expect(ctx.dialogs.open).toHaveBeenCalledWith(expect.any(Function));
    // The surfaces watch the folder on screen from effects, which run once the app mounts.
    expect(cleanup).toBeUndefined();
  });

  it("pins the Quota tab in every session's strip, opened there or not", async () => {
    const { definition } = await loadGui();
    const { ctx, added } = fakeWindow();
    definition.setup(ctx);
    const panel = added[2]?.item as {
      list: (input: { session: unknown; open: readonly string[] }) => unknown[];
    };
    const session = (id: string) => ({ id, directory: `/${id}`, server: { builtin: true } });

    for (const id of ["first", "second"]) {
      expect(panel.list({ session: session(id), open: [] })).toEqual([
        expect.objectContaining({ id: "quota", pinned: true }),
      ]);
    }
  });

  it("leaves out a surface whose registry this OpenCode lacks", async () => {
    const { ctx, added } = fakeWindow();
    const older = { ...gui, ComposerPill: undefined, TitlebarItem: undefined };
    const { definition } = await loadGui({ "@opencode/plugin/gui": older });

    definition.setup(ctx);

    expect(added.map((entry) => entry.registry)).toEqual([
      gui.Style,
      gui.Command,
      gui.Panel,
      gui.MenuItem,
      gui.Slot,
      gui.Slot,
    ]);
  });
});
