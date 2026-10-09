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
export type HostAgentModeSwitchInput = {
    sessionID: string;
    targetModeID: string;
    /** Concrete Cursor Run that owns the switch. */
    cursorSessionID?: string;
    /** Host primary agent the owning Run executed under, when the host reported it. */
    hostAgent?: string;
};
export type HostAgentModeSwitchFn = (input: HostAgentModeSwitchInput) => void | Promise<void>;
export type HostAgentModeSwitchOptions = {
    /** The switch also starts the host turn that continues the conversation. */
    resumesTurn?: boolean;
    /** Queue-time filter: a request the switch would not apply stays provider-owned. */
    accepts?: (input: HostAgentModeSwitchInput) => boolean;
};
/** Synthetic user text that carries an OpenCode 1.x primary-agent switch. */
export declare function hostAgentSwitchPromptText(agent: "plan" | "build"): string;
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
export declare function createPromptHostAgentModeSwitch(prompt: (input: {
    sessionID: string;
    agent: "plan" | "build";
    text: string;
}) => Promise<unknown>, primaryAgents: () => ReadonlySet<string> | undefined): {
    apply: HostAgentModeSwitchFn;
    accepts: (input: HostAgentModeSwitchInput) => boolean;
};
/**
 * Install this host's native switch; it is used until a newer one is
 * installed. The returned disposer removes only this switch, so disposing an
 * older setup never removes a newer setup's switch. `undefined` removes all.
 */
export declare function setHostAgentModeSwitch(fn: HostAgentModeSwitchFn | undefined, options?: HostAgentModeSwitchOptions): () => void;
/**
 * How this host applies a Cursor mode switch to its primary agents: `resumes`
 * when the switch also starts the next host turn, `next-turn` when the user's
 * next message runs under the new agent, undefined without a native switch.
 */
export declare function hostAgentModeSwitchKind(): "resumes" | "next-turn" | undefined;
/** Queue only when this host installed a native primary-agent switch that accepts the request. */
export declare function queueHostAgentModeSwitch(input: HostAgentModeSwitchInput): boolean;
/**
 * True while an approved switch into the host `plan` agent waits for its Run to
 * end and will itself start the plan-agent turn that continues the work.
 */
export declare function isHostPlanEntryPending(sessionID: string | undefined): boolean;
export declare function cancelHostAgentModeSwitch(sessionID: string | undefined): void;
/**
 * Apply the switch only after its Cursor Run is terminal and owns no pending
 * execs. This avoids changing the host's permission/catalog state underneath a
 * held Run that still needs to finish or receive a tool result.
 */
export declare function flushHostAgentModeSwitch(sessionID: string | undefined, options?: {
    cursorSessionID?: string;
    terminal?: boolean;
    pumpActive?: boolean;
    pendingExecs?: number;
}): Promise<boolean>;
export declare function resetHostAgentModeSwitchForTests(): void;
