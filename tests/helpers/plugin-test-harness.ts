import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vite-plus/test";
import { createFakeIntegration } from "./fake-integration.js";

type MockFunction = ReturnType<typeof vi.fn>;

interface PluginBootstrapMocks {
  getProviders?: MockFunction;
  sessionUsage?: MockFunction;
  resolveAlibabaCodingPlanAuthCached?: MockFunction;
}

export function createProvidersRegistryModuleMock(getProviders: MockFunction) {
  return { getProviders };
}

/** core/usage.js as it is, with `sessionUsage` replaced. */
export function createSessionUsageModuleMock(actual: object, sessionUsage: MockFunction) {
  return { ...actual, sessionUsage };
}

export function createAlibabaAuthModuleMock(resolveAlibabaCodingPlanAuthCached: MockFunction) {
  return {
    isAlibabaModelId: (model?: string) =>
      typeof model === "string" &&
      (model.toLowerCase().startsWith("alibaba/") || model.toLowerCase().startsWith("alibaba-cn/")),
    resolveAlibabaCodingPlanAuthCached,
  };
}

export function createPluginRuntimePathsMockModule(root: string) {
  return {
    getOpencodeRuntimeDirs: () => ({
      dataDir: `${root}/data`,
      configDir: `${root}/config`,
      cacheDir: `${root}/cache`,
      stateDir: `${root}/state`,
    }),
  };
}

/**
 * Writes the server settings file (settings.jsonc) under the runtime root of
 * `createPluginRuntimePathsMockModule(root)`.
 */
export function writePluginTestSettings(root: string, settings: Record<string, unknown>): void {
  const dir = join(root, "config", "opencode-quota");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.jsonc"), JSON.stringify(settings, null, 2));
}

/**
 * Clears every mock and gives the mocked modules their default answers. `resetPluginState`
 * loads fresh module instances, which clears module-level singleton state.
 */
export function seedDefaultPluginBootstrapMocks(
  mocks: PluginBootstrapMocks,
  options: { resetPluginState?: boolean } = {},
): void {
  vi.clearAllMocks();
  if (options.resetPluginState) vi.resetModules();

  mocks.getProviders?.mockReturnValue([]);
  mocks.sessionUsage?.mockResolvedValue(undefined);
  mocks.resolveAlibabaCodingPlanAuthCached?.mockResolvedValue({ state: "none" });
}

export type ServerTool = {
  name: string;
  execute: (input: unknown, context: { sessionID: string }) => Promise<{ content: string }>;
};

export type ServerCommand = {
  name: string;
  description?: string;
  execute: (invocation: {
    sessionID: string;
    prompt: { text: string };
    delivery?: "steer" | "queue";
  }) => Promise<void>;
};

/**
 * A fake OpenCode context for the server plugin's `setup`. It records the tools, slash
 * commands and session hooks the plugin adds; `emit` records the RPC events. OpenCode lists
 * the providers `openCodeProviders` names, and `sessionGet` answers for every session.
 */
export function createServerContext({
  directory = process.cwd(),
  openCodeProviders = [],
  sessionGet = vi.fn().mockResolvedValue({}),
  events = { async *[Symbol.asyncIterator]() {} },
}: {
  directory?: string;
  openCodeProviders?: string[];
  sessionGet?: MockFunction;
  events?: AsyncIterable<{ type: string }>;
} = {}) {
  const tools: ServerTool[] = [];
  const commands: ServerCommand[] = [];
  const commandBuilds: Array<(editor: { add: (command: ServerCommand) => void }) => void> = [];
  const hooks = new Map<string, unknown>();
  const emit = vi.fn(async (_name: string, _data: unknown) => {});
  const ctx = {
    location: { directory },
    provider: { list: vi.fn(async () => ({ data: openCodeProviders.map((id) => ({ id })) })) },
    session: {
      get: sessionGet,
      wait: vi.fn(async (_input: { sessionID: string }) => {}),
      prompt: vi.fn(async (_input: { sessionID: string; text: string }) => ({})),
      hook: vi.fn(async (name: string, callback: unknown) => {
        hooks.set(name, callback);
        return { dispose: async () => {} };
      }),
    },
    tool: {
      transform: vi.fn(async (build: (editor: { add: (tool: ServerTool) => void }) => void) =>
        build({ add: (tool) => tools.push(tool) }),
      ),
    },
    command: {
      transform: vi.fn(
        async (build: (editor: { add: (command: ServerCommand) => void }) => void) => {
          commandBuilds.push(build);
          build({ add: (command) => commands.push(command) });
        },
      ),
      // As OpenCode does: the list is built again from every transform.
      reload: vi.fn(async () => {
        commands.length = 0;
        for (const build of commandBuilds) build({ add: (command) => commands.push(command) });
      }),
    },
    rpc: { register: vi.fn(async () => ({ dispose: async () => {}, events: { emit } })) },
    integration: createFakeIntegration([]),
    event: { subscribe: () => events },
  };
  return { ctx, tools, commands, hooks, emit };
}
