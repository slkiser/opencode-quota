import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

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

async function exists(url: URL): Promise<boolean> {
  try {
    await access(fileURLToPath(url));
    return true;
  } catch {
    return false;
  }
}

const packagedTui = await import("../dist/tui.js");

describe("tui dist packaging", () => {
  it("loads the conventional root TUI entrypoint as the existing local plugin", async () => {
    const [local, source] = await Promise.all([import("../tui.js"), import("../src/tui-v2.js")]);

    expect(local.default).toBe(source.default);
    expect(local.default).toMatchObject({ id: "@slkiser/opencode-quota" });
    expect(typeof local.default.setup).toBe("function");
  });

  it("ships the precompiled TUI entry and removes stale jsx artifacts", async () => {
    const distTui = new URL("../dist/tui.js", import.meta.url);
    const distJsx = new URL("../dist/tui.jsx", import.meta.url);
    const distJsxMap = new URL("../dist/tui.jsx.map", import.meta.url);

    expect(await exists(distTui)).toBe(true);
    expect(await exists(distJsx)).toBe(false);
    expect(await exists(distJsxMap)).toBe(false);

    const source = await readFile(distTui, "utf8");
    expect(source).toContain("createComponent");
    expect(source).toContain("sidebar.content");
    expect(source).toContain("prompt.footer");
    expect(source).toContain("home.footer.status");
    expect(source).toContain("buildCompactQuotaStatusLine");
    expect(source).toContain("buildQuotaDialogCommandOutput");
    expect(source).toContain("registerQuotaCommands");
    expect(source).not.toContain("jsx-dev-runtime");
  });

  it("can load the packaged TUI module", () => {
    expect(packagedTui.default).toMatchObject({
      id: "@slkiser/opencode-quota",
    });
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
