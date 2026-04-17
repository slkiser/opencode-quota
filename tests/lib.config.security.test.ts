import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const runtimeDirs = vi.hoisted(() => ({
  value: {
    dataDirs: [] as string[],
    configDirs: [] as string[],
    cacheDirs: [] as string[],
    stateDirs: [] as string[],
  },
}));

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirCandidates: () => runtimeDirs.value,
}));

import { loadConfig } from "../src/lib/config.js";

describe("loadConfig security precedence", () => {
  const originalEnv = process.env;
  const originalCwd = process.cwd();
  let tempDir: string;
  let workspaceDir: string;
  let xdgConfigHome: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "opencode-quota-config-"));
    workspaceDir = join(tempDir, "workspace");
    xdgConfigHome = join(tempDir, "xdg-config");

    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(join(xdgConfigHome, "opencode"), { recursive: true });

    runtimeDirs.value = {
      dataDirs: [join(tempDir, "xdg-data", "opencode")],
      configDirs: [join(xdgConfigHome, "opencode")],
      cacheDirs: [join(tempDir, "xdg-cache", "opencode")],
      stateDirs: [join(tempDir, "xdg-state", "opencode")],
    };

    process.env = {
      ...originalEnv,
      XDG_CONFIG_HOME: xdgConfigHome,
      XDG_DATA_HOME: join(tempDir, "xdg-data"),
      XDG_CACHE_HOME: join(tempDir, "xdg-cache"),
      XDG_STATE_HOME: join(tempDir, "xdg-state"),
    };
    process.chdir(workspaceDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env = originalEnv;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("keeps global config authoritative for network-affecting keys while allowing workspace display overrides", async () => {
    writeFileSync(
      join(xdgConfigHome, "opencode", "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabled: false,
            enabledProviders: ["openai"],
            showOnIdle: false,
            showOnQuestion: false,
            showOnCompact: false,
            minIntervalMs: 600000,
            pricingSnapshot: { source: "bundled", autoRefresh: 30 },
            formatStyle: "classic",
          },
        },
      }),
      "utf-8",
    );

    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabled: true,
            enabledProviders: ["chutes"],
            showOnIdle: true,
            showOnQuestion: true,
            showOnCompact: true,
            minIntervalMs: 1000,
            pricingSnapshot: { source: "runtime", autoRefresh: 1 },
            formatStyle: "grouped",
            onlyCurrentModel: true,
          },
        },
      }),
      "utf-8",
    );

    const cfg = await loadConfig({
      config: {
        get: async () => ({
          data: {
            experimental: {
              quotaToast: {
                enabled: true,
                enabledProviders: ["zai"],
                formatStyle: "grouped",
              },
            },
          },
        }),
      },
    });

    expect(cfg.enabled).toBe(false);
    expect(cfg.enabledProviders).toEqual(["openai"]);
    expect(cfg.showOnIdle).toBe(false);
    expect(cfg.showOnQuestion).toBe(false);
    expect(cfg.showOnCompact).toBe(false);
    expect(cfg.minIntervalMs).toBe(600000);
    expect(cfg.pricingSnapshot).toEqual({ source: "bundled", autoRefresh: 30 });
    expect(cfg.formatStyle).toBe("grouped");
    expect(cfg.onlyCurrentModel).toBe(true);
  });

  it("supports file loading with an explicit cwd override", async () => {
    const altWorkspaceDir = join(tempDir, "alt-workspace");
    mkdirSync(altWorkspaceDir, { recursive: true });

    writeFileSync(
      join(altWorkspaceDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabledProviders: ["nano-gpt"],
            formatStyle: "grouped",
            onlyCurrentModel: true,
          },
        },
      }),
      "utf-8",
    );

    const meta = { source: "defaults" as const, paths: [] as string[], networkSettingSources: {} as Record<string, string> };
    const cfg = await loadConfig(undefined, meta, { cwd: altWorkspaceDir });

    expect(cfg.enabledProviders).toEqual(["nanogpt"]);
    expect(cfg.formatStyle).toBe("grouped");
    expect(cfg.onlyCurrentModel).toBe(true);
    expect(meta.source).toBe("files");
    expect(meta.paths).toContain(join(altWorkspaceDir, "opencode.json") + " (experimental.quotaToast)");
    expect(meta.networkSettingSources).toEqual({
      enabledProviders: join(altWorkspaceDir, "opencode.json") + " (experimental.quotaToast)",
    });
  });

  it("merges pricingSnapshot per field so global and workspace sources can coexist", async () => {
    writeFileSync(
      join(xdgConfigHome, "opencode", "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            pricingSnapshot: { source: "bundled" },
          },
        },
      }),
      "utf-8",
    );

    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            pricingSnapshot: { autoRefresh: 2 },
          },
        },
      }),
      "utf-8",
    );

    const meta = { source: "defaults" as const, paths: [] as string[], networkSettingSources: {} as Record<string, string> };
    const cfg = await loadConfig(undefined, meta, { cwd: workspaceDir });

    expect(cfg.pricingSnapshot).toEqual({ source: "bundled", autoRefresh: 2 });
    expect(
      meta.networkSettingSources["pricingSnapshot.source"],
    ).toBe(join(xdgConfigHome, "opencode", "opencode.json") + " (experimental.quotaToast)");
    expect(meta.networkSettingSources["pricingSnapshot.autoRefresh"]).toBe(
      join(workspaceDir, "opencode.json") + " (experimental.quotaToast)",
    );
  });

  it("accepts legacy toastStyle in file-backed config and still prefers formatStyle when present", async () => {
    const legacyWorkspaceDir = join(tempDir, "legacy-workspace");
    mkdirSync(legacyWorkspaceDir, { recursive: true });

    writeFileSync(
      join(legacyWorkspaceDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            toastStyle: "grouped",
          },
        },
      }),
      "utf-8",
    );

    let cfg = await loadConfig(undefined, undefined, { cwd: legacyWorkspaceDir });
    expect(cfg.formatStyle).toBe("grouped");

    writeFileSync(
      join(legacyWorkspaceDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            toastStyle: "classic",
            formatStyle: "grouped",
          },
        },
      }),
      "utf-8",
    );

    cfg = await loadConfig(undefined, undefined, { cwd: legacyWorkspaceDir });
    expect(cfg.formatStyle).toBe("grouped");
  });
});
