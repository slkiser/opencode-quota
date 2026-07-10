import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";

import {
  classifyQuotaNpmSpec,
  getEffectiveConfigRoot,
  isCanonicalExactSemVer,
  resolveRuntimeContextRoots,
} from "../src/lib/config-file-utils.js";

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
    expect(getEffectiveConfigRoot("/home/user/project")).toBe("/home/user/project");
  });

  it("returns OPENCODE_CONFIG_DIR when set", () => {
    process.env.OPENCODE_CONFIG_DIR = "/custom/config";
    expect(getEffectiveConfigRoot("/home/user/project")).toBe("/custom/config");
  });

  it("resolves relative OPENCODE_CONFIG_DIR from fallback", () => {
    process.env.OPENCODE_CONFIG_DIR = ".opencode";
    expect(getEffectiveConfigRoot("/home/user/project")).toBe(
      join("/home/user/project", ".opencode"),
    );
  });

  it("ignores whitespace-only OPENCODE_CONFIG_DIR", () => {
    process.env.OPENCODE_CONFIG_DIR = "   ";
    expect(getEffectiveConfigRoot("/home/user/project")).toBe("/home/user/project");
  });
});

describe("quota npm spec classification", () => {
  it.each([
    ["@slkiser/opencode-quota", "3.11.2", { kind: "replace", reason: "bare" }],
    ["@slkiser/opencode-quota@latest", "3.11.2", { kind: "replace", reason: "latest" }],
    ["@slkiser/opencode-quota@3.11.1", "3.11.2", { kind: "replace", reason: "older" }],
    ["@slkiser/opencode-quota@3.11.2", "3.11.2", { kind: "preserve" }],
    ["@slkiser/opencode-quota@3.12.0", "3.11.2", { kind: "preserve" }],
    ["@slkiser/opencode-quota@3.11.2-rc.1", "3.11.2", { kind: "replace", reason: "older" }],
    ["@slkiser/opencode-quota@3.11.2", "3.11.2-rc.1", { kind: "preserve" }],
    ["@slkiser/opencode-quota@3.11.2-rc.2", "3.11.2-rc.10", { kind: "replace", reason: "older" }],
    ["@slkiser/opencode-quota@3.11.2-beta", "3.11.2-rc", { kind: "replace", reason: "older" }],
    ["@slkiser/opencode-quota@3.11.2+first", "3.11.2+second", { kind: "preserve" }],
    [
      "@slkiser/opencode-quota@999999999999999999999.0.0",
      "1000000000000000000000.0.0",
      { kind: "replace", reason: "older" },
    ],
  ] as const)("classifies %s against %s", (spec, runningVersion, expected) => {
    expect(classifyQuotaNpmSpec(spec, runningVersion)).toEqual(expected);
  });

  it.each([
    "@slkiser/opencode-quota@^3.11.0",
    "@slkiser/opencode-quota@3.x",
    "@slkiser/opencode-quota@next",
    "@slkiser/opencode-quota@v3.11.2",
    "@slkiser/opencode-quota@=3.11.2",
    "@slkiser/opencode-quota@03.11.2",
    "@slkiser/opencode-quota@3.011.2",
    "@slkiser/opencode-quota@3.11.02",
    "@slkiser/opencode-quota@3.11.2-01",
    "@slkiser/opencode-quota@3.11",
    "@slkiser/opencode-quota@3.11.2junk",
  ])("preserves ranges, tags, and malformed target versions: %s", (spec) => {
    expect(classifyQuotaNpmSpec(spec, "3.11.2")).toEqual({ kind: "preserve" });
  });

  it.each([
    "./opencode-quota",
    "../opencode-quota",
    "/opt/opencode-quota",
    "file:../opencode-quota",
    "opencode-quota.tgz",
    "workspace:@slkiser/opencode-quota",
    "link:../opencode-quota",
    "git+https://github.com/slkiser/opencode-quota.git",
    "https://example.com/opencode-quota.tgz",
    "npm:@slkiser/opencode-quota@3.11.1",
    "unrelated-plugin",
  ])("does not target local, archive, URL, alias, or unrelated specs: %s", (spec) => {
    expect(classifyQuotaNpmSpec(spec, "3.11.2")).toEqual({ kind: "not-target" });
  });

  it.each([
    ["0.0.0", true],
    ["3.11.2-alpha.1+build.01", true],
    ["999999999999999999999.0.0", true],
    ["v3.11.2", false],
    ["=3.11.2", false],
    ["03.11.2", false],
    ["3.11.2-01", false],
    ["3.11.2\n", false],
    ["3.11.2\r\n", false],
    ["3.11.2\u2028", false],
    ["3.11.2\u2029", false],
    ["3.11", false],
  ] as const)("validates canonical exact SemVer %s", (version, expected) => {
    expect(isCanonicalExactSemVer(version)).toBe(expected);
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
        workspaceRoot: "/work/repo",
        fallbackDirectory: "/work/repo/packages/app",
      }),
    ).toEqual({
      workspaceRoot: "/work/repo",
      configRoot: "/work/repo/.opencode",
    });
  });

  it("uses explicit configRoot as-is without re-applying OPENCODE_CONFIG_DIR", () => {
    process.env.OPENCODE_CONFIG_DIR = ".opencode";
    expect(
      resolveRuntimeContextRoots({
        workspaceRoot: "/work/repo",
        configRoot: "/work/repo/.explicit",
        fallbackDirectory: "/work/repo/packages/app",
      }),
    ).toEqual({
      workspaceRoot: "/work/repo",
      configRoot: "/work/repo/.explicit",
    });
  });
});
