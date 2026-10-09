import { CURSOR_API_HOST, CURSOR_COMPACTION_OPTION, CURSOR_HOST_AGENT_OPTION, CURSOR_PROVIDER_ID, CURSOR_WEBSITE_HOST, } from "./shared.js";
import { cursorApiBaseURL, cursorGetServerConfigTelemetryEnabled } from "./plugin-core.js";
import { pollForTokens, exchangeApiKey, isExpiringSoon, generatePkceParams, generatePkceChallenge, buildLoginUrl, decodeJwtExpiryMs, isExchangeableApiKey } from "./auth.js";
import { renewSessionIfDue, resolveApiKeyToken, } from "./auth-renewal.js";
import { CursorAuthError } from "./errors.js";
import { errorMessage, trace } from "./debug.js";
import { readCache, discoverModels, isCacheFresh } from "./models.js";
import { modelsToConfig } from "./model-config.js";
import { loadClassicTools } from "./classic-tools.js";
import { opencodeGlobalCacheDir } from "./context/paths.js";
import { readStoredAuth } from "./context/auth-store.js";
import { resolveAgentUrl } from "./agent-url.js";
import { captureCursorShellResult, cursorShellEnvForCall, cursorShellOriginalCommand, prepareCursorShellArgs, releaseCursorShellEnv, sanitizeRegisteredCursorShellOutput, setCursorShellPath, } from "./shell-timeout.js";
import { sessionActivity } from "./activity.js";
import { dispatchHostEventBridge } from "./host-event-bridge.js";
import { createPromptHostAgentModeSwitch, setHostAgentModeSwitch } from "./host-agent-mode.js";
import { isHostPlanFileResolved, resolveHostPlanFile } from "./host-plan-file.js";
const MODULE_URL = new URL("./index.js", import.meta.url).href;
/**
 * Raw `crsr_` key behind an API-key login: under `metadata.apiKey` (saved at
 * login, and merged there from the prompt inputs by OpenCode's CLI), or as
 * `key` itself when OpenCode stored the typed key without our exchange.
 */
function storedApiKey(auth) {
    const fromMetadata = auth.metadata?.apiKey;
    if (typeof fromMetadata === "string" && isExchangeableApiKey(fromMetadata))
        return fromMetadata;
    return isExchangeableApiKey(auth.key) ? auth.key : undefined;
}
function sessionTokens(auth) {
    // Cursor's IDE refreshes with the stored refresh token and then stores the
    // new access token as both; an empty refresh field means the same.
    return { accessToken: auth.access, refreshToken: auth.refresh || auth.access };
}
/** Whether `latest` is still the credential a renewal started from. */
function isSameCredential(latest, started) {
    if (latest.type === "oauth" && started.type === "oauth") {
        return latest.access === started.access && latest.refresh === started.refresh;
    }
    if (latest.type === "api" && started.type === "api") {
        return latest.key === started.key && storedApiKey(latest) === storedApiKey(started);
    }
    return false;
}
/** Names of the host's own user-selectable primary agents, from `app.agents()`. */
function primaryAgentNames(response) {
    const list = Array.isArray(response)
        ? response
        : Array.isArray(response?.data)
            ? response.data
            : undefined;
    if (!list)
        return undefined;
    const names = new Set();
    for (const item of list) {
        if (typeof item?.name !== "string" || item.mode === "subagent" || item.hidden === true)
            continue;
        names.add(item.name);
    }
    return names;
}
/**
 * Install the OpenCode 1.x host-agent switch. Returns the agent-list refresh,
 * which the caller runs once the host serves requests: the list is read from
 * the host's own API, and a failed read leaves SwitchMode provider-owned.
 */
function installPromptHostAgentModeSwitch(input, sessionClient, promptAsync) {
    const app = input.client?.app;
    const agents = app?.agents;
    // Nothing to install; a switch another entrypoint installed stays in place.
    if (typeof promptAsync !== "function" || typeof agents !== "function")
        return undefined;
    let primary;
    const refresh = () => agents.call(app)
        .then((response) => { primary = primaryAgentNames(response) ?? primary; })
        .catch((error) => trace(`host-agent-mode: agent list unavailable: ${errorMessage(error)}`));
    const { apply, accepts } = createPromptHostAgentModeSwitch(async ({ sessionID, agent, text }) => {
        await promptAsync.call(sessionClient, {
            path: { id: sessionID },
            body: { agent, parts: [{ type: "text", text, synthetic: true }] },
        });
        void refresh();
    }, () => primary);
    setHostAgentModeSwitch(apply, { resumesTurn: true, accepts });
    return refresh;
}
export async function CursorPlugin(input) {
    const cacheDir = opencodeGlobalCacheDir();
    const apiBaseURL = cursorApiBaseURL();
    const classicTools = await loadClassicTools();
    const sessionClient = input.client?.session;
    const promptAsync = sessionClient?.promptAsync;
    // Cursor SwitchMode without an advertised plan_enter selects the host's
    // primary agent the OpenCode 1.x way once its Run has ended. The OpenCode 2.0
    // entrypoint replaces this with `session.switchAgent` in its own setup().
    const refreshHostAgents = installPromptHostAgentModeSwitch(input, sessionClient, promptAsync);
    let hostAgentsLoaded;
    const sessionGet = sessionClient?.get;
    const getSession = typeof sessionGet === "function"
        ? (sessionID) => sessionGet.call(sessionClient, { path: { id: sessionID } })
        : undefined;
    let lastPersistAttempt;
    async function persistAuth(body) {
        await input.client.auth.set({
            path: { id: CURSOR_PROVIDER_ID },
            body,
        });
    }
    /** Persist refreshed credentials without failing the caller that already holds a live token. */
    async function persistAuthBestEffort(body) {
        try {
            await persistAuth(body);
        }
        catch {
            // ignore — token is still usable for this process
        }
    }
    /**
     * Durable credentials OpenCode stores on disk (same file getAuth() reads in
     * the normal path). Used from `config`, which has no getAuth() callback.
     */
    async function authFromStore() {
        return readStoredAuth(CURSOR_PROVIDER_ID);
    }
    /**
     * Prefer OpenCode's live getAuth(); fall back to the durable store so loader
     * and config share the same underlying credentials when possible.
     */
    async function authForLoader(getAuth) {
        // getAuth is also called long after the loader returned (per-Run token
        // resolution); never let a host-side failure there hide the durable store.
        return (await getAuth().catch(() => undefined)) ?? (await authFromStore());
    }
    /**
     * Persist a renewed credential unless the stored one changed meanwhile (a
     * re-login, or another process's renewal): never overwrite newer state.
     */
    async function persistRenewal(started, next, readCurrent) {
        // One attempt per renewed token: when the write fails (read-only store,
        // injected OPENCODE_AUTH_CONTENT) later Runs keep the in-memory token
        // instead of re-reading and re-writing the store on every turn.
        const token = next.type === "oauth" ? next.access : next.type === "api" ? next.key : undefined;
        if (token === undefined || token === lastPersistAttempt)
            return;
        lastPersistAttempt = token;
        const latest = await readCurrent().catch(() => undefined);
        if (!latest || !isSameCredential(latest, started)) {
            trace("auth: stored Cursor credential changed during renewal; keeping the stored one");
            return;
        }
        await persistAuthBestEffort(next);
    }
    /** Browser-login session: renew when due (or forced) and persist the result. */
    async function resolveSession(auth, readCurrent, force = false) {
        const renewal = await renewSessionIfDue(sessionTokens(auth), { baseUrl: apiBaseURL, force });
        if (renewal.renewed) {
            // Preserve optional OAuth fields (v2 Auth / plugin may carry these).
            const extras = auth;
            await persistRenewal(auth, {
                type: "oauth",
                access: renewal.accessToken,
                refresh: renewal.accessToken,
                expires: decodeJwtExpiryMs(renewal.accessToken) ?? Date.now(),
                ...(extras.accountId !== undefined ? { accountId: extras.accountId } : {}),
                ...(extras.enterpriseUrl !== undefined ? { enterpriseUrl: extras.enterpriseUrl } : {}),
            }, readCurrent);
        }
        return renewal;
    }
    /** API-key login: re-exchange the stored raw key when the JWT nears expiry. */
    async function resolveApiKeyLogin(auth, readCurrent, force = false) {
        const apiKey = storedApiKey(auth);
        if (!apiKey) {
            // Saved by an older version that kept only the exchanged JWT and its
            // refresh token. Cursor renews API-key logins only by exchanging the key.
            if (!isExpiringSoon(auth.key, 30))
                return auth.key;
            throw new CursorAuthError("This Cursor API-key login was saved without the key, so it cannot be renewed; sign in again with the API key", { code: "api_key_missing" });
        }
        const token = await resolveApiKeyToken(apiKey, {
            baseUrl: apiBaseURL,
            ...(isExchangeableApiKey(auth.key) ? {} : { seed: auth.key }),
            force,
        });
        if (token.renewed) {
            const { refreshToken: _unused, ...metadata } = auth.metadata ?? {};
            await persistRenewal(auth, {
                type: "api",
                key: token.accessToken,
                metadata: { ...metadata, apiKey },
            }, readCurrent);
        }
        return token.accessToken;
    }
    /**
     * Current access token for the stored credential. The two credential kinds
     * are handled by separate paths and never substitute for each other.
     */
    async function resolveAccessToken(auth, readCurrent, force = false) {
        if (auth.type === "oauth")
            return (await resolveSession(auth, readCurrent, force)).accessToken;
        if (auth.type === "api")
            return resolveApiKeyLogin(auth, readCurrent, force);
        return undefined;
    }
    /** Best-effort token for startup work (model discovery, endpoint warmup). */
    async function startupAccessToken(auth, readCurrent) {
        try {
            return await resolveAccessToken(auth, readCurrent);
        }
        catch (error) {
            // Surfaced again, with the same message, when a Run asks for a token.
            trace(`auth: no usable Cursor token at startup (${errorMessage(error)})`);
            return undefined;
        }
    }
    async function loadModels() {
        const cached = await readCache(cacheDir);
        if (cached?.models.length && isCacheFresh(cached)) {
            return modelsToConfig(cached.models);
        }
        // Config runs before auth.loader and has no getAuth(); read the durable
        // store (normally the same source getAuth() uses). Refresh missing, expired,
        // or old-schema caches here so this process materializes the new model set.
        const auth = await authFromStore();
        if (auth) {
            const accessToken = await startupAccessToken(auth, authFromStore);
            if (accessToken) {
                try {
                    const models = await discoverModels(accessToken, cacheDir, { baseURL: apiBaseURL });
                    return modelsToConfig(models);
                }
                catch {
                    // No usable cache and discovery failed — leave the list empty.
                }
            }
        }
        // Preserve stale-on-failure/offline behavior for an existing cache.
        return cached?.models.length ? modelsToConfig(cached.models) : {};
    }
    return {
        tool: {
            // `websearch` is a reserved OpenCode id and is filtered for third-party
            // providers after plugin tools are merged. Use the collision-safe id
            // Cursor already sees so this host-side fallback survives that filter.
            custom_websearch: classicTools.webSearch,
            // Commits Cursor-generated image bytes, which cannot travel through the
            // host's text `write`. Handle-only, so its presence in the catalog does
            // not give any model a way to write arbitrary files — see image-save.ts.
            cursor_image_save: classicTools.imageSave,
        },
        async event({ event }) {
            switch (event.type) {
                case "session.created":
                    sessionActivity.linkSession(event.properties.info.id, event.properties.info.parentID);
                    sessionActivity.recordActivity(event.properties.info.id);
                    break;
                case "session.updated":
                    sessionActivity.linkSession(event.properties.info.id, event.properties.info.parentID);
                    break;
                case "session.deleted":
                    sessionActivity.removeSession(event.properties.info.id);
                    break;
                case "message.updated":
                    sessionActivity.recordActivity(event.properties.info.sessionID);
                    break;
                case "message.part.updated":
                    sessionActivity.recordActivity(event.properties.part.sessionID);
                    break;
            }
            await dispatchHostEventBridge({
                event,
                client: input.client,
                directory: input.directory,
                serverUrl: input.serverUrl,
            });
        },
        async "tool.execute.before"(hookInput, output) {
            if (hookInput.tool !== "bash")
                return;
            // bash/zsh retain the original display/permission command and wrap via
            // shell.env. sh/dash need a short wrapper-file command because their
            // non-interactive `-c` path ignores BASH_ENV / ZDOTDIR.
            prepareCursorShellArgs(hookInput.callID, output.args);
        },
        async "shell.env"(hookInput, output) {
            const env = cursorShellEnvForCall(hookInput.callID);
            if (!env)
                return;
            Object.assign(output.env, env);
        },
        async "tool.execute.after"(hookInput, output) {
            if (hookInput.tool !== "bash")
                return;
            try {
                output.title = cursorShellOriginalCommand(hookInput.callID) ?? output.title;
                output.output = captureCursorShellResult(hookInput.callID, output.output, output.metadata);
                // OpenCode's bash GUI falls back to metadata.output when output is empty
                // (`props.output || props.metadata.output`), so strip private markers there too.
                if (output.metadata && typeof output.metadata === "object") {
                    const metadata = output.metadata;
                    if (typeof metadata.output === "string") {
                        metadata.output = sanitizeRegisteredCursorShellOutput(hookInput.callID, metadata.output);
                    }
                }
            }
            finally {
                releaseCursorShellEnv(hookInput.callID);
            }
        },
        async "chat.params"(hookInput, output) {
            if (hookInput.model.providerID !== CURSOR_PROVIDER_ID)
                return;
            // Agent changes can replace the host system prompt and mode contract.
            // Carry the canonical OpenCode id so an incompatible Cursor checkpoint
            // is rotated instead of resuming the prior agent's prompt.
            output.options[CURSOR_HOST_AGENT_OPTION] = hookInput.agent;
            // First Cursor request: the host now serves its API, so read its agents
            // before any Run can raise SwitchMode. Concurrent first requests share
            // the one read; later requests find it settled.
            hostAgentsLoaded ??= refreshHostAgents?.();
            await hostAgentsLoaded;
            // Know the session's own plan file (OpenCode's `Session.plan`) before the
            // Run starts, so CreatePlan records the plan where the plan agent and
            // plan_exit read it. It is fixed per session, so resolve it once.
            if (hookInput.agent !== "compaction" && getSession && !isHostPlanFileResolved(hookInput.sessionID)) {
                await resolveHostPlanFile({
                    sessionID: hookInput.sessionID,
                    getSession,
                    worktree: input.worktree || input.project?.worktree,
                    vcs: !!input.project?.vcs,
                });
            }
            // OpenCode's compaction pipeline invokes the LLM with agent="compaction".
            // Carry that stable runtime fact into LanguageModelV3 providerOptions so
            // the provider never has to guess from an empty tool list.
            if (hookInput.agent === "compaction") {
                output.options[CURSOR_COMPACTION_OPTION] = true;
            }
        },
        async config(cfg) {
            setCursorShellPath(cfg.shell);
            cfg.provider ??= {};
            const models = await loadModels();
            const existing = cfg.provider[CURSOR_PROVIDER_ID];
            if (existing) {
                // Provider already declared (e.g. README stub with models: {}) —
                // still inject the cached model list when the user hasn't filled it in.
                const existingModels = existing.models;
                if (!existingModels || Object.keys(existingModels).length === 0) {
                    ;
                    existing.models = models;
                }
                return;
            }
            cfg.provider[CURSOR_PROVIDER_ID] = {
                name: "Cursor Integration",
                npm: MODULE_URL,
                models,
            };
        },
        auth: {
            provider: CURSOR_PROVIDER_ID,
            methods: [
                {
                    type: "oauth",
                    label: "Cursor account (browser login)",
                    async authorize() {
                        const params = generatePkceParams();
                        const challenge = await generatePkceChallenge(params.verifier);
                        const websiteUrl = process.env.CURSOR_WEBSITE_URL ?? `https://${CURSOR_WEBSITE_HOST}`;
                        const apiBaseUrl = process.env.CURSOR_API_BASE_URL ?? `https://${CURSOR_API_HOST}`;
                        const url = buildLoginUrl(challenge, params.uuid, websiteUrl);
                        return {
                            url,
                            instructions: "Open this URL in a browser to sign in to Cursor",
                            method: "auto",
                            async callback() {
                                const result = await pollForTokens(params.uuid, params.verifier, apiBaseUrl);
                                return {
                                    type: "success",
                                    provider: CURSOR_PROVIDER_ID,
                                    access: result.accessToken,
                                    refresh: result.refreshToken,
                                    expires: decodeJwtExpiryMs(result.accessToken) ?? Date.now(),
                                };
                            },
                        };
                    },
                },
                {
                    type: "api",
                    label: "API key (cursor.com/settings)",
                    prompts: [
                        {
                            type: "text",
                            key: "apiKey",
                            message: "Cursor API key",
                            placeholder: "crsr_...",
                            validate(value) {
                                if (!value.startsWith("crsr_"))
                                    return "API key should start with crsr_";
                                return undefined;
                            },
                        },
                    ],
                    async authorize(inputs) {
                        const apiKey = inputs?.apiKey;
                        if (!apiKey)
                            return { type: "failed" };
                        try {
                            const result = await exchangeApiKey(apiKey, apiBaseURL);
                            return {
                                type: "success",
                                key: result.accessToken,
                                provider: CURSOR_PROVIDER_ID,
                                // Keep the raw key: Cursor renews an API-key login only by
                                // exchanging the key again (its refresh token is never used).
                                metadata: { apiKey },
                            };
                        }
                        catch {
                            return { type: "failed" };
                        }
                    },
                },
            ],
            async loader(getAuth) {
                const readCurrent = () => authForLoader(getAuth);
                const auth = await readCurrent();
                // Model discovery and endpoint warmup need a token: like any request,
                // that renews a due session (or expiring API-key JWT) first.
                const accessToken = auth ? await startupAccessToken(auth, readCurrent) : undefined;
                if (accessToken) {
                    // Skip when config already filled a fresh cache (avoids a second
                    // AvailableModels round-trip + background refresh on cold start).
                    const cached = await readCache(cacheDir);
                    if (!cached || cached.models.length === 0 || !isCacheFresh(cached)) {
                        // Await so an empty/missing cache is written before the loader returns
                        // (fire-and-forget often loses the race on short-lived CLI commands).
                        await discoverModels(accessToken, cacheDir, { baseURL: apiBaseURL }).catch(() => { });
                    }
                    // Resolve the region-specific Run stream origin so the first turn
                    // does not spend time on GetServerConfig. Best-effort: a failure is
                    // surfaced by startSession, which can fail the actual model call with
                    // a clear endpoint-resolution error instead of using global fallback.
                    await resolveAgentUrl(accessToken, {
                        apiBaseURL,
                        telemetryEnabled: cursorGetServerConfigTelemetryEnabled(),
                    }).catch(() => { });
                }
                // Asked for on every Run open: reads the live credential (so a
                // re-login applies without a restart), renews it when due, persists the
                // renewal. This is how OpenCode's own OAuth providers hand over
                // credentials (codex, xai, copilot: a `fetch` that calls getAuth() per
                // request): no token is placed in the options, which OpenCode serves
                // unredacted from /provider; a function is dropped there.
                const getAccessToken = async (request) => {
                    const current = await readCurrent();
                    const token = current
                        ? await resolveAccessToken(current, readCurrent, request?.forceRefresh === true)
                        : undefined;
                    if (!token)
                        throw new CursorAuthError("No Cursor login found; sign in to Cursor", { code: "no_credential" });
                    return token;
                };
                return {
                    getAccessToken,
                    workspaceRoot: input.directory,
                    cacheDir,
                };
            },
        },
    };
}
