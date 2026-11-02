import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PROVIDER_IDS as CONFIG_PROVIDER_IDS } from "../src/settings/schema.js";
import { answer, percentRow, textRow } from "./helpers/fake-answers.js";

const mockProviders: any[] = [];

const { snapshotFilePath } = await import("../src/core/persist.js");
const { loadProviderSource } = await import("../src/core/provider-source.js");
const { createQuotaStore } = await import("../src/core/store.js");
const { buildCliShowJson, buildCliShowText, buildCliStatus } =
  await import("../src/lib/cli-reports.js");
const { loadSettings } = await import("../src/settings/index.js");
type ProviderSourceHost = import("../src/core/provider-source.js").ProviderSourceHost;

describe("CLI reports", () => {
  let tempDir: string;
  let globalConfigDir: string;
  let workspaceDir: string;
  let savedConfigDir: string | undefined;

  /** A provider whose check answers with one account. */
  function fakeProvider(account: Parameters<typeof answer>[0], id = "zai") {
    return {
      id,
      cachePolicy: { kind: "account-neutral" as const },
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue(answer(account)),
    };
  }

  // OpenCode's provider list is the given ids; the settings come from settings.jsonc.
  async function hostFor(providerIds: string[] = []): Promise<ProviderSourceHost> {
    const loaded = await loadSettings();
    return {
      client: {
        config: {
          providers: async () => ({ data: { providers: providerIds.map((id) => ({ id })) } }),
        },
      },
      workspaceRoot: workspaceDir,
      locationDirectory: workspaceDir,
      settings: () => loaded,
      providers: () => mockProviders,
    };
  }

  function writeSettings(settings: Record<string, unknown>): void {
    mkdirSync(join(globalConfigDir, "opencode-quota"), { recursive: true });
    writeFileSync(
      join(globalConfigDir, "opencode-quota", "settings.jsonc"),
      JSON.stringify(settings),
      "utf8",
    );
  }

  /** What OpenCode's store saves after checking every enabled provider. */
  async function saveSnapshot(): Promise<void> {
    const host = await hostFor();
    const store = createQuotaStore({
      source: () => loadProviderSource(host),
      file: snapshotFilePath(),
    });
    await store.refresh({ reason: "manual" });
    await store.dispose();
  }

  beforeEach(() => {
    savedConfigDir = process.env.OPENCODE_CONFIG_DIR;
    delete process.env.OPENCODE_CONFIG_DIR;
    tempDir = mkdtempSync(join(tmpdir(), "opencode-quota-cli-reports-"));
    globalConfigDir = join(tempDir, "global-config", "opencode");
    workspaceDir = join(tempDir, "workspace");
    mkdirSync(globalConfigDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
    // OpenCode's folders by its own rules: `$XDG_<KIND>_HOME/opencode`.
    vi.stubEnv("XDG_CONFIG_HOME", join(tempDir, "global-config"));
    vi.stubEnv("XDG_DATA_HOME", join(tempDir, "data"));
    vi.stubEnv("XDG_CACHE_HOME", join(tempDir, "cache"));
    vi.stubEnv("XDG_STATE_HOME", join(tempDir, "state"));
    vi.stubEnv("OPENCODE_DB", join(tempDir, "opencode.db"));
    mockProviders.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    if (savedConfigDir !== undefined) process.env.OPENCODE_CONFIG_DIR = savedConfigDir;
    else delete process.env.OPENCODE_CONFIG_DIR;
    mockProviders.length = 0;
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("buildCliShowText", () => {
    it("renders a compact quota glance and returns zero when quota rows are available", async () => {
      const provider = fakeProvider({
        name: "Z.ai",
        rows: [percentRow("weekly", "Weekly", 75)],
      });
      mockProviders.push(provider);
      writeSettings({
        providers: { off: CONFIG_PROVIDER_IDS.filter((id) => !["zai"].includes(id)) },
      });

      const report = await buildCliShowText(await hostFor());

      expect(report.exitCode).toBe(0);
      expect(report.stdout).toContain("Z.ai Weekly");
      expect(report.stdout).toContain("75%");
      expect(report.stdout.endsWith("\n")).toBe(true);
      expect(report.stderr).toBe("");
      expect(provider.fetch).toHaveBeenCalledOnce();
    });

    it("shows used percents and the time to the reset", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-15T10:00:00.000Z"));
      mockProviders.push(
        fakeProvider({
          name: "Z.ai",
          rows: [
            percentRow("weekly", "Weekly", 81, {
              window: "week",
              resetsAt: "2026-01-17T15:14:00.000Z",
            }),
          ],
        }),
      );
      writeSettings({
        words: { percent: "used" },
        providers: { off: CONFIG_PROVIDER_IDS.filter((id) => !["zai"].includes(id)) },
      });

      const report = await buildCliShowText(await hostFor());

      expect(report).toEqual({
        exitCode: 0,
        stdout: "Z.ai Weekly         19% used      2.2d\n",
        stderr: "",
      });
    });

    it("returns non-zero without asking a provider that is not available", async () => {
      const provider = fakeProvider({ name: "Copilot" }, "copilot");
      provider.isAvailable.mockResolvedValue(false);
      mockProviders.push(provider);
      writeSettings({
        providers: { off: CONFIG_PROVIDER_IDS.filter((id) => !["copilot"].includes(id)) },
      });

      const report = await buildCliShowText(await hostFor());

      expect(report.exitCode).toBe(1);
      expect(provider.fetch).not.toHaveBeenCalled();
    });

    it("renders Copilot and Gemini CLI success rows", async () => {
      const copilotProvider = fakeProvider(
        { name: "Copilot (personal)", rows: [percentRow("allowance", "Quota", 100)] },
        "copilot",
      );
      const geminiCliProvider = fakeProvider(
        { name: "Gemini CLI", rows: [percentRow("pro", "Pro", 84)] },
        "google-gemini-cli",
      );
      mockProviders.push(copilotProvider, geminiCliProvider);
      writeSettings({
        providers: {
          off: CONFIG_PROVIDER_IDS.filter((id) => !["copilot", "google-gemini-cli"].includes(id)),
        },
      });

      const report = await buildCliShowText(await hostFor());

      expect(report.exitCode).toBe(0);
      expect(report.stdout).toContain("Copilot");
      expect(report.stdout).toContain("Gemini CLI");
      expect(copilotProvider.fetch).toHaveBeenCalledOnce();
      expect(geminiCliProvider.fetch).toHaveBeenCalledOnce();
      expect(report.stderr).toBe("");
    });

    it("uses OpenCode's provider ids for provider availability", async () => {
      const provider = {
        id: "copilot",
        cachePolicy: { kind: "account-neutral" as const },
        isAvailable: vi.fn(async (ctx: any) => {
          const response = await ctx.client.config.providers();
          return response.data.providers.some(
            (item: { id: string }) => item.id === "github-copilot",
          );
        }),
        fetch: vi
          .fn()
          .mockResolvedValue(
            answer({ name: "Copilot", rows: [percentRow("allowance", "Premium requests", 88)] }),
          ),
      };
      mockProviders.push(provider);

      const report = await buildCliShowText(await hostFor(["github-copilot"]));

      expect(report.exitCode).toBe(0);
      expect(report.stdout).toContain("Copilot");
      expect(provider.fetch).toHaveBeenCalledOnce();
      expect(report.stderr).toBe("");
    });
  });

  describe("buildCliShowJson", () => {
    it("outputs valid JSON with the quota OpenCode saved last", async () => {
      const provider = fakeProvider({
        name: "Z.ai",
        rows: [percentRow("weekly", "Weekly", 75)],
      });
      mockProviders.push(provider);
      writeSettings({
        providers: { off: CONFIG_PROVIDER_IDS.filter((id) => !["zai"].includes(id)) },
      });

      await saveSnapshot();
      expect(provider.fetch).toHaveBeenCalledOnce();

      const report = await buildCliShowJson({ host: await hostFor() });

      expect(report.exitCode).toBe(0);
      expect(report.stderr).toBe("");
      expect(report.stdout.endsWith("\n")).toBe(true);
      const parsed = JSON.parse(report.stdout);
      expect(parsed).toHaveProperty("version", 3);
      expect(parsed).toHaveProperty("exportedAt");
      expect(parsed).toHaveProperty("fromCache", true);
      expect(parsed).toHaveProperty("cacheAgeSeconds");
      expect(parsed.providers).toHaveProperty("zai");
      expect(parsed.providers.zai.status).toBe("ok");
      expect(parsed.providers.zai.entries[0].name).toBe("Z.ai Weekly");
      expect(parsed.providers.zai.entries[0].percentRemaining).toBe(75);
      expect(parsed.providers.zai.entries[0].renderType).toBe("percent");
      expect(parsed.providers.zai.entries[0]).not.toHaveProperty("unlimited");
      expect(provider.fetch).toHaveBeenCalledTimes(1); // only OpenCode's store asked it
    });

    it("asks no provider and returns unavailable when nothing was saved", async () => {
      const provider = fakeProvider({
        name: "Z.ai",
        rows: [percentRow("weekly", "Weekly", 100)],
      });
      mockProviders.push(provider);
      writeSettings({
        providers: { off: CONFIG_PROVIDER_IDS.filter((id) => !["zai"].includes(id)) },
      });

      const report = await buildCliShowJson({ host: await hostFor() });

      expect(report.exitCode).toBe(0);
      expect(report.stderr).toBe("");
      expect(JSON.parse(report.stdout).providers.zai.status).toBe("unavailable");
      expect(provider.fetch).not.toHaveBeenCalled();
    });

    it.each([
      [80, 50, 0],
      [30, 50, 1],
    ])(
      "--threshold uses percentage rows even when the first row is a quantity: %s vs %s",
      async (percentRemaining, threshold, expectedCode) => {
        const balance = {
          ...textRow("balance", "Balance", ""),
          type: "balance" as const,
          text: undefined,
          amount: { decimal: "5", unit: { kind: "currency" as const, code: "USD" } },
        };
        mockProviders.push(
          fakeProvider(
            {
              name: "OpenCode Zen",
              rows: [balance, percentRow("monthly", "Monthly", percentRemaining)],
            },
            "opencode",
          ),
        );
        writeSettings({
          providers: { off: CONFIG_PROVIDER_IDS.filter((id) => !["opencode"].includes(id)) },
        });

        await saveSnapshot();
        const report = await buildCliShowJson({ host: await hostFor(), threshold });

        expect(report.exitCode).toBe(expectedCode);
      },
    );

    it("--threshold exits 2 when no provider is ok", async () => {
      mockProviders.push(
        fakeProvider({ name: "Z.ai", rows: [percentRow("weekly", "Weekly", 100)] }),
      );
      writeSettings({
        providers: { off: CONFIG_PROVIDER_IDS.filter((id) => !["zai"].includes(id)) },
      });

      const report = await buildCliShowJson({ host: await hostFor(), threshold: 10 });

      expect(report.exitCode).toBe(2);
    });

    it("--threshold exits 2 when saved ok providers have no percentRemaining values", async () => {
      mockProviders.push(fakeProvider({ name: "Z.ai", rows: [textRow("usage", "Usage", "$42")] }));
      writeSettings({
        providers: { off: CONFIG_PROVIDER_IDS.filter((id) => !["zai"].includes(id)) },
      });

      await saveSnapshot();
      const report = await buildCliShowJson({ host: await hostFor(), threshold: 10 });

      expect(report.exitCode).toBe(2);
    });

    it("--threshold exits 2 for partial saved results instead of passing incomplete data", async () => {
      mockProviders.push(
        fakeProvider({
          name: "Z.ai",
          rows: [percentRow("five_hour", "5h", 80)],
          errors: ["quota endpoint unavailable"],
        }),
      );
      writeSettings({
        providers: { off: CONFIG_PROVIDER_IDS.filter((id) => !["zai"].includes(id)) },
      });

      await saveSnapshot();
      const report = await buildCliShowJson({ host: await hostFor(), threshold: 50 });

      expect(report.exitCode).toBe(2);
      expect(JSON.parse(report.stdout).providers.zai).toMatchObject({
        status: "partial",
        entries: [expect.objectContaining({ percentRemaining: 80 })],
        errors: [{ label: "Z.ai", message: "Nothing reported" }],
      });
    });

    it("includes only the providers enabled now", async () => {
      const copilotProvider = fakeProvider(
        { name: "Copilot", rows: [percentRow("allowance", "Premium requests", 90)] },
        "copilot",
      );
      mockProviders.push(
        copilotProvider,
        fakeProvider({ name: "Z.ai", rows: [percentRow("weekly", "Weekly", 50)] }),
      );
      writeSettings({
        providers: {
          off: CONFIG_PROVIDER_IDS.filter((id) => !["copilot", "zai"].includes(id)),
        },
      });
      await saveSnapshot();

      writeSettings({
        providers: { off: CONFIG_PROVIDER_IDS.filter((id) => !["copilot"].includes(id)) },
      });
      const report = await buildCliShowJson({ host: await hostFor() });

      expect(report.exitCode).toBe(0);
      const parsed = JSON.parse(report.stdout);
      expect(Object.keys(parsed.providers)).toEqual(["copilot"]);
      expect(parsed.providers.copilot.status).toBe("ok");
    });
  });

  describe("buildCliStatus", () => {
    /** Z.ai, enabled; its check answers with `rows` and `errors`. */
    function useZai(rows: ReturnType<typeof percentRow>[], errors: string[] = []): void {
      mockProviders.push(fakeProvider({ name: "Z.ai", rows, errors }));
      writeSettings({
        providers: { off: CONFIG_PROVIDER_IDS.filter((id) => !["zai"].includes(id)) },
      });
    }
    const WEEKLY = percentRow("weekly", "Weekly", 75);
    const FAILED = "quota endpoint unavailable";

    it("prints a plain-text Quota Status report and returns zero", async () => {
      useZai([WEEKLY]);

      const report = await buildCliStatus({ host: await hostFor(), json: false });

      expect(report.exitCode).toBe(0);
      expect(report.stderr).toBe("");
      expect(report.stdout).toMatch(/^# Quota Status/u);
      expect(report.stdout).toContain(
        `- providers.off: ${CONFIG_PROVIDER_IDS.filter((id) => id !== "zai").join(" | ")}`,
      );
      expect(report.stdout).toContain("\nzai:\n- state: ok");
      expect(report.stdout.endsWith("\n")).toBe(true);
    });

    it("emits a structured JSON payload and returns zero when live probes exist", async () => {
      useZai([WEEKLY]);

      const report = await buildCliStatus({ host: await hostFor(), json: true });

      expect(report.exitCode).toBe(0);
      expect(report.stderr).toBe("");
      const parsed = JSON.parse(report.stdout);
      expect(parsed).toHaveProperty("version", "6");
      expect(parsed).toHaveProperty("generatedAt");
      expect(parsed.config).toMatchObject({ enabledProviders: ["zai"] });
      expect(parsed.providers).toEqual([{ id: "zai", enabled: true, available: true }]);
      expect(parsed).toHaveProperty("pricing");
      expect(parsed.liveProbes).toEqual([{ id: "zai", ok: true }]);
    });

    it.each([
      ["nothing was checked", [], []],
      ["a failed check made no rows", [], [FAILED]],
    ])("exits 2 with JSON when %s", async (_case, rows, errors) => {
      if (errors.length > 0) useZai(rows, errors);
      else
        writeSettings({
          providers: { off: CONFIG_PROVIDER_IDS.filter((id) => !["zai"].includes(id)) },
        });

      const report = await buildCliStatus({ host: await hostFor(), json: true });

      expect(report.exitCode).toBe(2);
      expect(report.stderr).toBe("");
      // JSON still prints on exit 2.
      expect(JSON.parse(report.stdout).liveProbes).toEqual(
        errors.length > 0 ? [{ id: "zai", ok: false }] : [],
      );
    });

    it("succeeds with JSON when a partial probe produced quota entries", async () => {
      useZai([WEEKLY], [FAILED]);

      const report = await buildCliStatus({ host: await hostFor(), json: true });

      expect(report.exitCode).toBe(0);
      expect(JSON.parse(report.stdout).liveProbes).toEqual([{ id: "zai", ok: false }]);
    });

    /** The whole `status --json` payload users script against, for a few settings. */
    const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
    const PRICING_PATHS = {
      snapshotPath: "(custom path)/modelsdev-pricing.runtime.min.json",
      refreshStatePath: "(custom path)/modelsdev-pricing.refresh-state.json",
    };
    const BUNDLED_SNAPSHOT = {
      source: "bundled",
      generatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
      units: "USD per 1M tokens",
    };

    it.each([
      {
        name: "a provider list that keeps the custom providers on",
        settings: {
          providers: {
            off: CONFIG_PROVIDER_IDS.filter((id) => !["openai", "zai", "custom"].includes(id)),
            pricing: { source: "bundled" },
          },
        },
        providerId: undefined,
        payload: {
          version: "6",
          generatedAt: new Date(NOW).toISOString(),
          config: {
            settingsPath: "(custom path)/settings.jsonc",
            settingsFileExists: true,
            enabledProviders: ["openai", "zai", "custom"],
            onlyCurrentModel: false,
            pricingSnapshotSource: "bundled",
          },
          providers: [
            { id: "zai", enabled: true, available: true },
            { id: "openai", enabled: true, available: false },
            { id: "quota-providers", enabled: true, available: true },
            { id: "deepseek", enabled: false, available: true },
          ],
          pricing: {
            selection: "bundled",
            activeSource: "bundled",
            snapshot: BUNDLED_SNAPSHOT,
            ...PRICING_PATHS,
          },
          liveProbes: [
            { id: "zai", ok: false },
            { id: "quota-providers", ok: true },
          ],
        },
      },
      {
        name: "no provider off, only the current model",
        settings: {
          providers: { off: [], pricing: { source: "runtime" } },
          words: { onlyCurrentModel: true },
        },
        providerId: undefined,
        payload: {
          version: "6",
          generatedAt: new Date(NOW).toISOString(),
          config: {
            settingsPath: "(custom path)/settings.jsonc",
            settingsFileExists: true,
            enabledProviders: "auto",
            onlyCurrentModel: true,
            pricingSnapshotSource: "runtime",
          },
          providers: [
            { id: "zai", enabled: true, available: true },
            { id: "openai", enabled: true, available: false },
            { id: "quota-providers", enabled: true, available: true },
            { id: "deepseek", enabled: true, available: true },
          ],
          pricing: {
            selection: "runtime",
            activeSource: "bundled",
            snapshot: BUNDLED_SNAPSHOT,
            ...PRICING_PATHS,
          },
          liveProbes: [
            { id: "zai", ok: false },
            { id: "quota-providers", ok: true },
            { id: "deepseek", ok: true },
          ],
        },
      },
      {
        name: "one provider asked for, the custom providers off",
        settings: { providers: { off: ["custom", "anthropic"] } },
        providerId: "deepseek",
        payload: {
          version: "6",
          generatedAt: new Date(NOW).toISOString(),
          config: {
            settingsPath: "(custom path)/settings.jsonc",
            settingsFileExists: true,
            enabledProviders: CONFIG_PROVIDER_IDS.filter(
              (id) => !["custom", "anthropic"].includes(id),
            ),
            onlyCurrentModel: false,
            pricingSnapshotSource: "auto",
          },
          providers: [{ id: "deepseek", enabled: true, available: true }],
          pricing: {
            selection: "auto",
            activeSource: "bundled",
            snapshot: BUNDLED_SNAPSHOT,
            ...PRICING_PATHS,
          },
          liveProbes: [{ id: "deepseek", ok: true }],
        },
      },
    ])("prints the whole JSON payload: $name", async ({ settings, providerId, payload }) => {
      vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
      mockProviders.push(
        fakeProvider({ name: "Z.ai", rows: [WEEKLY], errors: [FAILED] }, "zai"),
        { ...fakeProvider({ name: "OpenAI" }, "openai"), isAvailable: vi.fn(async () => false) },
        fakeProvider({ name: "Team", rows: [WEEKLY] }, "quota-providers"),
        fakeProvider({ name: "DeepSeek", rows: [WEEKLY] }, "deepseek"),
      );
      writeSettings(settings);

      const report = await buildCliStatus({ host: await hostFor(), providerId, json: true });

      expect(JSON.parse(report.stdout)).toEqual(payload);
    });

    it("lists and checks only the provider asked for, and still emits JSON", async () => {
      useZai([WEEKLY]);
      const deepseek = fakeProvider({ name: "DeepSeek", rows: [WEEKLY] }, "deepseek");
      mockProviders.push(deepseek);

      const report = await buildCliStatus({
        host: await hostFor(),
        providerId: "zai",
        json: true,
      });

      expect(report.exitCode).toBe(0);
      expect(deepseek.fetch).not.toHaveBeenCalled();
      const parsed = JSON.parse(report.stdout);
      expect(parsed.providers).toEqual([{ id: "zai", enabled: true, available: true }]);
      expect(parsed).not.toHaveProperty("providerFilterId");
    });
  });
});
