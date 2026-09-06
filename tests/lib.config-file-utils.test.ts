import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  getEffectiveConfigRoot,
  resolveRuntimeContextRoots,
} from "../src/lib/config-file-utils.js";

const PROJECT_ROOT = resolve("home", "user", "project");
const WORKSPACE_ROOT = resolve("work", "repo");
const FALLBACK_DIRECTORY = resolve(WORKSPACE_ROOT, "packages", "app");

describe("getEffectiveConfigRoot", () => {
  const original = process.env.OPENCODE_CONFIG_DIR;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.OPENCODE_CONFIG_DIR;
    } else {
      process.env.OPENCODE_CONFIG_DIR = original;
    }
  });

  it("returns fallback when OPENCODE_CONFIG_DIR is not set", () => {
    delete process.env.OPENCODE_CONFIG_DIR;
    expect(getEffectiveConfigRoot(PROJECT_ROOT)).toBe(PROJECT_ROOT);
  });

  it("returns OPENCODE_CONFIG_DIR when set", () => {
    const customConfig = resolve("custom", "config");
    process.env.OPENCODE_CONFIG_DIR = customConfig;
    expect(getEffectiveConfigRoot(PROJECT_ROOT)).toBe(customConfig);
  });

  it("resolves relative OPENCODE_CONFIG_DIR from fallback", () => {
    process.env.OPENCODE_CONFIG_DIR = ".opencode";
    expect(getEffectiveConfigRoot(PROJECT_ROOT)).toBe(resolve(PROJECT_ROOT, ".opencode"));
  });

  it("ignores whitespace-only OPENCODE_CONFIG_DIR", () => {
    process.env.OPENCODE_CONFIG_DIR = "   ";
    expect(getEffectiveConfigRoot(PROJECT_ROOT)).toBe(PROJECT_ROOT);
  });
});

describe("resolveRuntimeContextRoots", () => {
  const original = process.env.OPENCODE_CONFIG_DIR;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.OPENCODE_CONFIG_DIR;
    } else {
      process.env.OPENCODE_CONFIG_DIR = original;
    }
  });

  it("uses OPENCODE_CONFIG_DIR only when explicit configRoot is absent", () => {
    process.env.OPENCODE_CONFIG_DIR = ".opencode";
    expect(
      resolveRuntimeContextRoots({
        workspaceRoot: WORKSPACE_ROOT,
        fallbackDirectory: FALLBACK_DIRECTORY,
      }),
    ).toEqual({
      workspaceRoot: WORKSPACE_ROOT,
      configRoot: resolve(WORKSPACE_ROOT, ".opencode"),
    });
  });

  it("uses explicit configRoot as-is without re-applying OPENCODE_CONFIG_DIR", () => {
    process.env.OPENCODE_CONFIG_DIR = ".opencode";
    const explicitConfigRoot = resolve(WORKSPACE_ROOT, ".explicit");
    expect(
      resolveRuntimeContextRoots({
        workspaceRoot: WORKSPACE_ROOT,
        configRoot: explicitConfigRoot,
        fallbackDirectory: FALLBACK_DIRECTORY,
      }),
    ).toEqual({
      workspaceRoot: WORKSPACE_ROOT,
      configRoot: explicitConfigRoot,
    });
  });
});
