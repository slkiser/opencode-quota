import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const moduleMocks = vi.hoisted(() => ({
  resolveImpl: vi.fn<(specifier: string) => string>(),
}));

vi.mock("node:module", () => ({
  createRequire: () => ({
    resolve: moduleMocks.resolveImpl,
  }),
}));

describe("google antigravity companion resolution", () => {
  let tempDir: string;

  beforeEach(() => {
    vi.resetModules();
    moduleMocks.resolveImpl.mockReset();
    tempDir = mkdtempSync(join(tmpdir(), "opencode-quota-antigravity-companion-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reports missing when the companion package cannot be resolved", async () => {
    moduleMocks.resolveImpl.mockImplementation(() => {
      const error = new Error("Cannot find module");
      (error as Error & { code?: string }).code = "MODULE_NOT_FOUND";
      throw error;
    });

    const mod = await import("../src/lib/google-antigravity-companion.js");

    await expect(mod.inspectAntigravityCompanionPresence()).resolves.toMatchObject({
      state: "missing",
    });
    await expect(mod.resolveAntigravityClientCredentials()).resolves.toMatchObject({
      state: "missing",
    });
  });

  it("reports invalid when the resolved module does not export usable credentials", async () => {
    const invalidModulePath = join(tempDir, "constants-invalid.mjs");
    writeFileSync(invalidModulePath, "export const ANTIGRAVITY_CLIENT_ID = '';\n", "utf8");
    moduleMocks.resolveImpl.mockReturnValue(invalidModulePath);

    const mod = await import("../src/lib/google-antigravity-companion.js");

    await expect(mod.inspectAntigravityCompanionPresence()).resolves.toMatchObject({
      state: "invalid",
      resolvedPath: invalidModulePath,
    });
    await expect(mod.resolveAntigravityClientCredentials()).resolves.toMatchObject({
      state: "invalid",
      resolvedPath: invalidModulePath,
    });
  });

  it("returns configured credentials when the companion module exports both values", async () => {
    const validModulePath = join(tempDir, "constants-valid.mjs");
    writeFileSync(
      validModulePath,
      [
        "export const ANTIGRAVITY_CLIENT_ID = 'client-id';",
        "export const ANTIGRAVITY_CLIENT_SECRET = 'client-secret';",
      ].join("\n"),
      "utf8",
    );
    moduleMocks.resolveImpl.mockReturnValue(validModulePath);

    const mod = await import("../src/lib/google-antigravity-companion.js");

    await expect(mod.inspectAntigravityCompanionPresence()).resolves.toMatchObject({
      state: "present",
      resolvedPath: validModulePath,
    });
    await expect(mod.resolveAntigravityClientCredentials()).resolves.toMatchObject({
      state: "configured",
      clientId: "client-id",
      clientSecret: "client-secret",
      resolvedPath: validModulePath,
    });
  });
});
