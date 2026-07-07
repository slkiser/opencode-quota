import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("solid-js", () => ({
  Show: (props: { children?: unknown }) => props.children,
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

async function exists(url: URL): Promise<boolean> {
  try {
    await access(fileURLToPath(url));
    return true;
  } catch {
    return false;
  }
}

describe("tui dist packaging", () => {
  it("ships the precompiled TUI entry and removes stale jsx artifacts", async () => {
    const distTui = new URL("../dist/tui.js", import.meta.url);
    const distJsx = new URL("../dist/tui.jsx", import.meta.url);
    const distJsxMap = new URL("../dist/tui.jsx.map", import.meta.url);

    expect(await exists(distTui)).toBe(true);
    expect(await exists(distJsx)).toBe(false);
    expect(await exists(distJsxMap)).toBe(false);

    const source = await readFile(distTui, "utf8");
    expect(source).toContain("createComponent");
    expect(source).toContain("sidebar_content");
    expect(source).toContain("loadTuiSessionQuotaSurfaces");
    expect(source).toContain("resolveTuiSurfaceRegistration");
    expect(source).toContain("const pluginModule");
    expect(source).not.toContain("jsx-dev-runtime");
  });

  it("can load the packaged TUI module", async () => {
    const mod = await import("../dist/tui.js");

    expect(mod.default).toMatchObject({
      id: "@slkiser/opencode-quota",
    });
    expect(typeof mod.default.tui).toBe("function");
  });
});
