import { rm } from "fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isCommandHandledError } from "../src/lib/command-handled.js";
import {
  createConfigModuleMock,
  createPluginTestClient as createClient,
  createPluginToolMockModule,
  createPricingModuleMock,
  createProvidersRegistryModuleMock,
  getPromptText,
  makeQuotaToastTestConfig,
  seedDefaultPluginBootstrapMocks,
} from "./helpers/plugin-test-harness.js";

const TEST_RUNTIME_ROOT = "/tmp/opencode-quota-plugin-command-boundary-tests";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  getProviders: vi.fn(),
  getPricingSnapshotMeta: vi.fn(),
  getPricingSnapshotSource: vi.fn(),
  getRuntimePricingRefreshStatePath: vi.fn(),
  getRuntimePricingSnapshotPath: vi.fn(),
  maybeRefreshPricingSnapshot: vi.fn(),
  setPricingSnapshotAutoRefresh: vi.fn(),
  setPricingSnapshotSelection: vi.fn(),
}));

vi.mock("@opencode-ai/plugin", () => createPluginToolMockModule());

vi.mock("../src/lib/config.js", () => createConfigModuleMock(mocks.loadConfig));

vi.mock("../src/providers/registry.js", () =>
  createProvidersRegistryModuleMock(mocks.getProviders),
);

vi.mock("../src/lib/modelsdev-pricing.js", () => createPricingModuleMock(mocks));

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirs: () => ({
    dataDir: `${TEST_RUNTIME_ROOT}/data`,
    configDir: `${TEST_RUNTIME_ROOT}/config`,
    cacheDir: `${TEST_RUNTIME_ROOT}/cache`,
    stateDir: `${TEST_RUNTIME_ROOT}/state`,
  }),
}));

type PluginHooks = {
  config?: (input: unknown) => Promise<void> | void;
  "command.execute.before"?: (input: {
    command: string;
    arguments?: string;
    sessionID: string;
  }) => Promise<void> | void;
};

type PluginConfigFixture = {
  command?: Record<string, { template: string; description: string }>;
  agent?: Record<string, unknown>;
  default_agent?: string;
};

const AGENT_NORMALIZATION_CASES = [
  {
    name: "exact",
    agent: { "\u200Bplanner": {} },
    defaultAgent: "\u200Bplanner",
    expectedDefaultAgent: "\u200Bplanner",
  },
  {
    name: "unique",
    agent: { "\u200Bplanner": {}, coder: {} },
    defaultAgent: "planner",
    expectedDefaultAgent: "\u200Bplanner",
  },
  {
    name: "ambiguous",
    agent: { "\u200Bplanner": {}, "\u200Cplanner": {} },
    defaultAgent: "planner",
    expectedDefaultAgent: "planner",
  },
] as const;

const PLUGIN_ORDERS = ["quota-first", "remapper-first"] as const;

async function loadPluginHooks(client: ReturnType<typeof createClient>): Promise<PluginHooks> {
  const { QuotaToastPlugin } = await import("../src/plugin.js");
  return (await QuotaToastPlugin({ client } as any)) as PluginHooks;
}

async function expectHandled(promise: Promise<unknown> | unknown): Promise<void> {
  try {
    await promise;
  } catch (err) {
    expect(isCommandHandledError(err)).toBe(true);
    return;
  }
  throw new Error("expected handled sentinel");
}

async function runServerCommand(params: {
  command: string;
  arguments?: string;
  client?: ReturnType<typeof createClient>;
  sessionID?: string;
}) {
  const client = params.client ?? createClient();
  const hooks = await loadPluginHooks(client);
  const commandHook = hooks["command.execute.before"];
  expect(commandHook).toBeDefined();

  await expectHandled(
    commandHook?.({
      command: params.command,
      arguments: params.arguments,
      sessionID: params.sessionID ?? "session-command",
    }),
  );

  return { client, hooks };
}

async function buildDialogOutput(params: {
  command: "quota" | "pricing_refresh" | "tokens_daily" | "tokens_session_all";
  client: ReturnType<typeof createClient>;
  sessionID?: string;
}) {
  const { buildQuotaDialogCommandOutput } = await import("../src/lib/quota-dialog-commands.js");
  return buildQuotaDialogCommandOutput({
    command: params.command,
    client: params.client,
    roots: {
      workspaceRoot: process.cwd(),
      configRoot: process.cwd(),
      fallbackDirectory: process.cwd(),
    },
    sessionID: params.sessionID,
  });
}

describe("plugin command handled boundary", () => {
  beforeEach(async () => {
    seedDefaultPluginBootstrapMocks(mocks, {
      configOverrides: { enabled: true },
      resetPluginState: true,
    });
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
    const { __resetQuotaStateForTests } = await import("../src/lib/quota-state.js");
    __resetQuotaStateForTests();
  });

  afterEach(async () => {
    const { __resetQuotaStateForTests } = await import("../src/lib/quota-state.js");
    __resetQuotaStateForTests();
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
  });

  it("registers deterministic slash commands for the server/web command surface", async () => {
    const client = createClient();
    const hooks = await loadPluginHooks(client);
    const cfg: { command?: Record<string, { template: string; description: string }> } = {};
    const { QUOTA_DIALOG_COMMANDS } = await import("../src/lib/quota-dialog-commands.js");

    await hooks.config?.(cfg as any);

    expect(hooks["command.execute.before"]).toBeDefined();
    expect(cfg.command).toBeDefined();
    expect(QUOTA_DIALOG_COMMANDS).toHaveLength(12);
    expect(new Set(QUOTA_DIALOG_COMMANDS.map((spec) => spec.id)).size).toBe(12);
    expect(new Set(QUOTA_DIALOG_COMMANDS.map((spec) => spec.slashName)).size).toBe(12);
    expect(Object.keys(cfg.command ?? {})).toHaveLength(12);
    for (const spec of QUOTA_DIALOG_COMMANDS) {
      expect(cfg.command?.[spec.id]).toEqual({
        template: `/${spec.slashName}`,
        description: spec.description,
      });
    }
    expect(client.session.prompt).not.toHaveBeenCalled();
  });

  for (const order of PLUGIN_ORDERS) {
    for (const scenario of AGENT_NORMALIZATION_CASES) {
      it(`normalizes the default agent for ${order} ordering with an ${scenario.name} match`, async () => {
        const client = createClient();
        const hooks = await loadPluginHooks(client);
        const cfg: PluginConfigFixture = {};
        let configAtPrompt:
          | { defaultAgent: string | undefined; agentKeys: string[]; namesExistingAgent: boolean }
          | undefined;

        if (order === "quota-first" && scenario.name === "unique") {
          client.session.prompt.mockImplementationOnce(async () => {
            const agentKeys = Object.keys(cfg.agent ?? {});
            configAtPrompt = {
              defaultAgent: cfg.default_agent,
              agentKeys,
              namesExistingAgent:
                cfg.default_agent !== undefined && agentKeys.includes(cfg.default_agent),
            };
            return {};
          });
        }

        const applyAgentRemap = () => {
          cfg.agent = { ...scenario.agent };
          cfg.default_agent = scenario.defaultAgent;
        };

        if (order === "remapper-first") applyAgentRemap();
        await hooks.config?.(cfg);
        if (order === "quota-first") applyAgentRemap();

        await expectHandled(
          hooks["command.execute.before"]?.({
            command: "quota",
            sessionID: `session-agent-order-${order}-${scenario.name}`,
          }),
        );

        expect(cfg.default_agent).toBe(scenario.expectedDefaultAgent);
        expect(client.session.prompt).toHaveBeenCalledTimes(1);
        if (order === "quota-first" && scenario.name === "unique") {
          expect(configAtPrompt).toEqual({
            defaultAgent: "\u200Bplanner",
            agentKeys: ["\u200Bplanner", "coder"],
            namesExistingAgent: true,
          });
        }
      });
    }
  }

  it("leaves non-quota server commands untouched", async () => {
    const client = createClient();
    const hooks = await loadPluginHooks(client);

    await expect(
      hooks["command.execute.before"]?.({ command: "project_notes", sessionID: "session-other" }),
    ).resolves.toBeUndefined();

    expect(client.session.prompt).not.toHaveBeenCalled();
  });

  it("handles server /quota by injecting deterministic output and aborting continuation", async () => {
    mocks.getProviders.mockReturnValue([
      {
        id: "boom-provider",
        isAvailable: vi.fn().mockRejectedValue(new Error("boom")),
        fetch: vi.fn(),
      },
    ]);

    const { client } = await runServerCommand({ command: "quota", sessionID: "session-2" });

    expect(client.session.prompt).toHaveBeenCalledTimes(1);
    expect(client.session.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { id: "session-2" },
        body: expect.objectContaining({
          noReply: true,
          parts: [
            expect.objectContaining({
              type: "text",
              ignored: true,
            }),
          ],
        }),
      }),
    );
    expect(getPromptText(client)).toContain("Quota unavailable");
    expect(getPromptText(client)).toContain("No provider data available");
  });

  it("injects clean plain text with noReply/ignored when /quota has no current model", async () => {
    mocks.loadConfig.mockResolvedValueOnce(
      makeQuotaToastTestConfig({
        enabled: true,
        onlyCurrentModel: false,
        showSessionTokens: false,
        tuiCommandDisplay: "dialog",
      }),
    );
    const provider = {
      id: "openai",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [
          {
            accounting: {
              resultType: "quota",
              acquisitionMethod: "remote_api",
              ownership: "maintained",
              authority: "provider_reported",
            },
            name: "OpenAI Weekly",
            group: "OpenAI",
            label: "Weekly:",
            percentRemaining: 80,
          },
        ],
        errors: [],
      }),
    };
    mocks.getProviders.mockReturnValue([provider]);
    const client = createClient();

    await runServerCommand({
      command: "quota",
      sessionID: "session-zero-model",
      client,
    });

    expect(provider.fetch).toHaveBeenCalledTimes(1);
    expect(client.session.prompt).toHaveBeenCalledWith({
      path: { id: "session-zero-model" },
      body: {
        noReply: true,
        parts: [
          {
            type: "text",
            ignored: true,
            text: expect.stringContaining("  Week quota"),
          },
        ],
      },
    });
    expect(getPromptText(client)).toMatch(/\n  Week quota\s+[█░]{10}\s+80% left/u);
    expect(getPromptText(client)).toMatch(/^Quota \(\/quota\)/u);
    expect(getPromptText(client)).not.toContain("```");
    expect(getPromptText(client)).not.toMatch(/^#{1,6} /mu);
    expect(getPromptText(client)).not.toContain("No enabled quota providers matched");
  });

  it("handles /tokens_between arguments through one inline injection", async () => {
    const { client } = await runServerCommand({
      command: "tokens_between",
      arguments: "not-a-date-range",
      sessionID: "session-between",
    });

    expect(client.session.prompt).toHaveBeenCalledTimes(1);
    expect(getPromptText(client)).toContain("Invalid arguments for /tokens_between");
  });

  it("injects inline usage output when /tokens_between arguments are missing", async () => {
    const { client } = await runServerCommand({
      command: "tokens_between",
      sessionID: "session-between-missing",
    });

    expect(client.session.prompt).toHaveBeenCalledTimes(1);
    expect(getPromptText(client)).toContain("Invalid arguments for /tokens_between");
    expect(getPromptText(client)).toContain("Expected: /tokens_between YYYY-MM-DD YYYY-MM-DD");
  });

  it("propagates server slash command injection failures instead of throwing handled", async () => {
    mocks.getProviders.mockReturnValue([
      {
        id: "boom-provider",
        isAvailable: vi.fn().mockRejectedValue(new Error("boom")),
        fetch: vi.fn(),
      },
    ]);
    const injectionError = new Error("prompt unavailable");
    const client = createClient();
    client.session.prompt.mockRejectedValueOnce(injectionError);
    const hooks = await loadPluginHooks(client);

    await expect(
      hooks["command.execute.before"]?.({ command: "quota", sessionID: "session-inject-fails" }),
    ).rejects.toBe(injectionError);

    expect(isCommandHandledError(injectionError)).toBe(false);
    expect(client.app.log).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          level: "warn",
          message: "Failed to inject raw output",
        }),
      }),
    );
  });

  it("still builds deterministic quota dialog output without session.prompt injection", async () => {
    const isAvailable = vi.fn().mockRejectedValue(new Error("boom"));
    mocks.getProviders.mockReturnValue([
      {
        id: "boom-provider",
        isAvailable,
        fetch: vi.fn(),
      },
    ]);
    const client = createClient();

    const result = await buildDialogOutput({ command: "quota", client, sessionID: "session-2" });

    expect(result.state).toBe("output");
    expect(result.state === "output" ? result.output : "").toContain("Quota unavailable");
    expect(result.state === "output" ? result.output : "").toContain("No provider data available");
    expect(isAvailable).toHaveBeenCalledOnce();
    expect(client.session.prompt).not.toHaveBeenCalled();
  });

  it("handles disabled deterministic server commands without injecting output", async () => {
    mocks.loadConfig.mockResolvedValue(makeQuotaToastTestConfig({ enabled: false }));
    const client = createClient();

    await runServerCommand({ command: "tokens_daily", client, sessionID: "session-disabled" });
    await runServerCommand({
      command: "tokens_session_all",
      client,
      sessionID: "session-disabled-tree",
    });

    expect(mocks.maybeRefreshPricingSnapshot).not.toHaveBeenCalled();
    expect(client.session.prompt).not.toHaveBeenCalled();
  });

  it("returns no-op dialog result for disabled deterministic commands", async () => {
    mocks.loadConfig.mockResolvedValue(makeQuotaToastTestConfig({ enabled: false }));
    const client = createClient();

    const daily = await buildDialogOutput({
      command: "tokens_daily",
      client,
      sessionID: "session-disabled",
    });
    const tree = await buildDialogOutput({
      command: "tokens_session_all",
      client,
      sessionID: "session-disabled-tree",
    });

    expect(daily).toEqual({ state: "noop", command: "tokens_daily", reason: "disabled" });
    expect(tree).toEqual({ state: "noop", command: "tokens_session_all", reason: "disabled" });
    expect(mocks.maybeRefreshPricingSnapshot).not.toHaveBeenCalled();
    expect(client.session.prompt).not.toHaveBeenCalled();
  });

  it("handles server /pricing_refresh by refreshing pricing, injecting output, and aborting continuation", async () => {
    mocks.maybeRefreshPricingSnapshot.mockResolvedValue({
      attempted: true,
      updated: true,
      state: { version: 1, updatedAt: Date.now(), lastResult: "success" },
    });

    const { client } = await runServerCommand({
      command: "pricing_refresh",
      sessionID: "session-pricing-refresh",
    });

    expect(mocks.maybeRefreshPricingSnapshot).toHaveBeenCalledWith({
      reason: "manual",
      force: true,
      snapshotSelection: "auto",
      allowRefreshWhenSelectionBundled: true,
    });
    expect(client.session.prompt).toHaveBeenCalledTimes(1);
    expect(getPromptText(client)).toContain("Pricing Refresh (/pricing_refresh)");
  });

  it("still builds /pricing_refresh dialog output without throwing a handled sentinel", async () => {
    mocks.maybeRefreshPricingSnapshot.mockResolvedValue({
      attempted: true,
      updated: true,
      state: { version: 1, updatedAt: Date.now(), lastResult: "success" },
    });

    const client = createClient();

    const result = await buildDialogOutput({
      command: "pricing_refresh",
      client,
      sessionID: "session-pricing-refresh",
    });

    expect(mocks.maybeRefreshPricingSnapshot).toHaveBeenCalledWith({
      reason: "manual",
      force: true,
      snapshotSelection: "auto",
      allowRefreshWhenSelectionBundled: true,
    });
    expect(result.state === "output" ? result.output : "").toContain(
      "Pricing Refresh (/pricing_refresh)",
    );
    expect(client.session.prompt).not.toHaveBeenCalled();
  });

  it("handles disabled server /pricing_refresh as a no-op", async () => {
    mocks.loadConfig.mockResolvedValue(makeQuotaToastTestConfig({ enabled: false }));
    const client = createClient();

    await runServerCommand({
      command: "pricing_refresh",
      client,
      sessionID: "session-disabled-refresh",
    });

    expect(mocks.maybeRefreshPricingSnapshot).not.toHaveBeenCalled();
    expect(client.session.prompt).not.toHaveBeenCalled();
  });

  it("treats /pricing_refresh as a dialog no-op when disabled", async () => {
    mocks.loadConfig.mockResolvedValue(makeQuotaToastTestConfig({ enabled: false }));
    const client = createClient();

    const result = await buildDialogOutput({
      command: "pricing_refresh",
      client,
      sessionID: "session-disabled-refresh",
    });

    expect(result).toEqual({ state: "noop", command: "pricing_refresh", reason: "disabled" });
    expect(mocks.maybeRefreshPricingSnapshot).not.toHaveBeenCalled();
    expect(client.session.prompt).not.toHaveBeenCalled();
  });
});
