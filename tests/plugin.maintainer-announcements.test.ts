import { QUOTA_PROVIDER_CATALOG } from "../src/lib/provider-metadata.js";

const CONFIG_PROVIDER_IDS = Object.keys(QUOTA_PROVIDER_CATALOG).map((id) =>
  id === "quota-providers" ? "custom" : id,
);

import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { answer, percentRow } from "./helpers/fake-answers.js";
import { createFakeTuiHost, stubJsx } from "./helpers/fake-tui-host.js";
import { useOpencodeFolders } from "./helpers/opencode-folders.js";
import {
  createServerContext,
  seedDefaultPluginBootstrapMocks,
  writePluginTestSettings,
} from "./helpers/plugin-test-harness.js";
import { createQuotaRpcBridge } from "./helpers/quota-rpc-bridge.js";

const folders = useOpencodeFolders();
const TEST_RUNTIME_ROOT = folders.root;
const ANNOUNCEMENT_HOME_MESSAGE = "Notice: 1 maintainer notice, see /quota_status.";

const TEST_ANNOUNCEMENT = vi.hoisted(() => ({
  id: "copilot-credits",
  message: "If you use Copilot, GitHub billing is moving to AI Credits.",
  url: "https://github.blog/example",
  endsAt: "2027-01-01T00:00:00.000Z",
  providerIds: ["copilot"],
}));

const mocks = vi.hoisted(() => ({
  getProviders: vi.fn(),
}));

const announcementMocks = vi.hoisted(() => ({
  getMaintainerAnnouncementsSummary: vi.fn(),
}));

// Records the getters of the TUI's Solid signals, so a test can read what a view shows.
const signals = vi.hoisted(() => [] as Array<() => unknown>);
vi.mock("solid-js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("solid-js")>();
  return {
    ...actual,
    createSignal: ((...args: Parameters<typeof actual.createSignal>) => {
      const signal = actual.createSignal(...args);
      signals.push(signal[0]);
      return signal;
    }) as typeof actual.createSignal,
  };
});
vi.mock("../src/lib/maintainer-announcements.js", () => ({
  BUNDLED_MAINTAINER_ANNOUNCEMENTS: [TEST_ANNOUNCEMENT],
  getMaintainerAnnouncementsSummary: announcementMocks.getMaintainerAnnouncementsSummary,
}));

function makeAnnouncementSummary(overrides: Record<string, unknown> = {}) {
  return {
    source: "bundled_only",
    network: false,
    bundledCount: 1,
    activeCount: 1,
    futureCount: 0,
    expiredCount: 0,
    activeAnnouncements: [
      {
        announcement: TEST_ANNOUNCEMENT,
        active: true,
        reasons: [],
      },
    ],
    evaluations: [],
    ...overrides,
  };
}

/** Copilot with quota and the question toast enabled. */
function configureQuestionQuotaToast(): void {
  writePluginTestSettings(folders.configDir, {
    toast: { afterQuestion: true },
    providers: {
      off: CONFIG_PROVIDER_IDS.filter((id) => !["copilot"].includes(id)),
      checking: { minIntervalMs: 1 },
    },
  });
  mocks.getProviders.mockReturnValue([
    {
      id: "copilot",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi
        .fn()
        .mockResolvedValue(
          answer({ name: "Copilot", rows: [percentRow("premium", "Premium requests", 81)] }),
        ),
    },
  ]);
}

/** Starts the server plugin and the TUI plugin, joined by the quota RPC. */
async function startCli() {
  stubJsx();
  const { createQuotaServerPlugin } = await import("../src/plugin.js");
  const server = createQuotaServerPlugin({ providers: mocks.getProviders });
  const { ctx } = createServerContext({ openCodeProviders: ["copilot"] });
  const disposeServer = await server.setup(ctx as never);
  const [, serverHandlers] = ctx.rpc.register.mock.calls[0] as unknown as [
    unknown,
    Parameters<typeof createQuotaRpcBridge>[0],
  ];
  // Recorded, so a test can wait for the Home notice line the TUI asked for.
  const notices = vi.fn(serverHandlers.notices);
  const handlers = { ...serverHandlers, notices };
  const { default: plugin } = await import("../src/tui/index.js");
  const tui = createFakeTuiHost({
    rpc: createQuotaRpcBridge(handlers),
    theme: { text: { base: "base", muted: "muted" } },
  });
  const disposeTui = plugin.setup(tui.context as never);
  const renderHome = () => tui.render("home.footer.status");
  // Stops the TUI, then the server's store with its fetches and file writes.
  const dispose = async () => {
    (disposeTui as unknown as () => void)?.();
    await (disposeServer as unknown as () => Promise<void>)?.();
  };
  return { listeners: tui.listeners, toast: tui.toast, renderHome, notices, dispose };
}

async function flushMaintainerFallbackWork(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

describe("maintainer announcement plugin integration", () => {
  beforeEach(async () => {
    seedDefaultPluginBootstrapMocks(mocks, { resetPluginState: true });
    announcementMocks.getMaintainerAnnouncementsSummary
      .mockReset()
      .mockReturnValue(makeAnnouncementSummary());
    signals.length = 0;
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true, maxRetries: 3 });
  });

  it("shows the count-only announcement on Home instead of a toast", async () => {
    configureQuestionQuotaToast();
    const cli = await startCli();
    cli.renderHome();
    // The Home footer shows the notice line the server returns over the RPC.
    await vi.waitFor(() =>
      expect(signals.map((read) => read())).toContain(ANNOUNCEMENT_HOME_MESSAGE),
    );
    expect(announcementMocks.getMaintainerAnnouncementsSummary).toHaveBeenCalledWith(
      expect.objectContaining({ enabledProviders: ["copilot"] }),
    );

    cli.listeners.get("session.tool.input.started")?.({
      data: { id: "call-1", name: "question", sessionID: "session-question" },
    });
    cli.listeners.get("session.tool.success")?.({
      data: { id: "call-1", sessionID: "session-question" },
    });
    await vi.waitFor(() => expect(cli.toast).toHaveBeenCalledOnce());
    await flushMaintainerFallbackWork();
    expect(cli.toast).toHaveBeenCalledOnce();
    expect(cli.toast.mock.calls[0]?.[0].message).toContain("Copilot");
    expect(cli.toast.mock.calls[0]?.[0].message).not.toContain("Notice:");
    await cli.dispose();
  });

  it("does not show the Home announcement when no notice is active", async () => {
    configureQuestionQuotaToast();
    announcementMocks.getMaintainerAnnouncementsSummary.mockReturnValue(
      makeAnnouncementSummary({ activeCount: 0, activeAnnouncements: [] }),
    );
    const cli = await startCli();
    cli.renderHome();
    await vi.waitFor(() => expect(cli.notices).toHaveBeenCalled());
    await expect(cli.notices.mock.results[0]?.value).resolves.toEqual({ homeLine: "" });
    await flushMaintainerFallbackWork();

    expect(announcementMocks.getMaintainerAnnouncementsSummary).toHaveBeenCalled();
    await cli.dispose();
  });
});
