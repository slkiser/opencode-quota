import { beforeEach, describe, expect, it, vi } from "vitest";

const pluginMocks = vi.hoisted(() => ({
  QuotaToastPlugin: vi.fn(),
}));

vi.mock("../src/plugin.js", () => ({
  QuotaToastPlugin: pluginMocks.QuotaToastPlugin,
}));

describe("package entrypoint", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("exports the V1 plugin module shape on the default export", async () => {
    const mod = await import("../src/index.js");

    expect(mod.default).toEqual({
      id: "@slkiser/opencode-quota",
      server: pluginMocks.QuotaToastPlugin,
    });
    expect(mod.QuotaToastPlugin).toBe(pluginMocks.QuotaToastPlugin);
  });
});
