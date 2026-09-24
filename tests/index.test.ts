import { describe, expect, it, vi } from "vitest";

const pluginMocks = vi.hoisted(() => ({
  tui: {
    id: "@slkiser/opencode-quota",
    setup: vi.fn(),
  },
}));

vi.mock("../src/plugin.js", () => ({
  default: pluginMocks.tui,
}));

vi.mock("@opentui/solid/preload", () => ({}));

describe("package entrypoint", () => {
  it("exports the V2 server plugin on the default export", async () => {
    const mod = await import("../src/index.js");

    expect(mod.default).toBe(pluginMocks.tui);
  });
});
