import { CURSOR_PROVIDER_ID, CURSOR_COMPACTION_OPTION, CURSOR_HOST_AGENT_OPTION, CURSOR_SESSION_EDITS_DENIED_OPTION, CURSOR_SESSION_PERMISSIONS_UNAVAILABLE_OPTION, } from "./shared.js";
import { createSdk, cursorApiBaseURL, cursorGetServerConfigTelemetryEnabled, isCursorPackage } from "./plugin-core.js";
import { opencode2PlanDir, opencodeGlobalCacheDir, setNativePlansDir } from "./context/paths.js";
import { discoverModels, isCacheFresh, readCache } from "./models.js";
import { resolveAgentUrl } from "./agent-url.js";
import { applyHostPromptEvent, applyHostToolEvent, sessionActivity } from "./activity.js";
import { notifyHostInterrupt } from "./host-interrupt.js";
import { announceHostSteer, forgetEarlySteerOfInbox, forgetEarlySteers, rememberQueuedSteer, takeQueuedSteer, } from "./host-steer.js";
import { fetchOpenCodeWebSearchText, parseExaWebSearchResults, } from "./web-tools.js";
import { armCursorShellCreate, captureCursorShellResult, captureCursorShellFailure, prepareCursorShellCreate, prepareCursorShellArgs, releaseCursorShellEnv, sanitizeRegisteredCursorShellOutput, } from "./shell-timeout.js";
import { applyCursorProviderInventory, CURSOR_INTEGRATION_ID } from "./opencode2/catalog.js";
import { applyCursorIntegration, requireCursorAccessToken, } from "./opencode2/integration.js";
import { exposeDirectMcpTools, rememberDirectMcpNamespaces } from "./opencode2/mcp-direct.js";
import { registerTodoTools } from "./opencode2/todo-tools.js";
import { registerCursorImageSaveTool } from "./opencode2/image-save-tool.js";
import { OPENCODE_2_TOOL_DIALECT } from "./protocol/tools.js";
import { clearSessionTodos } from "./todo-store.js";
import { markCompactionSession } from "./compaction-marker.js";
import { awaitHostHistoryRewrite, noteHostHistoryRewrite } from "./host-history-rewrite.js";
import { getSessionDirectory, markSessionDirectory } from "./session-directory.js";
import { rememberHostSkillFiles } from "./context/skills.js";
import { trace } from "./debug.js";
import { withAbortDeadline } from "./deadline.js";
import { CursorAuthError, CursorProtocolError, CursorTransportError } from "./errors.js";
import { processShared } from "./process-shared.js";
import { loadSessionForPermissions, sessionRulesDenyEdits } from "./protocol/session-edits.js";
import { cancelHostAgentModeSwitch, hostAgentSwitchPromptText, setHostAgentModeSwitch, } from "./host-agent-mode.js";
import { clearActiveCursorMode, } from "./protocol/switch-mode.js";
import { isHostPlanAgent } from "./protocol/cursor-mode.js";
import { CursorPlugin } from "./plugin.js";
import { nativeToolRefusal, preserveNativeToolResults } from "./opencode2/tool-results.js";
/**
 * OpenCode 2.0 plugin.
 *
 * Separate from `plugin-v2.ts` on purpose: the OpenCode 1.18 `/v2/promise` API
 * and the 2.0 API are source-incompatible (hook signatures, OAuth value type,
 * provider schema), so they cannot share an entrypoint. Shared behavior lives in
 * `plugin-core.ts`, `model-config.ts`, and `opencode2/*`.
 *
 * Models register in memory via `ctx.provider.transform` + `editor.add` +
 * `reload()`. Nothing is written into `opencode.json`.
 *
 * Dual export: `{ id, setup, server: CursorPlugin }`. OpenCode 2.0 Host.resolve
 * loads `./server` then `setup()`. OpenCode 1.18 also prefers `exports["./server"]`
 * and then calls `server()` so classic 1.x hooks still run.
 *
 * Load with:  { "plugin": ["cursor-opencode-provider/plugin/opencode2"] }
 * or a local package directory under `$OPENCODE_CONFIG_DIR/plugins/` that
 * re-exports `dist/plugin-opencode2.js` (OpenCode 2.0 requires a directory,
 * not a .js path).
 */
async function loadModels(cacheDir, accessToken, forceRefresh = false) {
    const cached = await readCache(cacheDir);
    if (!forceRefresh && cached?.models.length && isCacheFresh(cached))
        return cached.models;
    return discoverModels(accessToken, cacheDir, {
        baseURL: cursorApiBaseURL(),
        // An empty response can be cached; it must not pin later retries to [].
        forceRefresh: forceRefresh || cached?.models.length === 0,
    });
}
function toolExecutionID(event) {
    const id = event.id ?? event.callID;
    if (!id)
        throw new Error("OpenCode 2.0 tool hook did not provide an execution id");
    return id;
}
function isShellTool(name) {
    return name === "bash" || name === "shell";
}
function eventPayload(event) {
    if (event?.data && typeof event.data === "object")
        return event.data;
    if (event?.properties && typeof event.properties === "object")
        return event.properties;
    return event;
}
function markCompactionAndOptions(event, isCompaction) {
    markCompactionSession(event.sessionID, isCompaction);
    // Keep the request-local flag authoritative. Explicit false prevents a
    // concurrent title/generate/primary request for the same session from
    // inheriting the process-wide fallback marker.
    event.options ??= {};
    event.options[CURSOR_COMPACTION_OPTION] = isCompaction;
}
/** Every setup sees every Location's asks, so only the last observer releases them on dispose. */
const sharedPermissionCalls = processShared("opencode2-permission-calls.v1", () => ({
    calls: new Map(),
    observers: 0,
}));
// A replacement setup may start after another observer recorded the decline.
// Keep this bounded terminal evidence across setups and separate module graphs.
const refusals = processShared("opencode2-tool-refusals.v1", () => new Map());
const plugin = {
    id: "cursor.provider",
    server: CursorPlugin,
    setup: async (ctx) => {
        const cacheDir = opencodeGlobalCacheDir();
        const workspaceRoot = ctx.location?.directory || process.cwd();
        // CreatePlan writes where OpenCode 2.0's Plan agent keeps plan files.
        // OpenCode 2.0 sets a plugin up once per location instance and again on a
        // plugin reload, then disposes older setups: each cleanup removes only
        // what its own setup installed.
        const disposeNativePlansDir = setNativePlansDir(opencode2PlanDir());
        let disposeHostAgentModeSwitch;
        trace(`opencode2 plugin: setup directory=${workspaceRoot}`);
        const hasShellEnvHook = typeof ctx.shell?.hook === "function";
        const permissionCalls = new Map();
        const rememberRefusal = (id, refusal) => {
            refusals.delete(id);
            refusals.set(id, refusal);
            while (refusals.size > 512)
                refusals.delete(refusals.keys().next().value);
        };
        let observingPermissions = false;
        const observePermissionCalls = () => {
            observingPermissions = true;
            sharedPermissionCalls.observers++;
            for (const [id, call] of sharedPermissionCalls.calls)
                permissionCalls.set(id, call);
        };
        const releasePermissionCalls = () => {
            permissionCalls.clear();
            if (!observingPermissions)
                return;
            observingPermissions = false;
            if (--sharedPermissionCalls.observers > 0)
                return;
            for (const call of sharedPermissionCalls.calls.values())
                releaseCursorShellEnv(call.callID);
            sharedPermissionCalls.calls.clear();
        };
        const forgetPermissionCall = (id) => {
            permissionCalls.delete(id);
            sharedPermissionCalls.calls.delete(id);
        };
        const toolLifecycle = (event) => {
            const payload = eventPayload(event);
            if (event?.type === "permission.asked" && payload?.source?.type === "tool"
                && typeof payload.source.id === "string" && payload.source.id.startsWith("cursor_")
                && typeof payload.id === "string" && typeof payload.sessionID === "string") {
                const call = { sessionID: payload.sessionID, callID: payload.source.id };
                permissionCalls.set(payload.id, call);
                sharedPermissionCalls.calls.set(payload.id, call);
            }
            else if (event?.type === "permission.replied") {
                const call = permissionCalls.get(payload?.requestID);
                if (!call || call.sessionID !== payload?.sessionID)
                    return;
                forgetPermissionCall(payload.requestID);
                if (payload.reply === "reject") {
                    rememberRefusal(call.callID, "rejected");
                    releaseCursorShellEnv(call.callID);
                    // Native rejection also rejects the session's other pending requests.
                    for (const [id, pending] of permissionCalls)
                        if (pending.sessionID === call.sessionID) {
                            rememberRefusal(pending.callID, "rejected");
                            releaseCursorShellEnv(pending.callID);
                            forgetPermissionCall(id);
                        }
                }
            }
            else if ((event?.type === "session.tool.failed" || event?.type === "session.tool.success")
                && typeof payload?.id === "string") {
                if (event.type === "session.tool.failed")
                    releaseCursorShellEnv(payload.id);
                for (const [id, call] of permissionCalls)
                    if (call.callID === payload.id && call.sessionID === payload.sessionID) {
                        forgetPermissionCall(id);
                    }
            }
            else if (event?.type === "session.deleted") {
                for (const [id, call] of permissionCalls)
                    if (call.sessionID === payload?.sessionID) {
                        releaseCursorShellEnv(call.callID);
                        forgetPermissionCall(id);
                    }
            }
        };
        // Set once the host event stream is open; a switch waits on it below.
        let hostEventsObserved = false;
        if (typeof ctx.session.switchAgent === "function") {
            const switchAgent = ctx.session.switchAgent;
            const continueTurn = typeof ctx.session.synthetic === "function"
                ? ctx.session.synthetic
                : typeof ctx.session.prompt === "function"
                    ? ctx.session.prompt
                    : undefined;
            disposeHostAgentModeSwitch = setHostAgentModeSwitch(async ({ sessionID, agent }) => {
                // OpenCode answers a plan/build switch with a synthetic note from an
                // event subscriber. Continuing before that note is enqueued lets it
                // miss the first step's promotion, so the host writes its per-request
                // copy too and both land at the next step. Wait for the host's note.
                const reaction = continueTurn && hostEventsObserved
                    ? waitForHostSwitchReaction(sessionID, agent, HOST_SWITCH_REACTION_TIMEOUT_MS)
                    : undefined;
                try {
                    await switchAgent({ sessionID, agent });
                }
                catch (error) {
                    reaction?.cancel();
                    throw error;
                }
                // switchAgent only publishes AgentSelected and leaves the session idle.
                // Continue under the new agent the same way OpenCode 1.x promptAsync does.
                if (continueTurn) {
                    if (reaction) {
                        trace(`host-agent-mode: ${await reaction.reacted ? "host enqueued its" : "no host"} switch note ` +
                            `sessionID=${sessionID} agent=${agent}`);
                    }
                    await continueTurn({
                        sessionID,
                        text: hostAgentSwitchPromptText(agent),
                    });
                }
            }, {
                ...(continueTurn ? { resumesTurn: true } : {}),
                accepts: ({ hostAgent, agent }) => hostAgent !== agent,
            });
        }
        const registrations = [];
        const track = async (p) => {
            registrations.push(await p);
        };
        let models = [];
        let sourceConnection;
        let disposed = false;
        let inventoryPublished = false;
        let candidateInventory;
        // ── Credentials ─────────────────────────────────────────
        await track(ctx.integration.transform(applyCursorIntegration));
        // ── Provider inventory (in-memory `editor.add`) ─────────────────────
        // Transform replays on provider.reload(). Skip while `models` is empty so
        // the first registration is a no-op; discovery/cache then reload.
        await track(ctx.provider.transform((editor) => {
            if (disposed)
                return;
            const candidate = candidateInventory?.current() ? candidateInventory : undefined;
            applyCursorProviderInventory(editor, candidate?.models ?? models, candidate ? candidate.connection : sourceConnection);
        }));
        const publishModels = async (next, current) => {
            const connection = await ctx.integration.connection.active(CURSOR_INTEGRATION_ID).catch((error) => {
                // Connection metadata is optional for inventory publication; Run auth
                // still resolves and validates the current credential independently.
                trace(`opencode2 models: connection lookup failed; publishing without sourceConnection: ${String(error)}`);
                return undefined;
            });
            if (!current())
                return false;
            const candidate = { models: next, connection, current };
            candidateInventory = candidate;
            try {
                await ctx.provider.reload();
                if (!current())
                    return false;
                models = next;
                sourceConnection = connection;
                inventoryPublished = true;
                return true;
            }
            finally {
                // A failed, expired or superseded reload must not change later replays.
                if (candidateInventory === candidate)
                    candidateInventory = undefined;
            }
        };
        // Bound cache publication too: a stalled host reload must not hang setup.
        const readinessStartedAt = Date.now();
        try {
            await withAbortDeadline(MODEL_READINESS_TIMEOUT_MS, modelReadinessTimeout, async (signal) => {
                const cached = await readCache(cacheDir);
                if (cached?.models.length && !signal.aborted) {
                    await publishModels(cached.models, () => !disposed && !signal.aborted);
                }
            });
        }
        catch (error) {
            trace(`opencode2 models: cache publication failed: ${String(error)}`);
        }
        // ── AI SDK wiring ────────────────────────────────────────
        await track(ctx.aisdk.hook("sdk", async (event) => {
            if (!isCursorPackage(event.package, event.model.providerID))
                return;
            // The host's generic loader runs before plugin hooks and may already
            // have created a Cursor SDK with a captured token. Own our package's
            // SDK so current integration credentials are resolved on every Run.
            event.sdk = createSdk({
                name: event.model.providerID || CURSOR_PROVIDER_ID,
                // Static fallback only. This hook fires once per model/package, not
                // per session, and 2.0 runs one daemon across many projects — the
                // real per-request directory comes from `x-opencode-directory`
                // (set on `session.model.request`) and the session-directory mark.
                workspaceRoot,
                cacheDir,
                ...event.options,
                // Keep after host options: a captured resolver/token must not bypass
                // the integration's current credential and renewal path.
                getAccessToken: (request) => requireCursorAccessToken(ctx.integration, request),
                // Keep after `event.options` so the OC2 plugin always selects the
                // `path`/`shell` dialect when advertised schemas are opaque.
                defaultDialect: OPENCODE_2_TOOL_DIALECT,
            });
        }));
        await track(ctx.aisdk.hook("language", (event) => {
            if (event.language)
                return;
            if (event.model.providerID !== CURSOR_PROVIDER_ID)
                return;
            if (typeof event.sdk?.languageModel !== "function")
                return;
            // `modelID` is the Cursor wire id; `id` may be a synthetic long-context entry.
            event.language = event.sdk.languageModel(event.model.modelID || event.model.id);
        }));
        // ── Web search ───────────────────────────────────────────
        // Publish an OpenCode 2.0 `websearch` provider (`{url,title,content,time}`).
        // The classic entrypoint owns the permission-aware `custom_websearch`
        // fallback; 2.0's public plugin tool context cannot request permission.
        if (ctx.websearch) {
            await track(ctx.websearch.transform((draft) => {
                draft.add({
                    id: "cursor-exa",
                    name: "Exa",
                    execute: async (input, context) => {
                        const output = await fetchOpenCodeWebSearchText({ query: input.query }, context.signal);
                        return parseExaWebSearchResults(output);
                    },
                });
            }));
        }
        // Namespaces whose tools belong on the direct catalog. Filled by the MCP
        // transform (config is not written) and read when tool transforms replay,
        // including after a later MCP discovery reload.
        const directMcpNamespaces = new Set();
        if (ctx.mcp) {
            await track(ctx.mcp.transform((editor) => {
                rememberDirectMcpNamespaces(directMcpNamespaces, editor.list());
            }));
        }
        await track(ctx.tool.transform((draft) => {
            // OpenCode 2 dropped host todowrite/todoread. Off by default
            // (`CURSOR_OPENCODE2_TODOS=1`/`true` force-enables). When on, register
            // them as direct catalog tools (`codemode: false` + output schema) if
            // the host does not already own those names. When off, register none.
            registerTodoTools(draft, ctx);
            registerCursorImageSaveTool(draft, ctx);
            // MCP tools default into Code Mode. Move every server that did not
            // explicitly opt in onto the direct catalog so this provider can
            // advertise them to Cursor (issue #29 still routes via CallDynamicTool).
            // See `opencode2/mcp-direct.ts`.
            exposeDirectMcpTools(draft, directMcpNamespaces);
        }));
        // ── Shell timeout wrapper ────────────────────────────────
        await track(ctx.tool.hook("execute.before", async (event) => {
            if (!isShellTool(event.tool) || typeof event.input !== "object" || event.input === null)
                return;
            const executionID = toolExecutionID(event);
            const input = event.input;
            prepareCursorShellArgs(executionID, input, {
                deferToShellHook: hasShellEnvHook,
                preferWrapperCommand: !hasShellEnvHook,
            });
            if (hasShellEnvHook)
                await armCursorShellCreate(executionID, event);
        }));
        await track(ctx.tool.hook("execute.after", (event) => {
            const executionID = toolExecutionID(event);
            if (event.status === "error") {
                const refusal = nativeToolRefusal(event.error);
                if (refusal)
                    rememberRefusal(executionID, refusal);
            }
            else
                refusals.delete(executionID);
            if (!isShellTool(event.tool))
                return;
            try {
                if (event.status !== "completed") {
                    if (event.status === "error")
                        captureCursorShellFailure(executionID, event.error);
                    return;
                }
                const result = event.result;
                // V1: `output` is the model-facing string. V2: `output` is structured
                // per-tool output (shell: `{ output: string, ... }`) and the
                // model-facing text lives on `content`. Sanitize every string
                // location; non-strings pass through via the guards in shell-timeout.
                if (typeof result.output === "string") {
                    result.output = captureCursorShellResult(executionID, result.output, result.metadata);
                }
                else if (result.output && typeof result.output === "object") {
                    const structured = result.output;
                    if (typeof structured.output === "string") {
                        structured.output = captureCursorShellResult(executionID, structured.output, result.metadata);
                    }
                }
                if (typeof result.content === "string") {
                    result.content = sanitizeRegisteredCursorShellOutput(executionID, result.content);
                }
                else if (Array.isArray(result.content)) {
                    result.content = result.content.map((item) => {
                        if (!item || typeof item !== "object")
                            return item;
                        const content = item;
                        if (content.type !== "text" || typeof content.text !== "string")
                            return item;
                        return {
                            ...content,
                            text: sanitizeRegisteredCursorShellOutput(executionID, content.text),
                        };
                    });
                }
                else if (typeof result.output === "string" && result.content === undefined) {
                    result.content = result.output;
                }
                if (result.metadata && typeof result.metadata === "object") {
                    const metadata = result.metadata;
                    if (typeof metadata.output === "string") {
                        metadata.output = sanitizeRegisteredCursorShellOutput(executionID, metadata.output);
                    }
                }
            }
            finally {
                releaseCursorShellEnv(executionID);
            }
        }));
        if (ctx.shell) {
            await track(ctx.shell.hook("create.before", (event) => {
                prepareCursorShellCreate(event);
            }));
        }
        const rememberSessionDirectory = async (sessionID) => {
            try {
                const info = await ctx.session.get({ sessionID });
                markSessionDirectory(sessionID, info.location.directory);
            }
            catch (error) {
                // Best effort — falls back to the static workspaceRoot above.
                trace(`session directory: session.get failed sessionID=${sessionID}: ${String(error)}`);
            }
        };
        await track(ctx.session.hook("context", async (event) => {
            event.messages = preserveNativeToolResults(event.messages, refusals);
            markCompactionAndOptions(event, event.agent === "compaction");
            event.options ??= {};
            event.options[CURSOR_HOST_AGENT_OPTION] = event.agent;
            if (event.model?.providerID === CURSOR_PROVIDER_ID) {
                await awaitHostHistoryRewrite(opencodeGlobalCacheDir(), event.sessionID);
            }
            delete event.options[CURSOR_SESSION_EDITS_DENIED_OPTION];
            delete event.options[CURSOR_SESSION_PERMISSIONS_UNAVAILABLE_OPTION];
            // Compaction cannot approve a plan; its session read stays best effort,
            // like the classic plugin, which reads no rules for it.
            if (event.agent === "compaction") {
                await rememberSessionDirectory(event.sessionID);
                return;
            }
            const info = await loadSessionForPermissions(() => ctx.session.get({ sessionID: event.sessionID })).catch(() => undefined);
            if (!info) {
                event.options[CURSOR_SESSION_PERMISSIONS_UNAVAILABLE_OPTION] = true;
                return;
            }
            markSessionDirectory(event.sessionID, info.location.directory);
            event.options[CURSOR_SESSION_EDITS_DENIED_OPTION] = sessionRulesDenyEdits(info.permissions);
        }));
        // The session mark lives in module state, and OpenCode re-evaluates a local
        // plugin's module graph per Location, so the copy running the model may not
        // hold it. The header travels with the request (AI SDK
        // `callOptions.headers` → `resolveSessionWorkspaceRoot`) and never reaches
        // Cursor. Only a successful lookup updates the mark; on failure keep the
        // last known session directory ahead of this Location's static root.
        // Scoped by the host to this provider: other providers' requests never
        // reach the callback, so the header cannot leak to their endpoints.
        // Skill files for RequestContext path-desc `agent_skills` (see context/skills.ts).
        const rememberSkillFiles = async () => {
            if (!ctx.skill)
                return;
            try {
                const listed = await ctx.skill.list();
                // skill.list is bound to this plugin Location. A session may have
                // moved; never relabel this catalog with the session's new directory.
                rememberHostSkillFiles(listed.location.directory, listed.data);
            }
            catch (error) {
                trace(`model.request: skill.list failed: ${String(error)}`);
            }
        };
        await track(ctx.session.hook("model.request", async (event) => {
            const current = await ctx.session
                .get({ sessionID: event.sessionID })
                .then((info) => info.location.directory)
                .catch((error) => {
                trace(`model.request: session.get failed sessionID=${event.sessionID}: ${String(error)}`);
                return undefined;
            });
            markSessionDirectory(event.sessionID, current);
            const directory = current ?? getSessionDirectory(event.sessionID) ?? ctx.location?.directory;
            if (!directory)
                return;
            await rememberSkillFiles();
            event.headers = {
                ...event.headers,
                "x-opencode-directory": encodeURIComponent(directory),
            };
        }, { providerID: CURSOR_PROVIDER_ID }));
        await track(ctx.session.hook("compaction", async (event) => {
            event.messages = preserveNativeToolResults(event.messages, refusals);
            markCompactionAndOptions(event, true);
            await rememberSessionDirectory(event.sessionID);
        }));
        await track(ctx.session.hook("generate", async (event) => {
            event.messages = preserveNativeToolResults(event.messages, refusals);
            markCompactionAndOptions(event, false);
            await rememberSessionDirectory(event.sessionID);
        }));
        await track(ctx.session.hook("title", async (event) => {
            event.messages = preserveNativeToolResults(event.messages, refusals);
            markCompactionAndOptions(event, false);
            await rememberSessionDirectory(event.sessionID);
        }));
        // ── Model discovery ────────────────────────────────────────
        let modelsLoaded = false;
        let credentialGeneration = 0;
        let loadedCredentialGeneration = 0;
        let ensureInflight;
        const ensureModels = (timeoutMs = MODEL_READINESS_TIMEOUT_MS) => {
            if (disposed)
                return Promise.resolve();
            if (modelsLoaded && loadedCredentialGeneration === credentialGeneration) {
                return Promise.resolve();
            }
            // If credentials change during an existing discovery, wait for that
            // attempt and immediately run again. The generation check prevents the
            // older attempt from suppressing the account-scoped refresh.
            if (ensureInflight)
                return ensureInflight;
            ensureInflight = withAbortDeadline(timeoutMs, modelReadinessTimeout, async (signal) => {
                while (!disposed && !signal.aborted) {
                    const attemptGeneration = credentialGeneration;
                    const current = () => !disposed && !signal.aborted && credentialGeneration === attemptGeneration;
                    const forceRefresh = loadedCredentialGeneration !== attemptGeneration;
                    let token;
                    let discovered;
                    try {
                        // Preserve auth failures; only a missing connection is normal startup.
                        token = await requireCursorAccessToken(ctx.integration);
                        if (!current())
                            continue;
                        discovered = await loadModels(cacheDir, token, forceRefresh);
                    }
                    catch (error) {
                        if (!current())
                            continue;
                        if (error instanceof CursorAuthError && error.code === "no_credential") {
                            trace("opencode2 models: no Cursor credential; connect Cursor first");
                            return;
                        }
                        throw error;
                    }
                    if (!current())
                        continue;
                    if (!discovered.length)
                        throw new CursorProtocolError("Cursor returned an empty model catalog", {
                            code: "CURSOR_EMPTY_MODEL_CATALOG",
                        });
                    try {
                        if (!await publishModels(discovered, current))
                            continue;
                    }
                    catch (error) {
                        if (!current())
                            continue;
                        throw error;
                    }
                    // A newer credential event arrived while this request was in flight.
                    // Keep the state dirty so the loop uses the latest token.
                    if (!current())
                        continue;
                    modelsLoaded = true;
                    loadedCredentialGeneration = attemptGeneration;
                    void resolveAgentUrl(token, {
                        apiBaseURL: cursorApiBaseURL(),
                        telemetryEnabled: cursorGetServerConfigTelemetryEnabled(),
                    }).catch(() => { });
                    trace(`opencode2 models: ready count=${discovered.length}`);
                    return;
                }
            }).finally(() => { ensureInflight = undefined; });
            return ensureInflight;
        };
        const refreshModels = () => {
            void ensureModels().catch((error) => {
                trace(`opencode2 models: discovery/publication failed: ${String(error)}`);
            });
        };
        const RETRY_INTERVAL_MS = 3_000;
        const RETRY_WINDOW_MS = 300_000;
        const startedAt = Date.now();
        const retry = setInterval(() => {
            if (modelsLoaded || Date.now() - startedAt > RETRY_WINDOW_MS) {
                clearInterval(retry);
                return;
            }
            refreshModels();
        }, RETRY_INTERVAL_MS);
        retry.unref?.();
        const onCredentialSwitch = () => {
            modelsLoaded = false;
            credentialGeneration++;
        };
        // Own the observer before iteration: an iterator can throw synchronously
        // and invoke onStreamClosed before subscribeSessionActivity returns.
        observePermissionCalls();
        const unsubscribe = subscribeSessionActivity(ctx, refreshModels, onCredentialSwitch, toolLifecycle, () => {
            hostEventsObserved = false;
            releasePermissionCalls();
        });
        hostEventsObserved = !!unsubscribe && observingPermissions;
        if (!unsubscribe)
            releasePermissionCalls();
        // OpenCode waits for plugin activation before selecting the first model.
        // Cached inventory is already usable; only a cold start needs this barrier.
        if (inventoryPublished)
            refreshModels();
        else
            await ensureModels(Math.max(1, MODEL_READINESS_TIMEOUT_MS - (Date.now() - readinessStartedAt))).catch((error) => {
                trace(`opencode2 models: startup readiness failed: ${String(error)}`);
                // Do not fail setup: the host disables failed plugin revisions, which
                // would remove /connect and prevent credential/network recovery.
                console.warn(`Cursor model discovery/publication failed: ${String(error)}`);
            });
        return async () => {
            disposed = true;
            clearInterval(retry);
            unsubscribe?.();
            releasePermissionCalls();
            await saveOpenTurnsForShutdown();
            disposeHostAgentModeSwitch?.();
            disposeNativePlansDir();
            trace(`opencode2 plugin: cleanup directory=${workspaceRoot}`);
            for (const registration of registrations.reverse()) {
                await registration.dispose().catch(() => { });
            }
        };
    },
};
const SHUTDOWN_SAVE_TIMEOUT_MS = 2_000;
const MODEL_READINESS_TIMEOUT_MS = 10_000;
function modelReadinessTimeout() {
    return new CursorTransportError(`Cursor model discovery/publication timed out after ${MODEL_READINESS_TIMEOUT_MS}ms`, { code: "CURSOR_MODEL_READINESS_TIMEOUT", transient: true, replaySafe: true });
}
/** Save every open turn for the next server start, without holding shutdown up for long. */
async function saveOpenTurnsForShutdown() {
    let timer;
    const timedOut = new Promise((resolve) => {
        timer = setTimeout(resolve, SHUTDOWN_SAVE_TIMEOUT_MS);
        timer.unref?.();
    });
    try {
        await Promise.race([notifyHostInterrupt(undefined, "shutdown"), timedOut]);
    }
    finally {
        clearTimeout(timer);
    }
}
/** Upper bound on waiting for the host's note after a native agent switch. */
const HOST_SWITCH_REACTION_TIMEOUT_MS = 1_000;
const switchReactionWaiters = new Map();
function waitForHostSwitchReaction(sessionID, agent, timeoutMs) {
    let settle;
    const reacted = new Promise((resolve) => { settle = resolve; });
    const waiters = switchReactionWaiters.get(sessionID) ?? new Set();
    switchReactionWaiters.set(sessionID, waiters);
    const done = (value) => {
        clearTimeout(timer);
        waiters.delete(waiter);
        if (waiters.size === 0 && switchReactionWaiters.get(sessionID) === waiters)
            switchReactionWaiters.delete(sessionID);
        settle(value);
    };
    const waiter = { agent, reacted: () => done(true), cancel: () => done(false) };
    const timer = setTimeout(() => done(false), timeoutMs);
    timer.unref?.();
    waiters.add(waiter);
    return { reacted, cancel: waiter.cancel };
}
function subscribeSessionActivity(ctx, onEvent, onCredentialSwitch, onToolEvent, onStreamClosed) {
    try {
        const controller = new AbortController();
        const stream = ctx.event.subscribe({ signal: controller.signal });
        if (!stream || typeof stream[Symbol.asyncIterator] !== "function")
            return undefined;
        let stopped = false;
        void (async () => {
            try {
                for await (const event of stream) {
                    if (stopped)
                        break;
                    const payload = eventPayload(event);
                    if (event.type === "session.compaction.ended"
                        && typeof event.id === "string" && typeof payload?.sessionID === "string"
                        && typeof payload.model?.providerID === "string"
                        && payload.model.providerID !== CURSOR_PROVIDER_ID) {
                        void noteHostHistoryRewrite(opencodeGlobalCacheDir(), payload.sessionID, event.id).catch((error) => {
                            trace(`host compaction: persistence failed: ${String(error)}`);
                        });
                    }
                    applySessionActivity(event, onCredentialSwitch);
                    onToolEvent?.(event);
                    onEvent?.();
                }
            }
            finally {
                onStreamClosed?.();
            }
        })().catch(() => { });
        return () => {
            stopped = true;
            controller.abort();
        };
    }
    catch {
        return undefined;
    }
}
function applySessionActivity(event, onCredentialSwitch) {
    const payload = eventPayload(event);
    const info = payload?.info;
    applyHostPromptEvent(sessionActivity, event?.type, payload);
    applyHostToolEvent(sessionActivity, event?.type, payload);
    switch (event?.type) {
        case "credential.switched":
        case "credential.updated": {
            const integrationID = payload?.integrationID;
            if (!integrationID || integrationID === CURSOR_INTEGRATION_ID || integrationID === CURSOR_PROVIDER_ID) {
                onCredentialSwitch?.();
            }
            break;
        }
        case "session.created":
        case "session.updated":
        case "session.forked": {
            const id = payload?.sessionID ?? info?.id;
            const parentID = payload?.parentID ?? info?.parentID;
            if (id) {
                sessionActivity.linkSession(id, parentID);
                if (event.type === "session.created")
                    sessionActivity.recordActivity(id);
            }
            break;
        }
        case "session.deleted": {
            const id = payload?.sessionID ?? info?.id;
            if (id) {
                sessionActivity.removeSession(id);
                clearSessionTodos(id);
                forgetEarlySteers(id);
                clearActiveCursorMode(id);
                cancelHostAgentModeSwitch(id);
                for (const waiter of [...(switchReactionWaiters.get(id) ?? [])])
                    waiter.cancel();
            }
            break;
        }
        case "message.updated": {
            const id = payload?.sessionID ?? info?.sessionID;
            if (id)
                sessionActivity.recordActivity(id);
            break;
        }
        case "message.part.updated": {
            const id = payload?.sessionID ?? payload?.part?.sessionID ?? info?.sessionID;
            if (id)
                sessionActivity.recordActivity(id);
            break;
        }
        case "session.usage.updated":
        case "session.usage.recorded": {
            const id = payload?.sessionID;
            if (id)
                sessionActivity.recordActivity(id);
            break;
        }
        case "session.inbox.enqueued": {
            const id = payload?.sessionID;
            if (id)
                sessionActivity.recordActivity(id);
            if (typeof id === "string" && payload?.item?.type === "synthetic") {
                const text = payload.item.payload?.text;
                // OpenCode's Plan plugin owns these reminders. Background notices and
                // an older reminder for the opposite mode do not acknowledge this switch.
                if (typeof text === "string")
                    for (const waiter of [...(switchReactionWaiters.get(id) ?? [])]) {
                        const prefix = isHostPlanAgent(waiter.agent) ? "You are in Plan mode." : "You are NO LONGER in Plan mode.";
                        if (text.startsWith(`<system-reminder>\n${prefix}`))
                            waiter.reacted();
                    }
            }
            const steer = inboxSteer(id, payload?.inboxID, payload?.item);
            if (!steer)
                break;
            if (payload.item.delivery === "steer")
                announceInboxSteer(steer);
            else
                rememberQueuedSteer(steer);
            break;
        }
        case "session.inbox.delivery.changed": {
            const id = payload?.sessionID;
            if (id)
                sessionActivity.recordActivity(id);
            if (payload?.delivery !== "steer" || typeof payload?.inboxID !== "string")
                break;
            const steer = takeQueuedSteer(payload.inboxID);
            if (steer)
                announceInboxSteer(steer);
            break;
        }
        case "session.inbox.delivered":
        case "session.inbox.cancelled": {
            const id = payload?.sessionID;
            if (id)
                sessionActivity.recordActivity(id);
            if (typeof payload?.inboxID !== "string")
                break;
            takeQueuedSteer(payload.inboxID);
            if (event.type === "session.inbox.cancelled" && typeof id === "string")
                forgetEarlySteerOfInbox(id, payload.inboxID);
            break;
        }
        default: {
            // OpenCode 2.0 emits granular `session.*` progress events instead of
            // the V1 `message.updated` family (`session.tool.called/success/failed`,
            // `session.step.*`, `session.text.*`, `session.execution.*`, ...). Any of
            // them proves the session is alive and renews a pending-tool lease.
            const type = typeof event?.type === "string" ? event.type : "";
            if (type.startsWith("session.") && type !== "session.deleted") {
                const id = payload?.sessionID ?? info?.sessionID ?? info?.id;
                if (id)
                    sessionActivity.recordActivity(id);
                if (id && type === "session.execution.interrupted") {
                    void notifyHostInterrupt(id, typeof payload?.reason === "string" ? payload.reason : "user", typeof event.created === "number" ? event.created : Date.now());
                }
            }
            break;
        }
    }
}
/** A plain-text user message; one with files or skills reaches the prompt in another shape. */
function inboxSteer(sessionID, inboxID, item) {
    if (typeof sessionID !== "string" || !sessionID || typeof inboxID !== "string" || !inboxID)
        return undefined;
    if (item?.type !== "user" || (item.delivery !== "steer" && item.delivery !== "queue"))
        return undefined;
    const prompt = item.payload;
    if (typeof prompt?.text !== "string" || !prompt.text.trim())
        return undefined;
    if (prompt.files?.length || prompt.skills?.length)
        return undefined;
    return { sessionID, inboxID, text: prompt.text };
}
function announceInboxSteer(steer) {
    const taken = announceHostSteer(steer);
    if (taken === undefined)
        return;
    trace(`steer: OpenCode enqueued a mid-step message sessionID=${steer.sessionID} inboxID=${steer.inboxID} ` +
        `chars=${steer.text.length} ${taken ? "injected into the pumping Run" : "left for the next step"}`);
}
export default plugin;
