import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const buildOutput = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/quota-dialog-commands.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/quota-dialog-commands.js")>()),
  statusReport: buildOutput,
}));
const resolveRetryDelay = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/quota-retry-wait.js", () => ({
  resolveQuotaResetRetryDelayMs: resolveRetryDelay,
}));

import {
  clearCredentialRowCacheForTests,
  getCredentialSourceDiagnostics,
  readActiveCredentialRowsCached,
  readCredentialRows,
} from "../src/lib/opencode-auth.js";
import { formatQuotaReportMessage } from "../src/lib/quota-report-message.js";
import plugin from "../src/plugin.js";
import { settingsPath } from "../src/settings/file.js";
import { createFakeIntegration } from "./helpers/fake-integration.js";
import { createServerContext, type ServerCommand } from "./helpers/plugin-test-harness.js";

type Part = { type: string; text?: string };
type Message = { role: string; metadata?: Record<string, unknown>; content: Part[] };
type HookEvent = { messages: Message[]; result?: string };
type RetryEvent = {
  sessionID: string;
  agent: string;
  model: { id: string; providerID: string };
  error: { type: string; message: string; status?: number };
  attempt: number;
  decision: { retry: false } | { retry: true; delay: number };
};

/** A server context whose sessions use gpt-5 from OpenAI, the one provider OpenCode lists. */
function createContext() {
  return createServerContext({
    directory: "/tmp/opencode/quota-plugin-v2",
    openCodeProviders: ["openai"],
    sessionGet: vi.fn().mockResolvedValue({ model: { id: "gpt-5", providerID: "openai" } }),
  });
}

function runCommand(commands: ServerCommand[], name: string, text = "") {
  const found = commands.find((item) => item.name === name);
  if (!found) throw new Error(`Command not registered: ${name}`);
  return found.execute({ sessionID: "session-web", prompt: { text }, delivery: "queue" });
}

function hook(hooks: Map<string, unknown>, name: string) {
  const found = hooks.get(name);
  if (!found) throw new Error(`Hook not registered: ${name}`);
  return found as (event: HookEvent) => void;
}

const user = (text: string, metadata?: Record<string, unknown>): Message => ({
  role: "user",
  ...(metadata ? { metadata } : {}),
  content: [{ type: "text", text }],
});

describe("V2 server plugin", () => {
  beforeEach(() => {
    buildOutput.mockReset();
    resolveRetryDelay.mockReset();
  });

  it("registers the quota diagnostics tool without a server toast dependency or V1 command hooks", async () => {
    const { ctx, tools } = createContext();
    buildOutput.mockResolvedValue({ text: "Quota ready", json: { providers: [] } });

    await plugin.setup(ctx as never);
    expect(tools.map((tool) => tool.name)).toEqual([
      "quota_settings_get",
      "quota_settings_set",
      "quota_provider_add",
      "quota_provider_test",
      "quota_provider_remove",
      "quota_status",
    ]);
    const quotaStatus = tools.find((tool) => tool.name === "quota_status");
    const output = await quotaStatus?.execute({}, { sessionID: "session-test" });
    expect(output).toEqual({ content: "Quota ready" });
    expect(ctx.provider.list).toHaveBeenCalledTimes(0);
    // The report gets the session's model from OpenCode and no agent settings.
    expect(ctx.session.get).toHaveBeenCalledWith({ sessionID: "session-test" });
    const [, options] = buildOutput.mock.calls[0];
    expect(options).toMatchObject({
      origin: "tool",
      sessionModel: { id: "gpt-5", providerID: "openai" },
    });
    expect(options).not.toHaveProperty("agent");
    expect(options).not.toHaveProperty("default_agent");
    expect(ctx.tool.transform).toHaveBeenCalledOnce();
    expect(ctx.command.transform).toHaveBeenCalledOnce();
    expect((plugin as Record<string, unknown>)["command.execute.before"]).toBeUndefined();
    expect((plugin as Record<string, unknown>).config).toBeUndefined();
  });

  it("registers /quota, /quota_status, /quota_usage and the /tokens_* names for Web and Desktop", async () => {
    const { ctx, commands } = createContext();

    await plugin.setup(ctx as never);
    expect(commands.map((item) => item.name).slice(0, 4)).toEqual([
      "quota",
      "quota_status",
      "quota_usage",
      "tokens_today",
    ]);
    expect(commands.every((item) => item.description)).toBe(true);
  });

  it("lists the 4.x and 5.x /tokens_* commands until system.oldCommands is off", async () => {
    const path = settingsPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({}));
    const { ctx, commands } = createContext();
    const dispose = await plugin.setup(ctx as never);
    try {
      expect(commands.map((item) => item.name)).toEqual([
        "quota",
        "quota_status",
        "quota_usage",
        "tokens_today",
        "tokens_daily",
        "tokens_weekly",
        "tokens_monthly",
        "tokens_all",
        "tokens_session",
        "tokens_session_all",
        "tokens_between",
      ]);
      // Each is /quota_usage on its range, so the range's rules apply.
      await runCommand(commands, "tokens_between", "2026-10-02 2026-10-01");
      expect(ctx.session.prompt.mock.calls[0][0]).toMatchObject({
        text: expect.stringContaining("2026-10-01 is before 2026-10-02."),
        metadata: { opencodeQuota: { command: "tokens_between" } },
      });

      writeFileSync(path, JSON.stringify({ system: { oldCommands: false } }));
      await vi.waitFor(() => expect(ctx.command.reload).toHaveBeenCalledOnce(), {
        timeout: 10_000,
      });
      expect(commands.map((item) => item.name)).toEqual(["quota", "quota_status", "quota_usage"]);
    } finally {
      await dispose?.();
      rmSync(path, { force: true });
    }
  });

  it("posts the report as a user message that never starts a model turn", async () => {
    const { ctx, commands } = createContext();
    buildOutput.mockResolvedValue({
      text: "# Quota\nopenai 42%\u001b[31m",
      json: { providers: [] },
    });
    vi.spyOn(Date, "now").mockReturnValue(1_790_000_000_000);

    await plugin.setup(ctx as never);
    await runCommand(commands, "quota_status");

    expect(ctx.session.get).toHaveBeenCalledWith({ sessionID: "session-web" });
    expect(buildOutput).toHaveBeenCalledOnce();
    expect(ctx.session.wait).toHaveBeenCalledExactlyOnceWith({ sessionID: "session-web" });
    expect(ctx.session.wait).toHaveBeenCalledBefore(ctx.session.prompt);
    expect(ctx.session.prompt).toHaveBeenCalledTimes(1);
    expect(ctx.session.prompt.mock.calls[0][0]).toEqual({
      sessionID: "session-web",
      text: formatQuotaReportMessage("# Quota\nopenai 42%"),
      metadata: { opencodeQuota: { command: "quota_status", at: 1_790_000_000_000 } },
      delivery: "steer",
      resume: false,
    });
    vi.mocked(Date.now).mockRestore();
  });

  it.each([
    ["session_tree", 'Unknown range "session_tree".'],
    ["between 2026-09-01", "between needs two dates."],
    ["between 2026-09-31 2026-10-01", '"2026-09-31" is not a date like 2026-01-31.'],
    ["between 2026-10-02 2026-10-01", "2026-10-01 is before 2026-10-02."],
    ["today please", "The range today takes no dates."],
  ])("answers /quota_usage %s with a clear error and how to use it", async (text, problem) => {
    const { ctx, commands } = createContext();

    await plugin.setup(ctx as never);
    await runCommand(commands, "quota_usage", text);

    expect(ctx.session.prompt.mock.calls[0][0].text).toBe(
      formatQuotaReportMessage(
        `${problem}\nUsage: /quota_usage [today | 24h | 7d | 30d | 90d | all | session | between YYYY-MM-DD YYYY-MM-DD]`,
      ),
    );
  });

  it("removes only tagged quota reports from model requests", async () => {
    const { ctx, hooks } = createContext();
    await plugin.setup(ctx as never);
    const report = formatQuotaReportMessage("openai 42%");

    expect([...hooks.keys()]).toEqual(["context", "compaction", "generate", "title", "retry"]);
    for (const name of ["context", "compaction", "generate"]) {
      const tagged = user(report, { opencodeQuota: { command: "quota", title: "Quota", at: 1 } });
      const question = user("What is my quota?");
      const otherMetadata = user("Hello", { displayText: "Hello", comments: [] });
      const assistant: Message = {
        role: "assistant",
        metadata: { opencodeQuota: { command: "quota", title: "Quota", at: 1 } },
        content: [{ type: "text", text: "openai 42%" }],
      };
      const image: Message = { role: "user", content: [{ type: "media" }] };
      const event: HookEvent = {
        messages: [tagged, question, otherMetadata, assistant, image, { ...tagged }],
      };

      hook(hooks, name)(event);

      expect(event.messages).toEqual([question, otherMetadata, assistant, image]);
      expect(event.messages[0]).toBe(question);
      expect(event.messages[1]).toBe(otherMetadata);
    }
  });

  it("cuts reports out of compaction checkpoint text and keeps the rest", async () => {
    const { ctx, hooks } = createContext();
    await plugin.setup(ctx as never);
    const report = formatQuotaReportMessage("openai 42%\nanthropic 7%");
    const checkpoint: Message = {
      role: "user",
      content: [
        {
          type: "text",
          text: `<recent-context>\n[User]: Fix the bug\n\n[User]: ${report}\n\n[Assistant]: Done\n</recent-context>`,
        },
        { type: "text", text: "no report here" },
      ],
    };
    const assistantEcho: Message = { role: "assistant", content: [{ type: "text", text: report }] };

    for (const name of ["context", "compaction", "generate"]) {
      const event: HookEvent = { messages: [checkpoint, assistantEcho] };

      hook(hooks, name)(event);

      expect(event.messages[0].content).toEqual([
        {
          type: "text",
          text: "<recent-context>\n[User]: Fix the bug\n\n[User]: \n\n[Assistant]: Done\n</recent-context>",
        },
        { type: "text", text: "no report here" },
      ]);
      expect(event.messages[0].content[1]).toBe(checkpoint.content[1]);
      expect(event.messages[1]).toBe(assistantEcho);
    }
    expect(checkpoint.content[0].text).toContain("openai 42%");
  });

  it("never titles a session from a quota report", async () => {
    const { ctx, hooks } = createContext();
    await plugin.setup(ctx as never);
    const title = hook(hooks, "title");
    const report = formatQuotaReportMessage("openai 42%");

    const reportOnly: HookEvent = { messages: [user(report)] };
    title(reportOnly);
    expect(reportOnly.result).toBe("");
    expect(reportOnly.messages).toEqual([user("")]);

    const mixed: HookEvent = {
      messages: [user(`Original request:\n${report}\n\nRecent conversation:\nUser: Fix the bug`)],
    };
    title(mixed);
    expect(mixed.result).toBeUndefined();
    expect(mixed.messages).toEqual([
      user("Original request:\n\n\nRecent conversation:\nUser: Fix the bug"),
    ]);

    const plain = user("Fix the bug");
    const normal: HookEvent = { messages: [plain] };
    title(normal);
    expect(normal.result).toBeUndefined();
    expect(normal.messages[0]).toBe(plain);
  });

  it("retries at the quota reset only when the quota data gives a delay", async () => {
    const { ctx, hooks } = createContext();
    await plugin.setup(ctx as never);
    const retry = hook(hooks, "retry") as unknown as (event: RetryEvent) => Promise<void>;
    const event = (decision: RetryEvent["decision"]): RetryEvent => ({
      sessionID: "session-1",
      agent: "build",
      model: { id: "glm-4.6", providerID: "zai-coding-plan" },
      error: { type: "provider.quota", message: "Usage limit reached", status: 429 },
      attempt: 2,
      decision,
    });

    resolveRetryDelay.mockResolvedValueOnce(5_460_000);
    const waiting = event({ retry: false });
    await retry(waiting);
    expect(waiting.decision).toEqual({ retry: true, delay: 5_460_000 });
    // The retry reads quota through the server's store, and the settings on demand.
    expect(resolveRetryDelay).toHaveBeenCalledWith(
      {
        store: expect.objectContaining({ refresh: expect.any(Function) }),
        loadSettings: expect.any(Function),
      },
      waiting,
    );

    resolveRetryDelay.mockResolvedValueOnce(undefined);
    const unchanged = event({ retry: true, delay: 2_000 });
    await retry(unchanged);
    expect(unchanged.decision).toEqual({ retry: true, delay: 2_000 });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resolveRetryDelay.mockRejectedValueOnce(new Error("quota read failed"));
    const failed = event({ retry: false });
    await expect(retry(failed)).resolves.toBeUndefined();
    expect(failed.decision).toEqual({ retry: false });
    expect(warn).toHaveBeenCalledWith("[opencode-quota] retry hook failed: quota read failed");
    warn.mockRestore();
  });

  it("reads logins through ctx.integration from setup until cleanup", async () => {
    const { ctx } = createContext();
    const integration = createFakeIntegration([
      {
        integrationId: "deepseek",
        id: "cred_deepseek",
        label: "default",
        registered: true,
        method: "key",
        value: { type: "key", key: "deepseek-key" },
      },
    ]);
    const subscribe = vi.fn((_options: { signal: AbortSignal }) => ({
      async *[Symbol.asyncIterator]() {},
    }));

    const cleanup = await plugin.setup({ ...ctx, integration, event: { subscribe } } as never);
    expect(getCredentialSourceDiagnostics()).toMatchObject({
      state: "bound",
      kind: "opencode-integration-api",
    });
    await expect(readCredentialRows(["deepseek"], { firstOnly: true })).resolves.toEqual([
      expect.objectContaining({ value: { type: "api", key: "deepseek-key" } }),
    ]);
    const signal = subscribe.mock.calls[0]?.[0].signal;
    expect(signal?.aborted).toBe(false);

    await cleanup?.();
    expect(signal?.aborted).toBe(true);
    // Only this setup's binding is gone; earlier tests' empty fakes hold no deepseek login.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(readCredentialRows(["deepseek"], { firstOnly: true })).resolves.toEqual([]);
    warn.mockRestore();
    expect(integration.connection.active).toHaveBeenCalledOnce();
  });

  it.each(["credential.updated", "credential.switched"])(
    "drops cached logins when OpenCode reports %s",
    async (type) => {
      clearCredentialRowCacheForTests();
      // The event makes the store check DeepSeek again; it gets a fake answer, not the real API.
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ error: "fake" }), { status: 401 })),
      );
      const { ctx } = createContext();
      const deepseek = {
        integrationId: "deepseek",
        id: "cred_deepseek",
        label: "default",
        registered: true,
        method: "key" as const,
        value: { type: "key", key: "old-key" } as Record<string, unknown>,
      };
      const integration = createFakeIntegration([deepseek]);
      let emit!: (event: { type: string; data: Record<string, unknown> }) => void;
      const nextEvent = new Promise<{ type: string; data: Record<string, unknown> }>((resolve) => {
        emit = resolve;
      });
      const subscribe = vi.fn(() => ({
        async *[Symbol.asyncIterator]() {
          yield { type: "session.idle", data: {} };
          yield await nextEvent;
        },
      }));
      const cleanup = await plugin.setup({ ...ctx, integration, event: { subscribe } } as never);
      const readKey = async () =>
        (
          await readActiveCredentialRowsCached({ maxAgeMs: 60_000, integrationIds: ["deepseek"] })
        )[0]?.value.key;

      await expect(readKey()).resolves.toBe("old-key");
      deepseek.value = { type: "key", key: "new-key" };
      await expect(readKey()).resolves.toBe("old-key");

      emit({ type, data: { integrationID: "deepseek", credentialID: "cred_deepseek" } });
      await vi.waitFor(async () => expect(await readKey()).toBe("new-key"));
      await cleanup?.();
    },
  );

  it("logs why the credential event subscription stopped, without tokens", async () => {
    const { ctx } = createContext();
    const token = `eyJ${"a".repeat(24)}.${"b".repeat(24)}.${"c".repeat(24)}`;
    const subscribe = vi.fn(() => ({
      // oxlint-disable-next-line require-yield -- the stream fails before its first event
      async *[Symbol.asyncIterator]() {
        throw new Error(`event stream closed ${token}`);
      },
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const cleanup = await plugin.setup({ ...ctx, event: { subscribe } } as never);
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        "[opencode-quota] credential event subscription stopped: event stream closed [redacted]",
      ),
    );
    await cleanup?.();
    warn.mockRestore();
  });

  it("stops the credential event subscription silently on cleanup", async () => {
    const { ctx } = createContext();
    const subscribe = vi.fn(({ signal }: { signal: AbortSignal }) => ({
      // oxlint-disable-next-line require-yield -- the stream is aborted before its first event
      async *[Symbol.asyncIterator]() {
        await new Promise((resolve) => signal.addEventListener("abort", resolve));
        throw new DOMException("This operation was aborted", "AbortError");
      },
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const cleanup = await plugin.setup({ ...ctx, event: { subscribe } } as never);
    await cleanup?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(warn.mock.calls.flat().join("\n")).not.toContain("credential event subscription");
    warn.mockRestore();
  });
});
