/**
 * Host-owned primary-agent synchronization for Cursor SwitchMode.
 *
 * The language model stays host-neutral: it records a canonical Cursor mode
 * (`plan`, `spec`, `agent`, ...). A host entrypoint may install this structural
 * callback when its public API can select the corresponding primary agent.
 * OpenCode 2.0 uses it to select its vendor-maintained `plan` / `build` agents
 * and continues the turn via `session.synthetic` (OpenCode 2 `switchAgent`
 * only publishes the agent and would otherwise idle).
 * On OpenCode 1.x hosts, advertised `plan_enter` / `plan_exit` tools stay
 * authoritative; without `plan_enter`, the classic entrypoint selects the
 * `plan` agent the 1.x way, with a synthetic user message for that agent.
 */
import { errorMessage, trace } from "./debug.js";
/**
 * Live switches, newest last. A host may set the plugin up more than once in
 * one process (one setup per location instance, re-setup on plugin reload) and
 * dispose an older setup after a newer one installed its switch.
 */
const registrations = [];
function activeSwitch() {
    return registrations[registrations.length - 1];
}
const pending = new Map();
const applying = new Map();
const MAX_PENDING_HOST_AGENT_SWITCHES = 256;
/** True for Cursor mode ids served by the host's `plan` primary agent. */
function isPlanModeID(targetModeID) {
    const mode = targetModeID.trim().toLowerCase();
    return mode === "plan" || mode === "spec";
}
/** Synthetic user text that carries an OpenCode 1.x primary-agent switch. */
export function hostAgentSwitchPromptText(agent) {
    return agent === "plan"
        ? "Plan mode is now active. Continue planning the request above under the plan-mode " +
            "instructions, and do not implement anything until the plan is approved."
        : "Plan mode has ended. Continue with the approved work.";
}
/**
 * OpenCode 1.x shape of the switch: a 1.x session runs each turn under the
 * agent of its latest user message, which is how the host's own plan_enter /
 * plan_exit change agents.
 *
 * It accepts only a real transition of a session running one of the host's
 * own primary agents: entering an existing `plan` agent from another primary
 * agent, or leaving the observed `plan` agent. Subagent and hidden internal
 * sessions (title, summary, compaction, task children) never get a user turn
 * injected.
 */
export function createPromptHostAgentModeSwitch(prompt, primaryAgents) {
    return {
        accepts: ({ targetModeID, hostAgent }) => {
            const agents = primaryAgents();
            const current = hostAgent?.trim();
            if (!agents || !current || !agents.has(current))
                return false;
            return isPlanModeID(targetModeID) ? current !== "plan" && agents.has("plan") : current === "plan";
        },
        apply: async ({ sessionID, targetModeID }) => {
            const agent = isPlanModeID(targetModeID) ? "plan" : "build";
            await prompt({ sessionID, agent, text: hostAgentSwitchPromptText(agent) });
        },
    };
}
/**
 * Install this host's native switch; it is used until a newer one is
 * installed. The returned disposer removes only this switch, so disposing an
 * older setup never removes a newer setup's switch. `undefined` removes all.
 */
export function setHostAgentModeSwitch(fn, options = {}) {
    if (!fn) {
        registrations.length = 0;
        pending.clear();
        return () => { };
    }
    const registration = { fn, options };
    registrations.push(registration);
    return () => {
        const index = registrations.lastIndexOf(registration);
        if (index >= 0)
            registrations.splice(index, 1);
        if (registrations.length === 0)
            pending.clear();
    };
}
/**
 * How this host applies a Cursor mode switch to its primary agents: `resumes`
 * when the switch also starts the next host turn, `next-turn` when the user's
 * next message runs under the new agent, undefined without a native switch.
 */
export function hostAgentModeSwitchKind() {
    const active = activeSwitch();
    if (!active)
        return undefined;
    return active.options.resumesTurn === true ? "resumes" : "next-turn";
}
/** Queue only when this host installed a native primary-agent switch that accepts the request. */
export function queueHostAgentModeSwitch(input) {
    const sessionID = input.sessionID.trim();
    const targetModeID = input.targetModeID.trim();
    const active = activeSwitch();
    if (!active || !sessionID || !targetModeID)
        return false;
    if (active.options.accepts && !active.options.accepts({ ...input, sessionID, targetModeID }))
        return false;
    const hostAgent = input.hostAgent?.trim();
    pending.set(sessionID, {
        sessionID,
        targetModeID,
        ...(input.cursorSessionID ? { cursorSessionID: input.cursorSessionID } : {}),
        ...(hostAgent ? { hostAgent } : {}),
        attempts: 0,
    });
    while (pending.size > MAX_PENDING_HOST_AGENT_SWITCHES) {
        const oldest = pending.keys().next().value;
        if (!oldest)
            break;
        pending.delete(oldest);
    }
    trace(`host-agent-mode: pending sessionID=${sessionID} ` +
        `cursorSessionID=${input.cursorSessionID ?? ""} target=${targetModeID}`);
    return true;
}
/**
 * True while an approved switch into the host `plan` agent waits for its Run to
 * end and will itself start the plan-agent turn that continues the work.
 */
export function isHostPlanEntryPending(sessionID) {
    if (activeSwitch()?.options.resumesTurn !== true)
        return false;
    const key = sessionID?.trim();
    const target = key ? pending.get(key)?.targetModeID : undefined;
    return target !== undefined && isPlanModeID(target);
}
export function cancelHostAgentModeSwitch(sessionID) {
    const key = sessionID?.trim();
    if (key)
        pending.delete(key);
}
/**
 * Apply the switch only after its Cursor Run is terminal and owns no pending
 * execs. This avoids changing the host's permission/catalog state underneath a
 * held Run that still needs to finish or receive a tool result.
 */
export async function flushHostAgentModeSwitch(sessionID, options = {}) {
    const key = sessionID?.trim();
    if (!key)
        return false;
    const state = pending.get(key);
    const apply = activeSwitch()?.fn;
    if (!state || !apply || applying.has(key))
        return false;
    if (options.terminal !== true || options.pumpActive || (options.pendingExecs ?? 0) > 0) {
        return false;
    }
    if (state.cursorSessionID
        && options.cursorSessionID
        && state.cursorSessionID !== options.cursorSessionID) {
        // A newer Run reached its terminal boundary, so the owner was superseded
        // before its native-agent switch could be applied. Never let that stale
        // request mutate a later turn, and do not retain it indefinitely.
        pending.delete(key);
        trace(`host-agent-mode: discarded stale Run sessionID=${key} ` +
            `owner=${state.cursorSessionID} terminal=${options.cursorSessionID}`);
        return false;
    }
    state.attempts += 1;
    applying.set(key, state);
    try {
        await apply(state);
        // A request queued during the callback belongs to a later transition.
        if (pending.get(key) === state)
            pending.delete(key);
        trace(`host-agent-mode: switched sessionID=${key} target=${state.targetModeID}`);
        return true;
    }
    catch (error) {
        // Keep the request pending so a later explicit provider turn can retry at
        // its own terminal boundary. The provider-owned mode reminder remains the
        // behavioral fallback until the native host switch succeeds.
        if (pending.get(key) === state)
            delete state.cursorSessionID;
        trace(`host-agent-mode: FAILED sessionID=${key} target=${state.targetModeID} ` +
            `attempts=${state.attempts} err=${errorMessage(error)}`);
        return false;
    }
    finally {
        if (applying.get(key) === state)
            applying.delete(key);
    }
}
export function resetHostAgentModeSwitchForTests() {
    registrations.length = 0;
    pending.clear();
    applying.clear();
}
