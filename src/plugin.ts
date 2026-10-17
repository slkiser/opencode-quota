/**
 * OpenCode V2 server plugin: quota slash commands for Web and Desktop, a diagnostics tool, and
 * the quota RPC that serves the quota snapshot, the Home notice line, active notices and reports
 * to the TUI. It reads the server settings (settings.jsonc, converted from v5 once) and follows
 * every change to them.
 * It also writes the export file and the OpenTelemetry gauges from each snapshot. Inside
 * OpenCode, logins are read only here, through OpenCode's integration API.
 */
import { Plugin } from "@opencode/plugin";
import { quotaAgentTools } from "./agent-tools.js";
import { snapshotFilePath } from "./core/persist.js";
import {
  loadProviderSource,
  loadServerSettings,
  type ProviderSourceHost,
} from "./core/provider-source.js";
import { safeErrorText } from "./core/redact.js";
import { createSnapshotPublisher } from "./core/snapshot-publisher.js";
import { createQuotaStore } from "./core/store.js";
import type { QuotaSnapshot, SessionModel } from "./core/types.js";
import { OLD_USAGE_COMMANDS } from "./core/usage-ranges.js";
import {
  parseUsageArguments,
  sessionUsage,
  type UsageQuery,
  type UsageReport,
  usageReport,
} from "./core/usage.js";
import { resolveOpenCodeLocationRoots } from "./lib/config-file-utils.js";
import { sanitizeDisplayText } from "./lib/display-sanitize.js";
import { homeNoticeLine, listNotices } from "./lib/maintainer-home-notice.js";
import { downloadPrices, refreshPricesIfDue } from "./lib/modelsdev-pricing.js";
import {
  bindCredentialSource,
  createIntegrationCredentialSource,
  notifyCredentialsChanged,
} from "./lib/opencode-auth.js";
import { reconcileDetectedProvidersInGlobalConfig } from "./lib/opencode-config-providers.js";
import { statusReport } from "./lib/quota-dialog-commands.js";
import { QUOTA_PROVIDERS_AGGREGATE_ID } from "./lib/quota-providers.js";
import {
  containsQuotaReport,
  formatQuotaReportMessage,
  QUOTA_REPORT_METADATA_KEY,
  type QuotaReportMetadata,
  quotaMessageText,
  removeQuotaReports,
} from "./lib/quota-report-message.js";
import { resolveQuotaResetRetryDelayMs } from "./lib/quota-retry-wait.js";
import type { StatusOrigin } from "./lib/quota-status.js";
import { QuotaRpc } from "./rpc.js";
import { clientSettings, createLiveSettings, loadSettings } from "./settings/index.js";
import { DEFAULT_QUICK_LOOK_RANGE } from "./view/quick-look.js";
import { usageText } from "./view/usage.js";

type ModelMessage = {
  readonly role: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string | null }>;
};

type ModelMessagePart = ModelMessage["content"][number];

function hasQuotaReportText(part: ModelMessagePart): boolean {
  return part.type === "text" && typeof part.text === "string" && containsQuotaReport(part.text);
}

/**
 * Drops quota report messages, found by their metadata, and cuts reports out of the text of
 * the remaining user messages. The cut covers compaction checkpoints, which hold copied
 * message text without its metadata, and title requests, which get plain text only.
 */
function withoutQuotaReports<M extends ModelMessage>(messages: M[]): M[] {
  return messages.flatMap((message): M[] => {
    if (message.role !== "user") return [message];
    if (message.metadata?.[QUOTA_REPORT_METADATA_KEY] !== undefined) return [];
    if (!message.content.some(hasQuotaReportText)) return [message];
    const content = message.content.map((part) =>
      hasQuotaReportText(part) ? { ...part, text: removeQuotaReports(part.text as string) } : part,
    );
    return [{ ...message, content }];
  });
}

/**
 * Runs an RPC handler and logs its failure in the OpenCode service before rethrowing it.
 * The client gets only OpenCode's `rpc.internal` error, so the reason shows only here.
 */
async function logRpcFailure<T>(method: string, handler: () => Promise<T>): Promise<T> {
  try {
    return await handler();
  } catch (error) {
    console.warn(`[opencode-quota] ${method} RPC failed: ${safeErrorText(error)}`);
    throw error;
  }
}

export const QuotaToastPlugin = Plugin.define({
  id: "@slkiser/opencode-quota.server",
  async setup(ctx) {
    const roots = resolveOpenCodeLocationRoots(ctx.location.directory);
    const projectDir = roots.workspaceRoot;
    // The providers ask OpenCode which providers it has through this small client.
    const client = {
      config: {
        providers: async () => ({
          data: {
            providers: (await ctx.provider.list()).data.map((provider) => ({ id: provider.id })),
          },
        }),
      },
    };

    // The server holds the settings it read last; every reader takes them from here.
    const liveSettings = await createLiveSettings({ projectDir });
    // /quota_status reports the providers it detected. The slash commands and
    // the tool add them to the global OpenCode config; the TUI palette (via RPC) never writes it.
    const buildStatusOutput = async (
      sessionID: string | undefined,
      options: { origin: StatusOrigin; reconcileDetectedProviders: boolean },
    ): Promise<string> => {
      const report = await statusReport(sourceHost, {
        origin: options.origin,
        opencode: ctx.app ? { version: ctx.app.version, channel: ctx.app.channel } : undefined,
        sessionModel: sessionID ? await sessionModel(sessionID) : undefined,
        conversion: liveSettings.conversion,
        nowMs: Date.now(),
      });
      const detected = report.json.providers
        .filter((provider) => provider.enabled && provider.available)
        .map((provider) => provider.id);
      if (options.reconcileDetectedProviders && detected.length > 0) {
        try {
          await reconcileDetectedProvidersInGlobalConfig({
            configRootDir: roots.configRoot,
            detectedProviderIds: detected,
          });
        } catch (error) {
          console.warn("Failed to add detected providers to global OpenCode config", error);
        }
      }
      return report.text;
    };

    // The v6 quota store: last known rows, saved in the state dir, refreshed in the background.
    // Building it reads nothing; the first snapshot or refresh call loads the file.
    const sourceHost: ProviderSourceHost = {
      client,
      workspaceRoot: roots.workspaceRoot,
      settings: liveSettings.current,
    };
    const store = createQuotaStore({
      source: () => loadProviderSource(sourceHost),
      file: snapshotFilePath(),
    });
    // The TUI reads the session model from its local store, which has nothing for an
    // unknown session. The RPC handlers match that: a failed lookup means no model.
    // With a session, a snapshot also names the providers serving its current model.
    const sessionModel = async (sessionID: string | undefined): Promise<SessionModel> => {
      if (!sessionID) return {};
      try {
        const session = await ctx.session.get({ sessionID });
        return { id: session.model?.id, providerID: session.model?.providerID };
      } catch {
        return {};
      }
    };
    // With a session, a snapshot also has the tokens the session used so far.
    const withSessionTokens = async (
      snapshot: QuotaSnapshot,
      sessionID: string | undefined,
    ): Promise<QuotaSnapshot> => {
      if (!sessionID) return snapshot;
      const sessionTokens = await sessionUsage(
        sessionID,
        liveSettings.current().settings.words.sessionTokens,
      );
      return sessionTokens ? { ...snapshot, sessionTokens } : snapshot;
    };
    // Every snapshot a client gets carries the server's words, the OpenCode provider of each
    // custom definition, and the settings, and none of the export parts the
    // server keeps for the export file.
    const forClients = (snapshot: QuotaSnapshot): QuotaSnapshot => {
      const { settings } = liveSettings.current();
      const custom = settings.providers.custom;
      return {
        ...snapshot,
        providers: snapshot.providers.map(({ exportPart: _serverOnly, ...provider }) => provider),
        words: settings.words,
        ...(custom.length > 0
          ? {
              customRowProviders: Object.fromEntries(
                custom.map((one) => [
                  `${QUOTA_PROVIDERS_AGGREGATE_ID}.custom.${one.id}.`,
                  one.providerId,
                ]),
              ),
            }
          : {}),
        settings: clientSettings(settings),
        ...(liveSettings.converted() ? { settingsConverted: true } : {}),
      };
    };

    // The usage report with the configured price list, after a due price download had its chance.
    const loadUsageReport = async (query: UsageQuery): Promise<UsageReport> => {
      await refreshPricesIfDue();
      return usageReport(query);
    };

    // A notice can target the users of some providers: the enabled and available ones,
    // found without asking any provider for quota.
    const noticeTargets = async () =>
      (await loadProviderSource(sourceHost)).providers.map(({ id }) => id);

    // Awaited so the plugin is active only once the RPC is registered: OpenCode waits for
    // activation before it routes an RPC call, so the first TUI call cannot miss it.
    const registration = await ctx.rpc.register(QuotaRpc, {
      snapshot: (input) =>
        logRpcFailure("snapshot", async () => {
          const snapshot = await store.snapshot({ model: await sessionModel(input.sessionID) });
          return { snapshot: forClients(await withSessionTokens(snapshot, input.sessionID)) };
        }),
      refresh: (input) =>
        logRpcFailure("refresh", async () => {
          const model = await sessionModel(input.sessionID);
          const options = { reason: input.reason, providerIds: input.providerIds, model };
          const snapshot = await store.refresh(options);
          return { snapshot: forClients(await withSessionTokens(snapshot, input.sessionID)) };
        }),
      notices: () =>
        logRpcFailure("notices", async () => ({
          homeLine: await homeNoticeLine({ providerIds: await noticeTargets() }),
        })),
      noticeList: () =>
        logRpcFailure("noticeList", async () => ({
          notices: await listNotices({ providerIds: await noticeTargets() }),
        })),
      status: (input) =>
        logRpcFailure("status", async () => {
          const text = await buildStatusOutput(input.sessionID, {
            origin: "tui",
            reconcileDetectedProviders: false,
          });
          return { text: sanitizeDisplayText(text) };
        }),
      usage: (input) =>
        logRpcFailure("usage", async () => {
          const { range, sessionID, from, to } = input;
          return { report: await loadUsageReport({ range, sessionID, from, to }) };
        }),
      downloadPrices: () => logRpcFailure("downloadPrices", downloadPrices),
      // Read now, so a custom provider changed a moment ago shows as it is before a switch-on.
      settings: () =>
        logRpcFailure("settings", async () =>
          clientSettings((await loadSettings({ projectDir })).settings),
        ),
      // Answers once the new settings are in use. `customEnabled` is the user's switch in the
      // quota window; no agent tool calls this.
      saveSettings: (input) =>
        logRpcFailure("saveSettings", async () => {
          const result = await liveSettings.save(input.patch, {
            allowFileOnly: false,
            customEnabled: input.customEnabled,
          });
          return { ok: result.ok, issues: result.issues };
        }),
    });
    // The export file and the gauges follow the snapshot; neither asks a provider again.
    const publisher = createSnapshotPublisher({
      loadSettings: () => loadServerSettings(sourceHost),
      log: (message, error) => console.warn(`[opencode-quota] ${message}: ${safeErrorText(error)}`),
    });
    const announce = (snapshot: QuotaSnapshot) => {
      publisher.publish(snapshot);
      void (async () => {
        try {
          await registration.events.emit("changed", { snapshot: forClients(snapshot) });
        } catch (error) {
          console.warn(`[opencode-quota] changed event failed: ${safeErrorText(error)}`);
        }
      })();
    };
    const unsubscribeStore = store.subscribe(announce);

    // New settings (saved here, or settings.jsonc edited by hand, by an agent or by another
    // OpenCode process) can change the providers, who each one is signed in as, the words and
    // the prices. They supersede the store's running work: every client gets a snapshot built
    // from them at once, then the new rows as more `changed` events. A check made with another
    // time limit, interval or price list is out of date, so every provider is checked again.
    const settingsWatch = await liveSettings.follow(async (change) => {
      store.settingsChanged({ recheck: change.recheck });
      if (change.oldCommands) {
        // The command list is built again from the settings now in use. An open TUI keeps its
        // "/" list until OpenCode restarts: OpenCode 2 sends this reload without the folder
        // (location) that the TUI refreshes its list for.
        await ctx.command.reload().catch((error: unknown) => {
          console.warn(`[opencode-quota] command reload failed: ${safeErrorText(error)}`);
        });
      }
    });

    await ctx.tool.transform((editor) => {
      // Agent tools: read and change the settings file, add, test and remove custom providers.
      const host = {
        openCodeProviderIds: async () => (await ctx.provider.list()).data.map(({ id }) => id),
        settings: liveSettings,
      };
      for (const tool of quotaAgentTools(host)) editor.add(tool);
      editor.add({
        name: "quota_status",
        description: "Diagnostics for toast, TUI, pricing and local storage.",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        async execute(_input, context) {
          const text = await buildStatusOutput(context.sessionID, {
            origin: "tool",
            reconcileDetectedProviders: true,
          });
          return { content: sanitizeDisplayText(text) };
        },
      });
    });

    // Web and Desktop list these in their "/" menu and get the report as a chat message. The
    // TUI shows /quota, /quota_usage and /quota_status in its quota window instead.
    const postReport = async (sessionID: string, command: string, report: string) => {
      // A message admitted while the AI works is delivered into that turn at its next
      // step, and can make the AI take one more step. Wait until the session is idle.
      await ctx.session.wait({ sessionID });
      const metadata: QuotaReportMetadata = { command, at: Date.now() };
      // The report is posted as the user's message. resume: false admits it without
      // starting a model turn, so it waits in the session inbox, where Web and Desktop
      // show it. "steer" delivers it together with the user's next message; "queue"
      // would later give it a model turn of its own.
      await ctx.session.prompt({
        sessionID,
        text: formatQuotaReportMessage(sanitizeDisplayText(report)),
        metadata: { [QUOTA_REPORT_METADATA_KEY]: metadata },
        delivery: "steer",
        resume: false,
      });
    };
    /** Posts the usage report `argumentsText` asks for, like "30d" or "between <date> <date>". */
    const postUsage = async (sessionID: string, command: string, argumentsText: string) => {
      const parsed = parseUsageArguments(argumentsText);
      if (!parsed.ok) {
        await postReport(sessionID, command, parsed.error);
        return;
      }
      const { range, from, to } = parsed;
      let text: string;
      try {
        text = usageText(await loadUsageReport({ range, from, to, sessionID }), {
          mode: "cost",
          breakdown: "model",
        });
      } catch (error) {
        text = `Couldn't read the usage: ${error instanceof Error ? error.message : String(error)}`;
      }
      await postReport(sessionID, command, text);
    };
    await ctx.command.transform((editor) => {
      editor.add({
        name: "quota",
        description: "Quick look: your quota limits and the last 7 days of usage.",
        async execute(invocation) {
          // /quota waits for the providers that are due a check; the rest show their last rows.
          const model = await sessionModel(invocation.sessionID);
          const snapshot = forClients(await store.refresh({ reason: "poll", model }));
          // Without OpenCode's history the limits still show.
          const usage = await loadUsageReport({ range: DEFAULT_QUICK_LOOK_RANGE }).catch(
            (error) => {
              console.warn(`[opencode-quota] /quota usage failed: ${safeErrorText(error)}`);
              return undefined;
            },
          );
          const notices = await listNotices({ providerIds: await noticeTargets() });
          const report = quotaMessageText({ snapshot, usage, notices, nowMs: Date.now() });
          await postReport(invocation.sessionID, "quota", report);
        },
      });
      editor.add({
        name: "quota_status",
        description: "Diagnostics for quota, TUI, pricing, and local storage.",
        async execute(invocation) {
          const text = await buildStatusOutput(invocation.sessionID, {
            origin: "slash_command",
            reconcileDetectedProviders: true,
          });
          await postReport(invocation.sessionID, "quota_status", text);
        },
      });
      editor.add({
        name: "quota_usage",
        description:
          "Tokens and API cost: today (default), 24h, 7d, 30d, 90d, all, session (with its subagents), or between YYYY-MM-DD YYYY-MM-DD.",
        execute: (invocation) =>
          postUsage(invocation.sessionID, "quota_usage", invocation.prompt.text),
      });
      // Read each time OpenCode builds the list, so `system.oldCommands` adds or removes them.
      if (!liveSettings.current().settings.system.oldCommands) return;
      for (const [name, range] of Object.entries(OLD_USAGE_COMMANDS)) {
        editor.add({
          name,
          description:
            range === "between"
              ? "Same as /quota_usage between YYYY-MM-DD YYYY-MM-DD."
              : `Same as /quota_usage ${range}.`,
          execute: (invocation) =>
            postUsage(invocation.sessionID, name, `${range} ${invocation.prompt.text}`),
        });
      }
    });

    // Keep quota reports out of every model request built from session history:
    // normal turns, compaction summaries, and generate requests.
    for (const hook of ["context", "compaction", "generate"] as const) {
      await ctx.session.hook(hook, (event) => {
        event.messages = withoutQuotaReports(event.messages);
      });
    }
    // OpenCode titles a new session from its first user message, which can be a report.
    // With nothing else to title from, skip the title request and keep the default title.
    await ctx.session.hook("title", (event) => {
      if (!event.messages.some((message) => message.content.some(hasQuotaReportText))) return;
      event.messages = withoutQuotaReports(event.messages);
      const textLeft = event.messages.some((message) =>
        message.content.some((part) => part.type === "text" && part.text.trim() !== ""),
      );
      if (!textLeft) event.result = "";
    });
    // With waitForQuotaReset on, a request that hit a provider limit is retried after the
    // used-up quota window resets. Any failure keeps OpenCode's own retry decision.
    await ctx.session.hook("retry", async (event) => {
      try {
        const delay = await resolveQuotaResetRetryDelayMs(
          { store, loadSettings: () => loadServerSettings(sourceHost) },
          event,
        );
        if (delay !== undefined) event.decision = { retry: true, delay };
      } catch (error) {
        console.warn(`[opencode-quota] retry hook failed: ${safeErrorText(error)}`);
      }
    });

    // Every login read in this process goes through this location's `ctx.integration`. Bound
    // last, so a setup that fails part way leaves no binding behind. OpenCode routes tools,
    // commands and RPC calls to the plugin only after setup, so no read comes earlier.
    const unbindCredentialSource = bindCredentialSource(
      createIntegrationCredentialSource(ctx.integration),
    );
    // A login added, changed or switched in OpenCode drops cached logins and failed-login
    // entries, so the next read asks OpenCode again, and makes the store check who each
    // provider is signed in as. If the subscription fails, cached logins stay until they
    // expire; the log says why. The cleanup's abort ends it silently.
    const credentialEvents = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: credentialEvents.signal })) {
        if (event.type === "credential.updated" || event.type === "credential.switched") {
          notifyCredentialsChanged();
          store.invalidateIdentity();
        }
      }
    })().catch((error) => {
      if (credentialEvents.signal.aborted) return;
      console.warn(
        `[opencode-quota] credential event subscription stopped: ${safeErrorText(error)}`,
      );
    });

    // Running fetches still read logins and prices, so the store is drained before the
    // bindings go.
    return async () => {
      credentialEvents.abort();
      settingsWatch.close();
      unsubscribeStore();
      publisher.dispose();
      await store.dispose();
      unbindCredentialSource();
      liveSettings.dispose();
    };
  },
});

export default QuotaToastPlugin;
