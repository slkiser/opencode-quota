import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("solid-js", () => ({
  Show: (props: { children?: unknown }) => props.children,
  Index: (props: { children?: unknown }) => props.children,
  createEffect: vi.fn(),
  createSignal: <T>(value: T) => [() => value, vi.fn()],
  onCleanup: vi.fn(),
}));

vi.mock("@opentui/solid", () => ({
  createComponent: (component: (props: unknown) => unknown, props: unknown) => component(props),
  createElement: vi.fn(),
  createTextNode: vi.fn(),
  effect: vi.fn(),
  insert: vi.fn(),
  insertNode: vi.fn(),
  memo: (fn: () => unknown) => fn,
  setProp: vi.fn(),
}));

vi.mock("@opentui/solid/preload", () => ({}));

const packagedTui = await import("../dist/tui.js");

describe("tui dist packaging", () => {
  it("loads the conventional root TUI entrypoint as the existing local plugin", async () => {
    const [local, source] = await Promise.all([import("../tui.js"), import("../src/tui/index.js")]);

    expect(local.default).toBe(source.default);
    expect(local.default).toMatchObject({ id: "slkiser.opencode-quota" });
    expect(typeof local.default.setup).toBe("function");
  });

  it("ships the precompiled TUI entry without jsx artifacts", async () => {
    const distDir = fileURLToPath(new URL("../dist/", import.meta.url));
    const jsxFiles = (await readdir(distDir, { recursive: true })).filter((file) =>
      /\.jsx(?:\.map)?$/.test(file),
    );
    expect(jsxFiles).toEqual([]);

    // dist/tui.js only re-exports the compiled TUI entry.
    expect(await readFile(new URL("../dist/tui.js", import.meta.url), "utf8")).toBe(
      'export { default } from "./tui/index.js";\n',
    );
    const read = (file: string) =>
      readFile(new URL(`../dist/tui/${file}`, import.meta.url), "utf8");
    const source = await read("index.js");
    expect(source).toContain("createComponent");
    expect(source).toContain("sidebar.content");
    expect(source).toContain("prompt.footer");
    expect(source).toContain("home.footer.status");
    expect(source).toContain("session.composer.top");
    expect(source).toContain('bind: "return"');
    expect(source).not.toContain("jsx-dev-runtime");
    // Every surface reads the server's snapshot over the quota RPC.
    const client = await read("client.js");
    expect(client).toContain("../rpc.js");
    expect(client).toContain("client.rpc(");
    expect(client).toContain('"changed"');
  });

  it("can load the packaged TUI module", () => {
    expect(packagedTui.default).toMatchObject({
      id: "slkiser.opencode-quota",
    });
    // OpenCode refuses plugin storage for an id that is not one file-name segment.
    expect(packagedTui.default.id).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
    expect(typeof packagedTui.default.setup).toBe("function");
  });

  it("can load the packaged root module", async () => {
    const mod = await import("../dist/index.js");

    expect(mod.default).toMatchObject({
      id: "@slkiser/opencode-quota.server",
    });
    expect(typeof mod.default.setup).toBe("function");
  });
});
