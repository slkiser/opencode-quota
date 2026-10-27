import { QUOTA_PROVIDER_CATALOG } from "../src/lib/provider-metadata.js";

const CONFIG_PROVIDER_IDS = Object.keys(QUOTA_PROVIDER_CATALOG).map((id) =>
  id === "quota-providers" ? "custom" : id,
);

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vite-plus/test";
import type { QuotaSnapshot } from "../src/core/types.js";
import type { UsageReport } from "../src/core/usage.js";
import { answer, NOT_SET_UP, percentRow } from "./helpers/fake-answers.js";
import { useOpencodeFolders } from "./helpers/opencode-folders.js";
import {
  createServerContext,
  createSessionUsageModuleMock,
  seedDefaultPluginBootstrapMocks,
  writePluginTestSettings,
} from "./helpers/plugin-test-harness.js";
import { writeSessionDatabase } from "./helpers/session-database.js";

const folders = useOpencodeFolders();
const TEST_RUNTIME_ROOT = folders.root;

const mocks = vi.hoisted(() => ({
  getProviders: vi.fn(),
  sessionUsage: vi.fn(),
  reconcileDetectedProvidersInGlobalConfig: vi.fn(),
}));

vi.mock("../src/core/usage.js", async (importOriginal) =>
  createSessionUsageModuleMock(await importOriginal(), mocks.sessionUsage),
);
vi.mock("../src/lib/opencode-config-providers.js", () => ({
  reconcileDetectedProvidersInGlobalConfig: mocks.reconcileDetectedProvidersInGlobalConfig,
}));

type Handler = (input: unknown, context: unknown) => Promise<unknown>;

const callContext = {
  signal: new AbortController().signal,
  error: (type: string, message: string, data?: unknown) => ({ type, message, data }),
};

/** settings.jsonc: Copilot only, checked on every call; `overrides` per group. */
function useSettings(overrides: Record<string, unknown> = {}): void {
  writePluginTestSettings(folders.configDir, {
    ...overrides,
    providers: {
      off: CONFIG_PROVIDER_IDS.filter((id) => id !== "copilot"),
      checking: { minIntervalMs: 1 },
      ...(overrides.providers as object),
    },
  });
}

const SNAPSHOT_FILE = join(folders.stateDir, "opencode-quota", "snapshot-v6.json");
const SETTINGS_FILE = join(folders.configDir, "opencode-quota", "settings.jsonc");

/** A set-up provider that answers with `fetch`; `extra` adds fields such as its cache policy. */
function provider(id: string, fetch: unknown, extra: object = {}) {
  return { id, isAvailable: vi.fn().mockResolvedValue(true), fetch, ...extra };
}

const ACCOUNT_NEUTRAL = { cachePolicy: { kind: "account-neutral" } };

/** Gemini CLI as the one enabled provider: the bundled notice for its users is active. */
function useGeminiCli(): void {
  useSettings({
    providers: { off: CONFIG_PROVIDER_IDS.filter((id) => id !== "google-gemini-cli") },
  });
  mocks.getProviders.mockReturnValue([provider("google-gemini-cli", vi.fn())]);
}

/** Copilot's answer with `percentRemaining` of its premium requests left. */
const copilotAnswer = (percentRemaining: number) =>
  answer({
    name: "Copilot",
    rows: [percentRow("allowance", "Premium requests", percentRemaining)],
  });

/** Each server's cleanup; run after every test, before its folder goes. */
const cleanups: Array<() => unknown> = [];

/**
 * Starts the server plugin; OpenCode lists Copilot unless `options` say otherwise. `call` runs an
 * RPC method and checks its output. `runCommand` runs a slash command of Web and Desktop, and
 * `quota` runs /quota and returns the report it posts into the chat.
 */
async function setupServer(options: Parameters<typeof createServerContext>[0] = {}) {
  const { createQuotaServerPlugin } = await import("../src/plugin.js");
  const server = createQuotaServerPlugin({ providers: mocks.getProviders });
  const fake = createServerContext({ openCodeProviders: ["copilot"], ...options });
  const cleanup = await server.setup(fake.ctx as never);
  if (typeof cleanup === "function") cleanups.push(cleanup);
  const { register } = fake.ctx.rpc;
  expect(register).toHaveBeenCalledOnce();
  const [definition, handlers] = register.mock.calls[0] as unknown as [
    { id: string; methods: Record<string, unknown> },
    Record<string, Handler>,
  ];
  const call = async (method: string, input: unknown) => {
    const output = await handlers[method](input, callContext);
    // Outputs travel over HTTP to every client; they must never carry login secrets.
    expect(JSON.stringify(output)).not.toMatch(/"(access|refresh|apiKey)"/);
    // OpenCode's RPC route rejects any output that is not a JSON value (HTTP 400), so an
    // undefined field or a non-finite number must never reach it.
    expect(output).toStrictEqual(JSON.parse(JSON.stringify(output)));
    return output;
  };
  const runCommand = async (name: string, sessionID = "session-1") => {
    const command = fake.commands.find((item) => item.name === name);
    if (!command) throw new Error(`/${name} was not registered`);
    await command.execute({ sessionID, prompt: { text: "" } });
  };
  const quota = async (sessionID = "session-1") => {
    await runCommand("quota", sessionID);
    const posted = fake.ctx.session.prompt.mock.calls.filter(
      ([input]) => input.sessionID === sessionID,
    );
    // The report between its first and last line, which mark every quota report.
    return (posted.at(-1)?.[0].text ?? "").split("\n").slice(1, -1).join("\n");
  };
  return { ...fake, definition, handlers, call, runCommand, quota, cleanup };
}

describe("server quota RPC", () => {
  beforeEach(async () => {
    seedDefaultPluginBootstrapMocks(mocks, { resetPluginState: true });
    mocks.getProviders.mockReturnValue([
      provider("copilot", vi.fn().mockResolvedValue(copilotAnswer(81))),
    ]);
    mocks.reconcileDetectedProvidersInGlobalConfig.mockResolvedValue({ changed: false });
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true, maxRetries: 3 });
    useSettings();
  });

  afterEach(async () => {
    // Stops each server's store and waits for its fetches and writes.
    for (const cleanup of cleanups.splice(0)) await cleanup();
    vi.restoreAllMocks();
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true, maxRetries: 3 });
  });

  it("registers the quota RPC with its ten methods during setup", async () => {
    const { QuotaRpc } = await import("../src/rpc.js");
    const { definition, handlers } = await setupServer();

    expect(definition).toBe(QuotaRpc);
    expect(definition.id).toBe("slkiser.opencode-quota");
    expect(Object.keys(definition.methods)).toEqual([
      "snapshot",
      "refresh",
      "notices",
      "noticeList",
      "status",
      "usage",
      "downloadPrices",
      "settings",
      "saveSettings",
      "settingsSchema",
    ]);
    expect(Object.keys(handlers)).toEqual(Object.keys(definition.methods));
  });

  it("asks no provider and reads no snapshot file during setup", async () => {
    const fetch = vi.fn();
    mocks.getProviders.mockReturnValue([provider("copilot", fetch)]);
    await setupServer();

    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(SNAPSHOT_FILE)).toBe(false);
  });

  // The clock is pinned on both sides of local midnight: the two messages came 60 s and 30 s
  // before it, so after midnight they are yesterday's.
  it.each([
    {
      clock: "23:59:59",
      now: new Date(2026, 9, 10, 23, 59, 59),
      today: [
        ["claude-sonnet-4-5", true],
        ["mystery-1", false],
      ],
    },
    { clock: "00:00:01", now: new Date(2026, 9, 11, 0, 0, 1), today: [] },
  ])("reports usage from OpenCode's history over the usage method at $clock", async (clock) => {
    vi.setSystemTime(clock.now);
    const databaseDir = await mkdtemp(join(tmpdir(), "opencode-quota-usage-rpc-"));
    onTestFinished(() => rm(databaseDir, { recursive: true, force: true }));
    const databasePath = join(databaseDir, "opencode.db");
    vi.stubEnv("OPENCODE_DB", databasePath);
    const now = clock.now.getTime();
    writeSessionDatabase(databasePath, {
      sessions: [
        { id: "ses_root", created: now - 120_000 },
        { id: "ses_subagent", parentID: "ses_root", created: now - 90_000 },
      ],
      messages: [
        {
          id: "msg_1",
          sessionID: "ses_root",
          created: now - 60_000,
          completed: now - 59_000,
          providerID: "anthropic",
          modelID: "claude-sonnet-4-5",
          tokens: { input: 1_000 },
        },
        {
          id: "msg_2",
          sessionID: "ses_subagent",
          created: now - 30_000,
          completed: now - 29_000,
          providerID: "acme",
          modelID: "mystery-1",
          tokens: { output: 500 },
        },
      ],
    });
    useSettings({ providers: { pricing: { source: "bundled", autoRefreshDays: 3 } } });
    const { call } = await setupServer();

    // Today starts at local midnight; the last 24 hours roll.
    const today = (await call("usage", { range: "today" })) as { report: UsageReport };
    const day = (await call("usage", { range: "24h" })) as { report: UsageReport };
    // The report used the configured price list.
    const pricing = await import("../src/lib/modelsdev-pricing.js");
    expect(await pricing.describePriceList()).toMatchObject({
      selection: "bundled",
      health: { maxAgeMs: 3 * 24 * 60 * 60 * 1000 },
    });
    expect(today.report.sinceMs).toBe(new Date(2026, 9, clock.now.getDate()).getTime());
    expect(today.report.models.map((model) => [model.modelID, model.priced])).toEqual(clock.today);
    expect(day.report.totals).toMatchObject({ sessions: 1, unpricedTokens: 500 });
    expect(day.report.totals.costUsd).toBeGreaterThan(0);
    expect(day.report.models.map((model) => [model.modelID, model.priced])).toEqual([
      ["claude-sonnet-4-5", true],
      ["mystery-1", false],
    ]);

    // This session counts its subagent sessions too.
    const session = (await call("usage", { range: "session", sessionID: "ses_root" })) as {
      report: UsageReport;
    };
    expect(session.report.sessionID).toBe("ses_root");
    expect(session.report.totals.tokens.processed).toBe(1_500);
    // Without its subagents, the session alone.
    const alone = (await call("usage", {
      range: "session",
      sessionID: "ses_root",
      subagents: false,
    })) as { report: UsageReport };
    expect(alone.report.totals.tokens.processed).toBe(1_000);

    // All time reads the whole history, with no time window.
    const all = (await call("usage", { range: "all" })) as { report: UsageReport };
    expect(all.report).not.toHaveProperty("sinceMs");
    expect(all.report.totals.tokens.processed).toBe(1_500);
  });

  it("names the usage report's providers as OpenCode does, and keeps their ids when its list fails or hangs", async () => {
    vi.setSystemTime(new Date(2026, 9, 10, 12));
    const databaseDir = await mkdtemp(join(tmpdir(), "opencode-quota-usage-names-"));
    onTestFinished(() => rm(databaseDir, { recursive: true, force: true }));
    const databasePath = join(databaseDir, "opencode.db");
    vi.stubEnv("OPENCODE_DB", databasePath);
    const now = Date.now();
    writeSessionDatabase(databasePath, {
      sessions: [{ id: "session-1", created: now - 120_000 }],
      messages: [
        {
          id: "msg_1",
          sessionID: "session-1",
          created: now - 60_000,
          completed: now - 59_000,
          providerID: "moonshotai",
          modelID: "kimi-k3",
          tokens: { input: 1_000 },
        },
      ],
    });
    const { call, runCommand, ctx } = await setupServer({
      openCodeProviders: [
        { id: "moonshotai", name: "Moonshot AI" },
        { id: "openai", name: "OpenAI" },
      ],
    });

    const named = (await call("usage", { range: "today" })) as { report: UsageReport };
    expect(named.report.providerNames).toEqual({ moonshotai: "Moonshot AI" });
    // /quota_usage posts the report with the same names.
    await runCommand("quota_usage");
    const [posted] = ctx.session.prompt.mock.calls.at(-1) ?? [];
    expect(posted?.text).toMatch(/^● Moonshot AI +<\$0\.01 +100\.0%/m);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    ctx.provider.list.mockRejectedValueOnce(new Error("provider list offline"));
    const unnamed = (await call("usage", { range: "today" })) as { report: UsageReport };
    expect(unnamed.report).not.toHaveProperty("providerNames");
    expect(unnamed.report.providers.map((row) => row.providerID)).toEqual(["moonshotai"]);
    expect(warn).toHaveBeenCalledWith(
      "[opencode-quota] provider names failed: provider list offline",
    );

    // A provider list that never answers holds the report up for 2 s at most.
    let asked!: () => void;
    const listAsked = new Promise<void>((resolve) => {
      asked = resolve;
    });
    ctx.provider.list.mockImplementationOnce(() => {
      asked();
      return new Promise(() => {});
    });
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "Date"],
      now: new Date(2026, 9, 10, 12),
    });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const pending = call("usage", { range: "today" });
    await listAsked;
    await vi.advanceTimersByTimeAsync(2_000);
    const hung = (await pending) as { report: UsageReport };
    expect(hung.report).not.toHaveProperty("providerNames");
    expect(hung.report.providers.map((row) => row.providerID)).toEqual(["moonshotai"]);
    expect(warn).toHaveBeenCalledWith(
      "[opencode-quota] provider names failed: no answer within 2s",
    );
  });

  it("serves v6 rows from the store, saves them and emits changed", async () => {
    // A long interval: the snapshot call below answers from memory without a new fetch.
    useSettings({ providers: { checking: { minIntervalMs: 60_000 } } });
    const fetch = vi.fn().mockResolvedValue(
      answer({
        name: "Copilot (pro)",
        rows: [
          percentRow("allowance", "Premium requests", 80, {
            window: "month",
            used: { decimal: "60", unit: { kind: "count", unit: "request" } },
            limit: { decimal: "300", unit: { kind: "count", unit: "request" } },
            resetsAt: "2026-11-01T00:00:00.000Z",
          }),
        ],
      }),
    );
    mocks.getProviders.mockReturnValue([provider("copilot", fetch, ACCOUNT_NEUTRAL)]);
    const { call, emit } = await setupServer();

    const refreshed = (await call("refresh", { reason: "manual" })) as { snapshot: QuotaSnapshot };
    expect(refreshed.snapshot.providers).toEqual([
      expect.objectContaining({
        providerId: "copilot",
        label: "Copilot",
        refreshing: false,
        rows: [
          {
            id: "copilot.allowance",
            providerId: "copilot",
            account: "pro",
            label: "Premium requests",
            type: "quota",
            method: "remote_api",
            authority: "provider_reported",
            window: "month",
            prominence: "primary",
            percentRemaining: 80,
            used: { decimal: "60", unit: { kind: "count", unit: "request" } },
            limit: { decimal: "300", unit: { kind: "count", unit: "request" } },
            resetsAt: "2026-11-01T00:00:00.000Z",
          },
        ],
      }),
    ]);
    expect(refreshed.snapshot).not.toHaveProperty("currentModelProviderIds");
    expect(emit).toHaveBeenCalledWith("changed", {
      snapshot: expect.objectContaining({ version: 6 }),
    });
    // Clients get no server-only provider facts.
    const events = emit.mock.calls.map(([, event]) => event as { snapshot: QuotaSnapshot });
    for (const snapshot of [refreshed.snapshot, ...events.map((event) => event.snapshot)]) {
      for (const provider of snapshot.providers) {
        expect(provider).not.toHaveProperty("debug");
        expect(provider).not.toHaveProperty("exportPart");
      }
    }

    const saved = JSON.parse(await readFile(SNAPSHOT_FILE, "utf8")) as {
      entries: Record<string, { rows: Array<{ login: string; row: unknown }> }>;
    };
    expect(Object.values(saved.entries).map((entry) => entry.rows.map((item) => item.row))).toEqual(
      [refreshed.snapshot.providers[0]?.rows],
    );

    const instant = (await call("snapshot", {})) as { snapshot: QuotaSnapshot };
    expect(instant.snapshot.providers[0]?.rows).toEqual(refreshed.snapshot.providers[0]?.rows);
  });

  it("saves settings that complete a v5 conversion, then answers and tells every client", async () => {
    // A v5 sidecar that does not parse, and v5 settings in opencode.json: the start converts
    // them in memory only, and the save writes settings.jsonc with them.
    await rm(SETTINGS_FILE);
    await writeFile(join(folders.configDir, "opencode-quota", "quota-toast.jsonc"), "{ broken");
    await writeFile(
      join(folders.configDir, "opencode.json"),
      JSON.stringify({
        experimental: { quotaToast: { enabledProviders: ["copilot"], showOnIdle: false } },
      }),
    );
    const { call, emit } = await setupServer();

    await expect(
      call("saveSettings", { patch: { words: { percent: "used" } } }),
    ).resolves.toMatchObject({ ok: true });

    const sent = expect.objectContaining({
      words: expect.objectContaining({ percent: "used" }),
      settings: expect.objectContaining({
        values: expect.objectContaining({ "toast.afterReply": "off" }),
      }),
      settingsConverted: true,
    });
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith("changed", { snapshot: sent }));
    await expect(call("snapshot", {})).resolves.toEqual({ snapshot: sent });
  });

  it("checks every provider again at once when settings.jsonc changes a check setting", async () => {
    useSettings({ providers: { checking: { minIntervalMs: 60_000 } } });
    const fetch = vi.fn().mockResolvedValue(copilotAnswer(40));
    mocks.getProviders.mockReturnValue([provider("copilot", fetch, ACCOUNT_NEUTRAL)]);
    const { call } = await setupServer();
    await call("refresh", { reason: "manual" });
    expect(fetch).toHaveBeenCalledOnce();

    // Copilot is not due for a minute; another time limit checks it again now.
    useSettings({ providers: { checking: { minIntervalMs: 60_000, requestTimeoutMs: 30_000 } } });

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2), { timeout: 5_000 });
  });

  it("answers every setting's rule and where settings.jsonc is", async () => {
    const { SETTINGS_SCHEMA } = await import("../src/settings/index.js");
    const { call } = await setupServer();

    const answer = (await call("settingsSchema", {})) as {
      rules: Record<string, unknown>;
      path: string;
    };

    expect(answer).toEqual({
      rules: JSON.parse(JSON.stringify(SETTINGS_SCHEMA)),
      path: SETTINGS_FILE,
    });
    expect(Object.keys(answer.rules)).toEqual(Object.keys(SETTINGS_SCHEMA));
  });

  it("answers the settings a client may change, and switches a custom provider on", async () => {
    const gateway = {
      id: "my-gateway",
      label: "My gateway",
      mode: "remote-api",
      url: "http://127.0.0.2:8080/quota",
      format: "quota-v1",
      apiKeyEnv: "MY_GATEWAY_KEY",
      enabled: false,
    };
    useSettings({
      providers: {
        off: CONFIG_PROVIDER_IDS.filter((id) => !["copilot"].includes(id)),
        custom: [gateway],
      },
    });
    const { call } = await setupServer();

    const settings = (await call("settings", {})) as {
      values: Record<string, unknown>;
      providers: Array<{ id: string; label: string }>;
      custom: Array<{ fingerprint: string }>;
    };

    expect(settings.values).toMatchObject({
      "providers.off": CONFIG_PROVIDER_IDS.filter((id) => id !== "copilot"),
    });
    for (const fileOnly of [
      "providers.custom",
      "providers.anthropic.binaryPath",
      "system.exportPath",
    ]) {
      expect(settings.values).not.toHaveProperty([fileOnly]);
    }
    expect(settings.providers).toContainEqual({ id: "custom", label: "Custom providers" });
    expect(settings.custom).toEqual([
      {
        id: "my-gateway",
        label: "My gateway",
        enabled: false,
        request: {
          url: "http://127.0.0.2:8080/quota",
          key: "MY_GATEWAY_KEY, else OpenCode's my-gateway key",
          insecure: true,
        },
        fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);

    const fingerprint = settings.custom[0]?.fingerprint;
    await expect(
      call("saveSettings", {
        patch: {},
        customEnabled: { "my-gateway": { enabled: true, fingerprint } },
      }),
    ).resolves.toEqual({ ok: true, issues: [] });
    expect(parseJsonc(await readFile(SETTINGS_FILE, "utf8")).providers.custom).toEqual([
      { ...gateway, enabled: true },
    ]);
    expect(((await call("settings", {})) as typeof settings).custom).toMatchObject([
      { id: "my-gateway", enabled: true },
    ]);
    // A definition changed on disk shows at once, before the settings watch sees it.
    useSettings({ providers: { custom: [{ ...gateway, url: "https://other.example/quota" }] } });
    expect(((await call("settings", {})) as typeof settings).custom).toMatchObject([
      { request: { url: "https://other.example/quota" } },
    ]);
  });

  it("saves nothing that only the file may set", async () => {
    const { call } = await setupServer();
    const before = await readFile(SETTINGS_FILE, "utf8");

    const result = (await call("saveSettings", {
      patch: { system: { exportPath: `${TEST_RUNTIME_ROOT}/elsewhere.json` } },
    })) as { ok: boolean; issues: unknown[] };

    expect(result.ok).toBe(false);
    expect(result.issues).not.toHaveLength(0);
    expect(await readFile(SETTINGS_FILE, "utf8")).toBe(before);
  });

  it("tells clients which OpenCode provider each custom definition serves", async () => {
    useSettings({
      providers: {
        off: CONFIG_PROVIDER_IDS.filter((id) => !["copilot", "custom"].includes(id)),
        custom: [
          {
            id: "team-accounting",
            providerId: "team-gateway",
            label: "Team",
            mode: "remote-api",
            url: "https://team-gateway.example/quota",
            format: "quota-v1",
            apiKeyEnv: "V6_TEAM_KEY",
          },
        ],
      },
    });
    const { call } = await setupServer();

    const { snapshot } = (await call("snapshot", {})) as { snapshot: QuotaSnapshot };
    expect(snapshot.customRowProviders).toEqual({
      "quota-providers.custom.team-accounting.": "team-gateway",
    });
  });

  it("drops a check that ran across a settings change that turned its provider off", async () => {
    useSettings({
      providers: {
        off: CONFIG_PROVIDER_IDS.filter((id) => !["copilot", "openai"].includes(id)),
        checking: { minIntervalMs: 60_000 },
      },
    });
    let answerCopilot: (result: unknown) => void = () => {};
    const slowCopilot = vi.fn(
      () =>
        new Promise((resolve) => {
          answerCopilot = resolve;
        }),
    );
    const openai = vi
      .fn()
      .mockResolvedValue(answer({ name: "OpenAI", rows: [percentRow("five_hour", "5h", 60)] }));
    mocks.getProviders.mockReturnValue([
      provider("copilot", slowCopilot, ACCOUNT_NEUTRAL),
      provider("openai", openai, ACCOUNT_NEUTRAL),
    ]);
    const { call, emit } = await setupServer();
    const providerIds = (snapshot: QuotaSnapshot) =>
      snapshot.providers.map((provider) => provider.providerId);
    const emitted = () =>
      emit.mock.calls.map(([, data]) =>
        providerIds((data as { snapshot: QuotaSnapshot }).snapshot),
      );
    const running = call("refresh", { reason: "manual" }) as Promise<{ snapshot: QuotaSnapshot }>;
    await vi.waitFor(() => expect(slowCopilot).toHaveBeenCalledOnce());
    emit.mockClear();

    useSettings({
      providers: {
        off: CONFIG_PROVIDER_IDS.filter((id) => !["openai"].includes(id)),
        checking: { minIntervalMs: 60_000 },
      },
    });
    await vi.waitFor(() => expect(emitted().at(-1)).toEqual(["openai"]), { timeout: 5_000 });
    answerCopilot(copilotAnswer(70));

    // The refresh asked for before the change answers with the settings of now.
    expect(providerIds((await running).snapshot)).toEqual(["openai"]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(emitted().filter((ids) => ids.includes("copilot"))).toEqual([]);
    const now = (await call("snapshot", {})) as { snapshot: QuotaSnapshot };
    expect(providerIds(now.snapshot)).toEqual(["openai"]);
  });

  it("names the providers of the session's model in the snapshot", async () => {
    useSettings({
      providers: { off: CONFIG_PROVIDER_IDS.filter((id) => !["copilot", "openai"].includes(id)) },
    });
    mocks.getProviders.mockReturnValue(
      ["copilot", "openai"].map((id) => provider(id, vi.fn().mockResolvedValue(answer()))),
    );
    const sessionGet = vi.fn().mockResolvedValue({
      model: { id: "gpt-5", providerID: "openai" },
    });
    const { call } = await setupServer({ sessionGet });

    const output = (await call("snapshot", { sessionID: "session-1" })) as {
      snapshot: QuotaSnapshot;
    };
    expect(output.snapshot.providers.map((provider) => provider.providerId)).toEqual([
      "copilot",
      "openai",
    ]);
    expect(output.snapshot.currentModelProviderIds).toEqual(["openai"]);
  });

  it("waits for the store's running fetch and file write when the plugin is cleaned up", async () => {
    let answerFetch: (result: unknown) => void = () => {};
    const fetch = vi.fn(
      () =>
        new Promise((resolve) => {
          answerFetch = resolve;
        }),
    );
    mocks.getProviders.mockReturnValue([provider("copilot", fetch, ACCOUNT_NEUTRAL)]);
    const { call, cleanup } = await setupServer();
    await call("snapshot", {});
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());

    let done = false;
    const cleaning = Promise.resolve(cleanup()).then(() => {
      done = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(done).toBe(false);
    answerFetch(copilotAnswer(70));
    await cleaning;
    expect(existsSync(SNAPSHOT_FILE)).toBe(true);
  });

  it("checks who each provider is signed in as after a login change", async () => {
    useSettings({ providers: { checking: { minIntervalMs: 60_000 } } });
    let account = "alice";
    const fetch = vi.fn(async () =>
      answer({
        name: `Copilot (${account})`,
        rows: [percentRow("allowance", "Premium requests", 50)],
      }),
    );
    mocks.getProviders.mockReturnValue([
      provider("copilot", fetch, {
        cachePolicy: { kind: "resolved-auth", resolveIdentity: async () => account },
      }),
    ]);
    let sendLoginChange: () => void = () => {};
    const loginChanged = new Promise<void>((resolve) => {
      sendLoginChange = resolve;
    });
    const events = {
      async *[Symbol.asyncIterator]() {
        await loginChanged;
        yield { type: "credential.switched" };
      },
    };
    const { call, emit } = await setupServer({ events });
    await call("refresh", { reason: "manual" });
    emit.mockClear();

    account = "bob";
    sendLoginChange();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(emit).toHaveBeenCalled());
    await vi.waitFor(() => {
      const last = emit.mock.lastCall?.[1] as { snapshot: QuotaSnapshot };
      expect(last.snapshot.providers[0]?.rows.map((row) => row.account)).toEqual(["bob"]);
    });
  });

  it("adds the session's tokens to a session snapshot", async () => {
    useSettings({ words: { sessionTokens: "tree" } });
    const models = [{ modelID: "gpt-5", input: 900, cacheRead: 300, cacheWrite: 0 }];
    mocks.sessionUsage.mockResolvedValue({ input: 1200, cachedInput: 300, output: 80, models });
    const { call } = await setupServer();

    const session = (await call("snapshot", { sessionID: "session-1" })) as {
      snapshot: QuotaSnapshot;
    };
    expect(session.snapshot.sessionTokens).toStrictEqual({
      input: 1200,
      cachedInput: 300,
      output: 80,
      models,
    });
    expect(mocks.sessionUsage).toHaveBeenCalledWith("session-1", "tree");
    const global = (await call("snapshot", {})) as { snapshot: QuotaSnapshot };
    expect(global.snapshot).not.toHaveProperty("sessionTokens");
  });

  it("serves the daily Home notice line without settings", async () => {
    useGeminiCli();
    const nowMs = new Date(2026, 9, 10, 9, 0).getTime();
    const clock = vi.spyOn(Date, "now").mockReturnValue(nowMs);
    const { call } = await setupServer();
    await expect(call("notices", {})).resolves.toEqual({
      homeLine: "Notice: 1 maintainer notice, see /quota_status.",
    });
    clock.mockReturnValue(nowMs + 10 * 60_000);
    await expect(call("notices", {})).resolves.toEqual({ homeLine: "" });
  });

  it("lists the active notices without read state or settings", async () => {
    useGeminiCli();
    const nowMs = Date.parse("2026-10-10T12:00:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(nowMs);
    const { getMaintainerAnnouncementsSummary } =
      await import("../src/lib/maintainer-announcements.js");
    const expected = getMaintainerAnnouncementsSummary({
      enabledProviders: ["google-gemini-cli"],
      nowMs,
    }).activeAnnouncements.map(({ announcement }) => ({
      id: announcement.id,
      message: announcement.message,
      ...(announcement.url ? { url: announcement.url } : {}),
    }));
    expect(expected).toHaveLength(1);
    const { call } = await setupServer();
    await expect(call("noticeList", {})).resolves.toEqual({ notices: expected });
  });

  it("serves the /quota_status report as text, and never writes the global config", async () => {
    useSettings({ providers: { off: [] } });
    const { call, runCommand } = await setupServer();

    const { text } = (await call("status", { sessionID: "session-1" })) as { text: string };
    expect(text).toMatch(/^# Quota Status /u);
    expect(text).toContain("\n- origin: TUI Plugin tab\n");
    expect(text).toContain("\ncopilot:\n- state: ok\n");
    expect(mocks.reconcileDetectedProvidersInGlobalConfig).not.toHaveBeenCalled();

    // The slash command of Web and Desktop adds the detected providers.
    await runCommand("quota_status");
    expect(mocks.reconcileDetectedProvidersInGlobalConfig).toHaveBeenCalledWith({
      directory: process.env.HOME,
      detectedProviderIds: ["copilot"],
    });
  });

  it("writes the export file from each new snapshot only when the export is enabled", async () => {
    const exportPath = `${TEST_RUNTIME_ROOT}/quota-export.json`;
    useSettings({ system: { exportFile: false, exportPath: exportPath } });
    const disabled = await setupServer();
    await disabled.call("refresh", { reason: "manual" });
    await vi.waitFor(() => expect(disabled.emit).toHaveBeenCalled());
    expect(existsSync(exportPath)).toBe(false);

    useSettings({ system: { exportFile: true, exportPath: exportPath } });
    const enabled = await setupServer();
    await enabled.call("refresh", { reason: "manual" });
    // The snapshot before the check is written first; the check's own part follows.
    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(exportPath, "utf8"))).toMatchObject({
        version: 3,
        fromCache: true,
        providers: {
          copilot: {
            status: "ok",
            entries: [
              { id: "copilot.allowance", name: "Copilot Premium requests", percentRemaining: 81 },
            ],
          },
        },
      });
    });
    // The parts stay on the server: no client gets them.
    expect(JSON.stringify(await enabled.call("snapshot", {}))).not.toContain("exportPart");
    expect(JSON.stringify(enabled.emit.mock.calls)).not.toContain("exportPart");
  });

  it("downloads new prices whatever their age, and says when the settings keep the built-in ones", async () => {
    useSettings({ providers: { pricing: { source: "bundled", autoRefreshDays: 3 } } });
    // models.dev's reply, saved in the plugin's cache folder: gone after this test.
    const models = { "gpt-4o-mini": { cost: { input: 0.2, output: 0.8 } } };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ openai: { models } }))),
    );
    onTestFinished(() => rm(`${TEST_RUNTIME_ROOT}/cache`, { recursive: true, force: true }));
    const { call } = await setupServer();

    await expect(call("downloadPrices", {})).resolves.toEqual({
      ok: true,
      message:
        "Downloaded new prices. Usage keeps the built-in prices: the pricing source setting is bundled.",
    });
  });

  it("posts the /quota quick look of Web and Desktop into the chat", async () => {
    const databaseDir = await mkdtemp(join(tmpdir(), "opencode-quota-quick-look-"));
    onTestFinished(() => rm(databaseDir, { recursive: true, force: true }));
    const databasePath = join(databaseDir, "opencode.db");
    vi.stubEnv("OPENCODE_DB", databasePath);
    const now = Date.parse("2026-10-10T12:00:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    writeSessionDatabase(databasePath, {
      sessions: [{ id: "ses_root", created: now - 120_000 }],
      messages: [
        {
          id: "msg_1",
          sessionID: "ses_root",
          created: now - 60_000,
          completed: now - 59_000,
          providerID: "anthropic",
          modelID: "claude-sonnet-4-5",
          tokens: { input: 1_000_000 },
        },
      ],
    });
    useSettings({ providers: { pricing: { source: "bundled", autoRefreshDays: 3 } } });
    const { ctx, commands, runCommand } = await setupServer();

    await runCommand("quota");

    expect(ctx.session.wait).toHaveBeenCalledWith({ sessionID: "session-1" });
    const [message] = ctx.session.prompt.mock.calls[0] as [
      { text: string; metadata: Record<string, { command: string }> },
    ];
    expect(message.text.split("\n")).toEqual([
      "[OpenCode Quota report]",
      "Quota · 7 days · $3.00 · 1.00M tokens",
      "● Anthropic  $3.00",
      "● Copilot    Premium requests 81% left",
      "[End of OpenCode Quota report]",
    ]);
    expect(message.metadata.opencodeQuota?.command).toBe("quota");
    expect(commands.map((command) => command.name)).not.toContain("quota_announcements");
  });

  it("ends the /quota report of Web and Desktop with the active notices", async () => {
    useGeminiCli();
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-10T12:00:00.000Z"));
    const { BUNDLED_MAINTAINER_ANNOUNCEMENTS } =
      await import("../src/lib/maintainer-announcements.js");
    const notice = BUNDLED_MAINTAINER_ANNOUNCEMENTS.find(
      (announcement) => announcement.id === "google-gemini-cli-org-only",
    );
    const { quota } = await setupServer();

    const report = await quota();
    expect(report.split("\n").slice(-3)).toEqual(["", "Notices", `- ${notice?.message}`]);
  });

  it("treats a session the server cannot find as a session without a model", async () => {
    const sessionGet = vi.fn().mockRejectedValue(new Error("Session not found"));
    const { call } = await setupServer({ sessionGet });

    const output = (await call("snapshot", { sessionID: "missing" })) as {
      snapshot: QuotaSnapshot;
    };
    expect(output.snapshot).not.toHaveProperty("currentModelProviderIds");
    expect(sessionGet).toHaveBeenCalledWith({ sessionID: "missing" });
  });

  it("computes quota for the location's project folder, not the service's working folder", async () => {
    useSettings({ providers: { off: [] } });
    const workspaceRoots: string[] = [];
    const locationDirectories: string[] = [];
    const fetch = vi.fn(async (ctx: { workspaceRoot: string; locationDirectory: string }) => {
      workspaceRoots.push(ctx.workspaceRoot);
      locationDirectories.push(ctx.locationDirectory);
      return copilotAnswer(81);
    });
    mocks.getProviders.mockReturnValue([provider("copilot", fetch)]);
    const project = `${TEST_RUNTIME_ROOT}/project`;
    const { call } = await setupServer({ directory: project });

    // The store's refresh, then /quota_status, which checks every provider itself.
    await call("refresh", { reason: "manual" });
    const status = (await call("status", { sessionID: "session-1" })) as { text: string };
    expect(status.text).toContain("- providers.off: (none)");
    // The test settings check providers again after 1 ms.
    expect(status.text).toContain(
      "- changed_from_defaults: 1 setting\n  - providers.checking.minIntervalMs: 1\n",
    );
    expect(status.text).not.toContain("- enabledProviders:");

    expect(workspaceRoots).toHaveLength(2);
    expect(new Set(workspaceRoots)).toEqual(new Set([project]));
    // OpenCode's config files that count are found from the location's folder upward.
    expect(new Set(locationDirectories)).toEqual(new Set([project]));
    expect(project).not.toBe(process.cwd());
  });

  it("logs why a snapshot or notices RPC failed, without tokens, and still fails it", async () => {
    const token = `eyJ${"a".repeat(24)}.${"b".repeat(24)}.${"c".repeat(24)}`;
    mocks.getProviders.mockImplementation(() => {
      throw new Error(`registry broke ${token}`);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { handlers } = await setupServer();

    for (const [method, input] of [
      ["snapshot", { sessionID: "session-1" }],
      ["notices", {}],
    ] as const) {
      await expect(handlers[method](input, callContext)).rejects.toThrow("registry broke");
      expect(warn).toHaveBeenLastCalledWith(
        `[opencode-quota] ${method} RPC failed: registry broke [redacted]`,
      );
    }
    expect(JSON.stringify(warn.mock.calls)).not.toContain(token);
  });

  describe("/quota and the quota_status tool", () => {
    /** settings.jsonc for /quota: every provider, checked once a minute; `overrides` per group. */
    const useQuotaSettings = (overrides: Record<string, unknown> = {}) =>
      useSettings({
        ...overrides,
        providers: {
          off: [],
          checking: { minIntervalMs: 60_000 },
          ...(overrides.providers as object),
        },
      });

    beforeEach(() => {
      useQuotaSettings();
    });

    it.each([
      { name: "a working repair", repair: () => Promise.resolve({ changed: true }), warns: false },
      {
        name: "a failed repair",
        repair: () => Promise.reject(new Error("disk full")),
        warns: true,
      },
    ])(
      "adds the detected providers of the quota_status tool to the project with $name",
      async ({ repair, warns }) => {
        mocks.reconcileDetectedProvidersInGlobalConfig.mockImplementationOnce(repair);
        const openaiAnswer = answer({ name: "OpenAI", rows: [percentRow("five_hour", "5h", 69)] });
        mocks.getProviders.mockReturnValue([
          provider("openai", vi.fn().mockResolvedValue(openaiAnswer)),
        ]);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const projectDirectory = `${TEST_RUNTIME_ROOT}/project`;
        const { tools } = await setupServer({ directory: projectDirectory });
        const tool = tools.find((item) => item.name === "quota_status");

        const output = await tool?.execute({}, { sessionID: "session-auto-provider" });
        const content = (output as { content: string }).content;
        expect(content).toMatch(/^# Quota Status /u);
        expect(content).toContain("\n- origin: quota_status tool\n");
        expect(mocks.reconcileDetectedProvidersInGlobalConfig).toHaveBeenCalledWith({
          directory: projectDirectory,
          detectedProviderIds: ["openai"],
        });
        if (warns) {
          expect(warn).toHaveBeenCalledWith(
            "Failed to add detected providers to global OpenCode config",
            expect.any(Error),
          );
        } else {
          expect(warn).not.toHaveBeenCalled();
        }
      },
    );

    it("waits before asking a failed provider again; a manual refresh asks at once", async () => {
      useQuotaSettings({
        providers: { off: CONFIG_PROVIDER_IDS.filter((id) => !["openai"].includes(id)) },
      });
      const fetch = vi
        .fn()
        .mockRejectedValueOnce(new Error("temporary failure"))
        .mockResolvedValueOnce(
          answer({ name: "OpenAI", rows: [percentRow("five_hour", "5h", 69)] }),
        );
      mocks.getProviders.mockReturnValue([provider("openai", fetch)]);
      const { call, quota } = await setupServer();

      await quota();
      const failed = await quota();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(failed).not.toContain("69% left");

      await call("refresh", { reason: "manual" });
      const recovered = await quota();

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(recovered).toContain("69% left");
    });

    it("Web and Desktop /quota show pace without a words.runsOut setting", async () => {
      const now = Date.now();
      const fetch = vi.fn().mockResolvedValue(
        answer({
          name: "OpenAI",
          rows: [
            percentRow("five_hour", "5h", 50, {
              window: "five_hour",
              windowStartedAt: new Date(now - 60 * 60_000).toISOString(),
              resetsAt: new Date(now + 3 * 60 * 60_000).toISOString(),
            }),
          ],
        }),
      );
      mocks.getProviders.mockReturnValue([provider("openai", fetch)]);
      const { quota } = await setupServer();
      expect(await quota()).toContain("runs out in");
    });

    it.each([
      { words: { percent: "used" }, shows: "5h 19% used", hides: "left" },
      { words: { percent: "bare" }, shows: "5h 81%", hides: "left" },
    ])(
      "shows /quota in the percent words the settings choose: $words",
      async ({ words, shows, hides }) => {
        useQuotaSettings({
          words,
          providers: { off: CONFIG_PROVIDER_IDS.filter((id) => !["openai"].includes(id)) },
        });
        const fetch = vi
          .fn()
          .mockResolvedValue(answer({ name: "OpenAI", rows: [percentRow("five_hour", "5h", 81)] }));
        mocks.getProviders.mockReturnValue([provider("openai", fetch)]);
        const { quota } = await setupServer();

        const output = await quota();

        expect(output).toContain(shows);
        expect(output).not.toContain(hides);
      },
    );

    it.each([
      {
        name: "an error without rows",
        id: "alibaba-coding-plan",
        fetch: vi.fn().mockResolvedValue(
          answer({
            name: "Alibaba Coding Plan",
            errors: ["The provider reply could not be read"],
          }),
        ),
        line: "Alibaba Coding Plan",
      },
      {
        name: "a failed fetch",
        id: "cursor",
        fetch: vi.fn().mockRejectedValue(new Error("sqlite busy")),
        line: "Cursor",
      },
      {
        name: "nothing reported",
        id: "anthropic",
        fetch: vi.fn().mockResolvedValue(NOT_SET_UP),
        line: "Anthropic",
      },
    ])("shows a line for a provider with $name", async ({ id, fetch, line }) => {
      useQuotaSettings({ providers: { off: CONFIG_PROVIDER_IDS.filter((other) => other !== id) } });
      mocks.getProviders.mockReturnValue([provider(id, fetch)]);
      const { quota } = await setupServer();

      const output = await quota();

      expect(output).toContain(line);
      expect(output).not.toContain("Quota unavailable");
    });

    it("says no provider serves the session's model when onlyCurrentModel leaves none", async () => {
      useQuotaSettings({ words: { onlyCurrentModel: true } });
      const fetch = vi
        .fn()
        .mockResolvedValue(answer({ name: "Cursor", rows: [percentRow("api", "API", 50)] }));
      mocks.getProviders.mockReturnValue([
        provider("cursor", fetch, { matchesCurrentModel: (model?: string) => model === "auto" }),
      ]);
      const { quota } = await setupServer({
        sessionGet: vi.fn().mockResolvedValue({ model: { id: "gpt-5", providerID: "openai" } }),
      });

      const output = await quota();

      expect(output).toContain("No quota provider serves the session's current model.");
    });

    it("shows only the custom sources serving the session's model when onlyCurrentModel is on", async () => {
      const definition = (id: string, model: string) => ({
        id,
        providerId: `${id}-gateway`,
        modelIds: [model],
        url: `https://${id}.example/quota`,
        mode: "remote-api",
        format: "quota-v1",
        apiKeyEnv: "TEST_GATEWAY_KEY",
      });
      useQuotaSettings({
        words: { onlyCurrentModel: true },
        providers: {
          off: CONFIG_PROVIDER_IDS.filter((id) => !["custom"].includes(id)),
          custom: [definition("alpha", "model-a"), definition("beta", "model-b")],
        },
      });
      // Each custom definition is an account; its id is the login and in its row ids.
      const source = (id: string, percentRemaining: number) => ({
        name: id,
        login: id,
        rows: [
          percentRow(`custom.${id}.monthly`, "Monthly", percentRemaining, { window: "month" }),
        ],
      });
      // One check reads every source; only the rows shown depend on the session's model.
      const fetch = vi.fn().mockResolvedValue(answer(source("alpha", 61), source("beta", 32)));
      mocks.getProviders.mockReturnValue([provider("quota-providers", fetch)]);
      let model = { id: "model-a", providerID: "alpha-gateway" };
      const { quota } = await setupServer({
        sessionGet: vi.fn(async () => ({ model })),
        openCodeProviders: ["alpha-gateway", "beta-gateway"],
      });

      const alpha = await quota();
      model = { id: "model-b", providerID: "beta-gateway" };
      const beta = await quota();

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(alpha).toContain("61% left");
      expect(alpha).not.toContain("32% left");
      expect(beta).toContain("32% left");
      expect(beta).not.toContain("61% left");
    });

    it("answers /quota of every session from one check while the rows are fresh", async () => {
      const fetch = vi
        .fn()
        .mockResolvedValue(answer({ name: "OpenAI", rows: [percentRow("five_hour", "5h", 95)] }));
      mocks.getProviders.mockReturnValue([provider("openai", fetch, ACCOUNT_NEUTRAL)]);
      const { quota } = await setupServer();

      const first = await quota("session-a");
      const second = await quota("session-b");

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(first).toContain("95% left");
      expect(second).toContain("95% left");
    });

    it("counts Cursor usage again on every /quota", async () => {
      const entry = (percentRemaining: number) =>
        answer({ name: "Cursor (Pro)", rows: [percentRow("api", "API", percentRemaining)] });
      const fetch = vi.fn().mockResolvedValueOnce(entry(70)).mockResolvedValueOnce(entry(60));
      mocks.getProviders.mockReturnValue([provider("cursor", fetch)]);
      const { quota } = await setupServer();

      await quota();
      const latest = await quota();

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(latest).toContain("60% left");
    });
  });
});
