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
async function loadGui(): Promise<{ definition: Definition; required: string[] }> {
  const source = await readFile(new URL("../dist/gui-experimental.cjs", import.meta.url), "utf8");
  const provided: Record<string, unknown> = {
    "@opencode/plugin/gui": gui,
    "solid-js": requireModule("solid-js"),
    // Solid makes its templates when the file loads; the rest only renders, and no test renders.
    "solid-js/web": { template: () => () => null },
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
  const added: Array<{ registry: unknown; item: () => Command }> = [];
  const ctx = {
    client: { rpc: () => rpc },
    sessions: { current: () => undefined },
    add: (registry: unknown, item: () => Command) => {
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

  it("adds a Quota command whose run opens a dialog, and asks the server nothing before", async () => {
    const { definition } = await loadGui();
    expect(definition.i18n.en["command.quota"]).toBe("Quota");
    const { ctx, rpc, added } = fakeWindow();

    const cleanup = definition.setup(ctx);

    expect(added).toHaveLength(1);
    expect(added[0]?.registry).toBe(gui.Command);
    const command = added[0]?.item();
    expect(command).toMatchObject({ id: "quota", title: "command.quota" });
    expect(rpc.snapshot).not.toHaveBeenCalled();
    command?.run();
    expect(ctx.dialogs.open).toHaveBeenCalledWith(expect.any(Function));
    // Only an open dialog asks the server, and it stops when it closes: setup leaves nothing running.
    expect(cleanup).toBeUndefined();
  });
});
