import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  StartupRuntimePhase,
  StartupRuntimeResult,
  StartupRuntimeSample,
  StartupTraceEvent,
} from "./helpers/tui-startup-runtime-resolution.js";

const instrumentation = vi.hoisted(() => ({
  controlledDelayMs: 0,
  currentTopPhase: undefined as string | undefined,
  currentSessionPhase: undefined as string | undefined,
  currentContextPhase: undefined as string | undefined,
  trace: [] as Array<{
    sequence: number;
    phase: string;
    operation: "runtime-context" | "config-load";
    edge: "start" | "complete";
    atMs: number;
    configGeneration?: number;
  }>,
  sessionLoaderInvocations: 0,
  homeLoaderInvocations: 0,
  sessionFirstStartMs: undefined as number | undefined,
  homeFirstStartMs: undefined as number | undefined,
  eventTriggerTimes: new Set<number>(),
  cleanupFns: [] as Array<() => void>,
}));

function configGeneration(config: unknown): number | undefined {
  const maxWidth = (config as { tuiCompactStatus?: { maxWidth?: unknown } })?.tuiCompactStatus
    ?.maxWidth;
  return typeof maxWidth === "number" ? maxWidth - 40 : undefined;
}

function pushTrace(
  phase: string,
  operation: "runtime-context" | "config-load",
  edge: "start" | "complete",
  generation?: number,
): void {
  instrumentation.trace.push({
    sequence: instrumentation.trace.length,
    phase,
    operation,
    edge,
    atMs: Date.now(),
    ...(generation === undefined ? {} : { configGeneration: generation }),
  });
}

vi.mock("../src/lib/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/config.js")>();
  return {
    ...actual,
    loadConfig: async (...args: Parameters<typeof actual.loadConfig>) => {
      const phase = instrumentation.currentContextPhase ?? "refresh-home";
      pushTrace(phase, "config-load", "start");
      await new Promise<void>((resolve) => {
        setTimeout(resolve, instrumentation.controlledDelayMs);
      });
      const config = await actual.loadConfig(...args);
      pushTrace(phase, "config-load", "complete", configGeneration(config));
      return config;
    },
  };
});

vi.mock("../src/lib/quota-runtime-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/quota-runtime-context.js")>();
  return {
    ...actual,
    resolveQuotaRuntimeContext: (
      params: Parameters<typeof actual.resolveQuotaRuntimeContext>[0],
    ) => {
      const phase = params.sessionID
        ? (instrumentation.currentSessionPhase ?? "refresh-session")
        : (instrumentation.currentTopPhase ?? "refresh-home");
      pushTrace(phase, "runtime-context", "start");
      const previous = instrumentation.currentContextPhase;
      instrumentation.currentContextPhase = phase;
      let result: ReturnType<typeof actual.resolveQuotaRuntimeContext>;
      try {
        result = actual.resolveQuotaRuntimeContext(params);
      } finally {
        instrumentation.currentContextPhase = previous;
      }
      return result.then((runtime) => {
        pushTrace(phase, "runtime-context", "complete", configGeneration(runtime.config));
        return runtime;
      });
    },
  };
});

function classifySessionPhase(): StartupRuntimePhase {
  const now = Date.now();
  if (instrumentation.sessionFirstStartMs === undefined) {
    instrumentation.sessionFirstStartMs = now;
    return "initial-session";
  }
  if (instrumentation.eventTriggerTimes.has(now)) return "event-session";
  const elapsed = now - instrumentation.sessionFirstStartMs;
  if (elapsed >= 60_000) return "interval-session";
  if (elapsed === 500 || elapsed === 1_500 || elapsed === 4_000) return "recovery-session";
  return "refresh-session";
}

function classifyHomePhase(): StartupRuntimePhase {
  const now = Date.now();
  if (instrumentation.homeFirstStartMs === undefined) {
    instrumentation.homeFirstStartMs = now;
    return "initial-home";
  }
  if (instrumentation.eventTriggerTimes.has(now)) return "event-home";
  if (now - instrumentation.homeFirstStartMs >= 60_000) return "interval-home";
  return "refresh-home";
}

vi.mock("../src/lib/tui-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/tui-runtime.js")>();
  return {
    ...actual,
    resolveTuiSurfaceRegistration: (
      ...args: Parameters<typeof actual.resolveTuiSurfaceRegistration>
    ) => {
      const previous = instrumentation.currentTopPhase;
      instrumentation.currentTopPhase = "registration";
      try {
        return actual.resolveTuiSurfaceRegistration(...args);
      } finally {
        instrumentation.currentTopPhase = previous;
      }
    },
    loadTuiSessionQuotaSurfaces: (
      ...args: Parameters<typeof actual.loadTuiSessionQuotaSurfaces>
    ) => {
      const phase = classifySessionPhase();
      instrumentation.sessionLoaderInvocations += 1;
      const previous = instrumentation.currentSessionPhase;
      instrumentation.currentSessionPhase = phase;
      try {
        return actual.loadTuiSessionQuotaSurfaces(...args);
      } finally {
        instrumentation.currentSessionPhase = previous;
      }
    },
    loadTuiHomeBottomStatus: (...args: Parameters<typeof actual.loadTuiHomeBottomStatus>) => {
      const phase = classifyHomePhase();
      instrumentation.homeLoaderInvocations += 1;
      const previous = instrumentation.currentTopPhase;
      instrumentation.currentTopPhase = phase;
      try {
        return actual.loadTuiHomeBottomStatus(...args);
      } finally {
        instrumentation.currentTopPhase = previous;
      }
    },
    writeTuiQuotaExportIfEnabled: (
      ...args: Parameters<typeof actual.writeTuiQuotaExportIfEnabled>
    ) => {
      const previous = instrumentation.currentTopPhase;
      instrumentation.currentTopPhase = "home-export";
      try {
        return actual.writeTuiQuotaExportIfEnabled(...args);
      } finally {
        instrumentation.currentTopPhase = previous;
      }
    },
  };
});

vi.mock("../src/lib/quota-render-data.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/quota-render-data.js")>();
  return {
    ...actual,
    collectQuotaRenderData: vi.fn(async () => ({
      active: [],
      data: { entries: [], errors: [], sessionTokens: undefined },
    })),
  };
});

vi.mock("../src/lib/tui-compact-format.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/tui-compact-format.js")>();
  return {
    ...actual,
    buildCompactQuotaStatusLine: vi.fn(
      (params: { maxWidth?: number }) => `generation-${(params.maxWidth ?? 40) - 40}`,
    ),
  };
});

vi.mock("../src/lib/tui-sidebar-format.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/tui-sidebar-format.js")>();
  return {
    ...actual,
    buildSidebarQuotaPanelLines: vi.fn(
      (params: { config: { tuiCompactStatus: { maxWidth: number } } }) => [
        `generation-${params.config.tuiCompactStatus.maxWidth - 40}`,
      ],
    ),
  };
});

vi.mock("solid-js", () => ({
  Show: (props: { when: unknown; children?: unknown; fallback?: unknown }) => {
    if (!props.when) return props.fallback ?? null;
    return typeof props.children === "function"
      ? (props.children as (value: unknown) => unknown)(props.when)
      : props.children;
  },
  createEffect: (fn: () => void) => fn(),
  createSignal: <T>(initial: T) => {
    let value = initial;
    return [
      () => value,
      (next: T | ((previous: T) => T)) => {
        value = typeof next === "function" ? (next as (previous: T) => T)(value) : next;
        return value;
      },
    ];
  },
  onCleanup: (fn: () => void) => {
    instrumentation.cleanupFns.push(fn);
  },
}));

vi.mock("@opentui/solid/jsx-runtime", () => ({
  Fragment: Symbol.for("Fragment"),
  jsx: (type: unknown, props: Record<string, unknown>) =>
    typeof type === "function" ? type(props) : { type, props },
  jsxs: (type: unknown, props: Record<string, unknown>) =>
    typeof type === "function" ? type(props) : { type, props },
}));

import {
  formatStartupRuntimeReport,
  runStartupRuntimeSamples,
  TUI_RUNTIME_RESOLUTION_HORIZON_MS,
} from "./helpers/tui-startup-runtime-resolution.js";

const originalCwd = process.cwd();
const originalEnv = { ...process.env };
const reportResults: StartupRuntimeResult[] = [];
const plugin = (await import("../src/tui.tsx")).default;

function createElement(
  type: unknown,
  props: Record<string, unknown> | null,
  ...children: unknown[]
) {
  const nextProps = {
    ...(props ?? {}),
    ...(children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }),
  };
  return typeof type === "function" ? type(nextProps) : { type, props: nextProps };
}

function writeGenerationConfig(worktreeDir: string, generation: number): void {
  writeFileSync(
    join(worktreeDir, "opencode.json"),
    JSON.stringify({
      experimental: {
        quotaToast: {
          enabled: true,
          onlyCurrentModel: false,
          export: { enabled: false },
          maintainerAnnouncements: { enabled: false, home: false },
          tuiSidebarPanel: { enabled: true },
          tuiPromptBar: { enabled: false },
          tuiCompactStatus: {
            enabled: true,
            homeBottom: true,
            sessionPrompt: true,
            suppressWhenNativeProviderQuota: false,
            maxWidth: 40 + generation,
          },
        },
      },
    }),
    "utf8",
  );
}

function createApi(worktreeDir: string) {
  const registered: Array<{
    order?: number;
    slots: Record<string, (ctx: unknown, props: Record<string, unknown>) => unknown>;
  }> = [];
  const lifecycleCallbacks: Array<() => void> = [];
  const eventHandlers = new Map<string, Array<(event: unknown) => void>>();
  const api = {
    route: { current: { name: "session", params: { sessionID: "session-1" } } },
    state: {
      provider: [],
      path: { worktree: worktreeDir, directory: worktreeDir },
      session: { messages: () => [] },
    },
    theme: { current: { text: "text", textMuted: "muted" } },
    ui: {
      Prompt: (props: Record<string, unknown>) => ({ type: "Prompt", props }),
      DialogPrompt: (props: Record<string, unknown>) => ({ type: "DialogPrompt", props }),
      dialog: { setSize: vi.fn(), replace: vi.fn(), clear: vi.fn() },
      toast: vi.fn(),
    },
    kv: { get: vi.fn((_key: string, fallback: unknown) => fallback), set: vi.fn() },
    event: {
      on: vi.fn((eventName: string, handler: (event: unknown) => void) => {
        const handlers = eventHandlers.get(eventName) ?? [];
        handlers.push(handler);
        eventHandlers.set(eventName, handlers);
        return vi.fn();
      }),
    },
    slots: {
      register: vi.fn(
        (registration: {
          order?: number;
          slots: Record<string, (ctx: unknown, props: Record<string, unknown>) => unknown>;
        }) => {
          registered.push(registration);
          return `slot-${registered.length}`;
        },
      ),
    },
    lifecycle: {
      onDispose: vi.fn((callback: () => void) => {
        lifecycleCallbacks.push(callback);
      }),
    },
    keymap: { registerLayer: vi.fn(() => vi.fn()) },
    client: {
      app: { log: vi.fn().mockResolvedValue(undefined) },
      config: { get: vi.fn().mockResolvedValue({ data: {} }) },
      session: { prompt: vi.fn(), command: vi.fn() },
    },
  };
  return { api, registered, lifecycleCallbacks, eventHandlers };
}

function containsText(value: unknown, expected: string, seen = new Set<unknown>()): boolean {
  if (value === expected) return true;
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  return Object.values(value as Record<string, unknown>).some((child) =>
    Array.isArray(child)
      ? child.some((item) => containsText(item, expected, seen))
      : containsText(child, expected, seen),
  );
}

async function flushAsyncWork(configPath: string): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await readFile(configPath, "utf8");
    await Promise.resolve();
    await Promise.resolve();
  }
}

function resetInstrumentation(controlledDelayMs: number): void {
  instrumentation.controlledDelayMs = controlledDelayMs;
  instrumentation.currentTopPhase = undefined;
  instrumentation.currentSessionPhase = undefined;
  instrumentation.currentContextPhase = undefined;
  instrumentation.trace.length = 0;
  instrumentation.sessionLoaderInvocations = 0;
  instrumentation.homeLoaderInvocations = 0;
  instrumentation.sessionFirstStartMs = undefined;
  instrumentation.homeFirstStartMs = undefined;
  instrumentation.eventTriggerTimes.clear();
  instrumentation.cleanupFns.length = 0;
}

type StartedScenario = {
  worktreeDir: string;
  configPath: string;
  api: ReturnType<typeof createApi>["api"];
  registered: ReturnType<typeof createApi>["registered"];
  lifecycleCallbacks: Array<() => void>;
  eventHandlers: ReturnType<typeof createApi>["eventHandlers"];
  mountAtMs: number;
  milestones: StartupRuntimeSample["milestones"];
  rendered: StartupRuntimeSample["rendered"];
  observeGeneration: (generation: number) => StartupRuntimeSample["rendered"];
  advanceTo: (targetMs: number) => Promise<void>;
  emit: (eventName: string, event: unknown) => void;
  cleanup: () => void;
};

async function startScenario(controlledDelayMs: number): Promise<StartedScenario> {
  vi.clearAllTimers();
  vi.setSystemTime(0);
  resetInstrumentation(controlledDelayMs);

  const tempDir = mkdtempSync(join(tmpdir(), "opencode-quota-tui-resolution-"));
  const worktreeDir = join(tempDir, "worktree");
  const xdgConfigHome = join(tempDir, "xdg-config");
  mkdirSync(worktreeDir, { recursive: true });
  mkdirSync(join(xdgConfigHome, "opencode"), { recursive: true });
  process.env.HOME = tempDir;
  process.env.XDG_CONFIG_HOME = xdgConfigHome;
  process.env.XDG_DATA_HOME = join(tempDir, "xdg-data");
  process.env.XDG_CACHE_HOME = join(tempDir, "xdg-cache");
  process.env.XDG_STATE_HOME = join(tempDir, "xdg-state");
  delete process.env.OPENCODE_CONFIG_DIR;
  writeGenerationConfig(worktreeDir, 1);
  const configPath = join(worktreeDir, "opencode.json");
  const { api, registered, lifecycleCallbacks, eventHandlers } = createApi(worktreeDir);

  await plugin.tui(api as never, undefined, {} as never);
  const sidebarRegistration = registered.find((entry) => entry.order === 150);
  const compactRegistration = registered.find((entry) => entry.order === 90);
  if (!sidebarRegistration || !compactRegistration) {
    throw new Error("TUI startup harness did not receive the expected slot registrations");
  }
  const sidebarSlot = () => sidebarRegistration.slots.sidebar_content;
  const compactSlots = () => compactRegistration.slots;

  expect(sidebarSlot()({}, { session_id: "session-1" })).toBeNull();
  expect(compactSlots().session_prompt({}, { session_id: "session-1" })).toBeNull();
  expect(compactSlots().home_bottom({}, {})).toBeNull();

  await vi.advanceTimersToNextTimerAsync();
  await flushAsyncWork(configPath);
  const mountAtMs = Date.now();

  sidebarSlot()({}, { session_id: "session-1" });
  compactSlots().session_prompt({}, { session_id: "session-1" });
  compactSlots().home_bottom({}, {});

  const milestones: StartupRuntimeSample["milestones"] = {
    sidebarMs: null,
    compactMs: null,
    homeMs: null,
    firstContentMs: null,
    allInitialContentMs: null,
  };
  const rendered = { sidebar: false, compact: false, home: false };
  const observeGeneration = (generation: number) => {
    const expected = `generation-${generation}`;
    const observed = {
      sidebar: containsText(sidebarSlot()({}, { session_id: "session-1" }), expected),
      compact: containsText(
        compactSlots().session_prompt({}, { session_id: "session-1" }),
        expected,
      ),
      home: containsText(compactSlots().home_bottom({}, {}), expected),
    };
    return observed;
  };

  while (
    milestones.allInitialContentMs === null &&
    Date.now() < TUI_RUNTIME_RESOLUTION_HORIZON_MS
  ) {
    await flushAsyncWork(configPath);
    const observed = observeGeneration(1);
    for (const key of ["sidebar", "compact", "home"] as const) {
      if (!rendered[key] && observed[key]) {
        rendered[key] = true;
        milestones[`${key}Ms` as "sidebarMs" | "compactMs" | "homeMs"] = Date.now();
      }
    }
    const accepted = [milestones.sidebarMs, milestones.compactMs, milestones.homeMs];
    const recorded = accepted.filter((value): value is number => value !== null);
    milestones.firstContentMs = recorded.length > 0 ? Math.min(...recorded) : null;
    milestones.allInitialContentMs = recorded.length === 3 ? Math.max(...recorded) : null;
    if (milestones.allInitialContentMs === null) {
      await vi.advanceTimersToNextTimerAsync();
    }
  }

  return {
    worktreeDir,
    configPath,
    api,
    registered,
    lifecycleCallbacks,
    eventHandlers,
    mountAtMs,
    milestones,
    rendered,
    observeGeneration,
    advanceTo: async (targetMs: number) => {
      if (targetMs < Date.now())
        throw new Error(`Cannot move virtual time backwards to ${targetMs}`);
      await vi.advanceTimersByTimeAsync(targetMs - Date.now());
      await flushAsyncWork(configPath);
    },
    emit: (eventName: string, event: unknown) => {
      for (const handler of eventHandlers.get(eventName) ?? []) handler(event);
    },
    cleanup: () => {
      for (const cleanup of instrumentation.cleanupFns.splice(0).reverse()) cleanup();
      for (const callback of lifecycleCallbacks.splice(0).reverse()) callback();
      vi.clearAllTimers();
      process.chdir(originalCwd);
      process.env = { ...originalEnv };
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

async function runInitialSample(
  controlledDelayMs: number,
  _sampleIndex: number,
): Promise<StartupRuntimeSample> {
  const scenario = await startScenario(controlledDelayMs);
  try {
    return {
      controlledDelayMs,
      milestones: { ...scenario.milestones },
      trace: instrumentation.trace.map((event) => ({
        ...event,
        phase: event.phase as StartupRuntimePhase,
      })) as StartupTraceEvent[],
      sessionLoaderInvocations: instrumentation.sessionLoaderInvocations,
      homeLoaderInvocations: instrumentation.homeLoaderInvocations,
      rendered: { ...scenario.rendered },
    };
  } finally {
    scenario.cleanup();
  }
}

beforeAll(() => {
  vi.useFakeTimers();
  (globalThis as { React?: unknown }).React = { createElement };
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const cleanup of instrumentation.cleanupFns.splice(0).reverse()) cleanup();
  vi.clearAllTimers();
});

afterAll(() => {
  if (process.env.OPENCODE_QUOTA_TUI_RUNTIME_RESOLUTION_REPORT === "1") {
    console.log(`\n${formatStartupRuntimeReport(reportResults)}`);
  }
  process.chdir(originalCwd);
  process.env = { ...originalEnv };
  vi.useRealTimers();
  delete (globalThis as { React?: unknown }).React;
});

describe("TUI startup runtime/config resolution", () => {
  it("measures deterministic 25 ms and 100 ms startup samples through real TUI slots", async () => {
    for (const controlledDelayMs of [25, 100]) {
      const result = await runStartupRuntimeSamples(controlledDelayMs, runInitialSample);
      reportResults.push(result);

      expect(result.distinctCountVectors).toHaveLength(1);
      expect(result.milestones.firstContentMs).toMatchObject({
        median: controlledDelayMs,
        p95: controlledDelayMs,
      });
      expect(result.milestones.allInitialContentMs).toMatchObject({
        median: controlledDelayMs,
        p95: controlledDelayMs,
      });
      expect(result.countsAtMilestones.allInitialContentMs).toEqual(
        Array.from({ length: 30 }, () => ({
          runtimeStarts: 3,
          runtimeCompletions: 3,
          configStarts: 1,
          configCompletions: 1,
        })),
      );
      for (const metric of Object.values(result.milestones)) {
        expect(metric.censored).toBe(0);
      }
      expect(result.samples.every((sample) => Object.values(sample.rendered).every(Boolean))).toBe(
        true,
      );
      expect(
        result.samples.every((sample) =>
          ["registration", "initial-session", "initial-home", "home-export"].every((phase) =>
            sample.trace.some(
              (event) => event.phase === phase && event.operation === "runtime-context",
            ),
          ),
        ),
      ).toBe(true);
    }
  });

  it("shares the initial sidebar and compact load, then rereads config on mount recovery", async () => {
    const scenario = await startScenario(25);
    try {
      expect(scenario.rendered).toEqual({ sidebar: true, compact: true, home: true });
      expect(instrumentation.sessionLoaderInvocations).toBe(1);
      writeGenerationConfig(scenario.worktreeDir, 2);

      await scenario.advanceTo(scenario.mountAtMs + 500);
      await scenario.advanceTo(scenario.mountAtMs + 525);

      expect(scenario.observeGeneration(2)).toMatchObject({ sidebar: true, compact: true });
      expect(
        instrumentation.trace.some(
          (event) =>
            event.phase === "recovery-session" &&
            event.operation === "config-load" &&
            event.edge === "complete" &&
            event.configGeneration === 2,
        ),
      ).toBe(true);
    } finally {
      scenario.cleanup();
    }
  });

  it("rereads config for the 150 ms and 600 ms event refreshes", async () => {
    const scenario = await startScenario(25);
    try {
      writeGenerationConfig(scenario.worktreeDir, 2);
      const eventAtMs = Date.now();
      instrumentation.eventTriggerTimes.add(eventAtMs + 150);
      instrumentation.eventTriggerTimes.add(eventAtMs + 600);
      scenario.emit("session.updated", { properties: { info: { id: "session-1" } } });

      await scenario.advanceTo(eventAtMs + 150);
      await scenario.advanceTo(eventAtMs + 175);
      expect(scenario.observeGeneration(2)).toEqual({ sidebar: true, compact: true, home: true });

      await scenario.advanceTo(scenario.mountAtMs + 500);
      await scenario.advanceTo(scenario.mountAtMs + 525);
      writeGenerationConfig(scenario.worktreeDir, 3);
      await scenario.advanceTo(eventAtMs + 600);
      await scenario.advanceTo(eventAtMs + 625);
      expect(scenario.observeGeneration(3)).toEqual({ sidebar: true, compact: true, home: true });

      for (const phase of ["event-session", "event-home"] as const) {
        expect(
          instrumentation.trace.some(
            (event) =>
              event.phase === phase &&
              event.operation === "config-load" &&
              event.edge === "complete" &&
              event.configGeneration === 3,
          ),
        ).toBe(true);
      }
    } finally {
      scenario.cleanup();
    }
  });

  it("rereads current config on the 60 second interval after recovery loads", async () => {
    const scenario = await startScenario(25);
    try {
      writeGenerationConfig(scenario.worktreeDir, 2);
      for (const recoveryDelay of [500, 1_500, 4_000]) {
        await scenario.advanceTo(scenario.mountAtMs + recoveryDelay);
        await scenario.advanceTo(scenario.mountAtMs + recoveryDelay + 25);
      }
      writeGenerationConfig(scenario.worktreeDir, 3);

      await scenario.advanceTo(scenario.mountAtMs + 60_000);
      await scenario.advanceTo(scenario.mountAtMs + 60_025);
      expect(scenario.observeGeneration(3)).toEqual({ sidebar: true, compact: true, home: true });

      for (const phase of ["interval-session", "interval-home"] as const) {
        expect(
          instrumentation.trace.some(
            (event) =>
              event.phase === phase &&
              event.operation === "config-load" &&
              event.edge === "complete" &&
              event.configGeneration === 3,
          ),
        ).toBe(true);
      }
    } finally {
      scenario.cleanup();
    }
  });
});
