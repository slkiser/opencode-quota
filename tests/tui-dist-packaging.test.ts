import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("solid-js", () => ({
  createSignal: <T>(value: T) => [() => value, vi.fn()],
  onCleanup: vi.fn(),
}));

vi.mock("react/jsx-runtime", () => ({
  Fragment: Symbol.for("Fragment"),
  jsx: vi.fn(),
  jsxs: vi.fn(),
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
  it("ships the raw tsx TUI entry and removes the jsx artifacts", async () => {
    const distTui = new URL("../dist/tui.tsx", import.meta.url);
    const distJsx = new URL("../dist/tui.jsx", import.meta.url);
    const distJsxMap = new URL("../dist/tui.jsx.map", import.meta.url);

    expect(await exists(distTui)).toBe(true);
    expect(await exists(distJsx)).toBe(false);
    expect(await exists(distJsxMap)).toBe(false);

    const source = await readFile(distTui, "utf8");
    expect(source).toContain("sidebar_content");
    expect(source).toContain("loadTuiSessionQuotaSurfaces");
    expect(source).toContain("resolveTuiSurfaceRegistration");
    expect(source).toContain("const pluginModule");
  });

  it("can load the packaged TUI module", async () => {
    const mod = await import("../dist/tui.tsx");

    expect(mod.default).toMatchObject({
      id: "@thanhndv212/token-watcher",
    });
    expect(typeof mod.default.tui).toBe("function");
  });
});
