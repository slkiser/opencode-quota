/**
 * Cursor-native SwitchMode ⇄ OpenCode `plan_enter` / `plan_exit`.
 *
 * Cursor raises `switch_mode_request_query` (#4) with SwitchModeArgs and blocks
 * until the client replies approved{} or rejected{reason} (no async variant).
 * Cursor CLI prompts the user, then flips unifiedMode and injects a
 * `<system_reminder>` describing how to behave in that mode.
 * Display `switch_mode_tool_call` (#25) is a separate transcript record and is
 * not replayed as a host tool.
 *
 * OpenCode 1.x mapping (advertisement-gated):
 * - plan, spec → plan_enter
 * - every other non-empty target → plan_exit (leave plan for OpenCode build),
 *   then inject the Cursor CLI-shaped mode reminder for that target
 *
 * Upstream OpenCode's plan tools are not mode flags. Each one asks the user
 * through the Question service and, on "Yes", injects a synthetic user message
 * carrying `agent: "plan" | "build"`, which `createUserMessage` turns into a
 * `setAgentModel` primary-agent switch (opencode `tool/plan.ts`,
 * `session/prompt.ts`). OpenCode 2 exposes `session.switchAgent`; its
 * entrypoint installs a structural callback that selects the native `plan` or
 * `build` primary agent after the owning Cursor Run becomes terminal:
 *
 * - entering plan/spec needs no host tool at all — approve immediately and let
 *   the injected <system_reminder> carry the contract, exactly as Cursor CLI's
 *   own plan mode is prompt-enforced.
 * - leaving the host's own `plan` agent without its `plan_exit` goes through
 *   CreatePlan, whose `question` prompt is the execution approval, so the
 *   request is rejected with a pointer there (or, with no `question`, to the
 *   user's agent switch); a Cursor-only plan mode has nothing on the host to
 *   leave and is approved.
 *
 * Resolution is keyed solely on the advertised catalog under canonical
 * OpenCode tool names — never on any external identity or model id.
 *
 * CLI reject reason for user declines: "Mode switch rejected by user"
 * (chunk-7076/dist/ui.js onSwitchModeReject).
 */
import { CURSOR_PLAN_STAGE_TOOL } from "./create-plan.js";
import { decodeMessageSparse } from "./messages.js";
/**
 * `PendingExec.resultField` for a held-open SwitchMode InteractionQuery.
 * Continuation writes an InteractionResponse, not an ExecClientMessage.
 */
export const SWITCH_MODE_RESULT_FIELD = "switch_mode_request_response";
/** CLI verbatim when the user rejects the mode switch. */
export const USER_REJECTED_REASON = "Mode switch rejected by user";
export const MISSING_QUERY_REASON = "Missing switch-mode query";
export const MISSING_ARGS_REASON = "Missing switch-mode arguments";
export const MISSING_TARGET_REASON = "Missing targetModeId";
/**
 * A turn that cannot call host tools is a lifecycle turn (title generation,
 * compaction, summarization). OpenCode opens one alongside the real Run, and it
 * must not mutate session state — approving there flips plan mode twice and
 * lets the throwaway turn write its own plan file.
 *
 * Soft-ack with `approved{}` instead of `rejected{reason}`: a hard reject lands
 * in the transcript and the real turn narrates "mode switches are blocked"
 * even though the next Run will succeed. CreatePlan already soft-acks the same
 * case; SwitchMode must match.
 */
/**
 * The host's plan agent is active and offers no `plan_exit`: on such a host
 * the user ends plan mode by switching agents, so the model cannot.
 */
export const PLAN_EXIT_BY_USER_REASON = "This host leaves plan mode when the user switches from the plan agent to the build " +
    "agent. Ask the user to switch agents when the plan is ready; do not implement before then.";
/**
 * The host's plan agent is active, offers no `plan_exit`, but can ask: leaving
 * plan mode goes through CreatePlan, whose `question` prompt is the approval.
 */
export const PLAN_EXIT_VIA_CREATE_PLAN_REASON = "Leave plan mode by recording the finished plan with Cursor CreatePlan: the user is then " +
    "asked whether to switch to the build agent and start implementing. Do not implement before they approve.";
const activeCursorModeBySession = new Map();
const MAX_ACTIVE_CURSOR_MODES = 256;
function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
}
function str(value) {
    return typeof value === "string" ? value : "";
}
/** Normalize Cursor mode ids for comparison. */
export function normalizeSwitchModeId(targetModeId) {
    return targetModeId.trim().toLowerCase();
}
/**
 * Map a Cursor unified-mode id onto an OpenCode plan enter/exit tool.
 * Does not check advertisement — callers gate on the host catalog.
 *
 * plan/spec enter plan; every other non-empty target leaves plan via plan_exit
 * (host-portable primary switch) and relies on {@link cursorModeSystemReminder}
 * for CLI-shaped behavioral guidance.
 */
export function mapSwitchModeTarget(targetModeId) {
    const id = normalizeSwitchModeId(targetModeId);
    if (!id)
        return { ok: false, reason: MISSING_TARGET_REASON };
    if (id === "plan" || id === "spec") {
        return { ok: true, toolName: "plan_enter" };
    }
    return { ok: true, toolName: "plan_exit" };
}
/**
 * Resolve how this SwitchMode target is satisfied, keyed only on the advertised
 * catalog under canonical tool names.
 *
 * A missing plan tool is not a refusal: entering plan mode needs no host tool.
 * Leaving the host's own plan agent without `plan_exit` is approved through
 * CreatePlan (or the user's agent switch when nothing can ask), and a
 * Cursor-only plan mode (no host plan agent) has nothing on the host to leave.
 */
export function resolveSwitchModeBridge(targetModeId, options) {
    const mapped = mapSwitchModeTarget(targetModeId);
    if (!mapped.ok)
        return { kind: "reject", reason: mapped.reason };
    // Lifecycle turn: soft-ack on the wire, no session mutation. A hard reject
    // would enter the transcript and make the real turn narrate a blocked switch.
    if (!options.allowTools)
        return { kind: "ack" };
    // Already in the target mode: nothing to approve. Cursor's own IDE handler
    // auto-approves here too, and without this a model that asks to leave plan
    // mode after the plan write already prompted would ask the user twice.
    if (options.activeModeId
        && normalizeSwitchModeId(options.activeModeId) === normalizeSwitchModeId(targetModeId)) {
        return { kind: "approve" };
    }
    const names = options.advertised instanceof Set
        ? options.advertised
        : new Set(options.advertised);
    if (names.has(mapped.toolName))
        return { kind: "native", toolName: mapped.toolName };
    // Entering plan mode is provider-owned: the injected <system_reminder> is the
    // whole contract, exactly as Cursor CLI's own plan mode is prompt-enforced.
    if (mapped.toolName === "plan_enter")
        return { kind: "approve" };
    if (options.hostAgent === "plan") {
        return {
            kind: "reject",
            reason: names.has("question") ? PLAN_EXIT_VIA_CREATE_PLAN_REASON : PLAN_EXIT_BY_USER_REASON,
        };
    }
    return { kind: "approve" };
}
/** Decode a `switch_mode_request_query` body, or undefined when unusable. */
export function decodeSwitchModeQuery(queryBytes) {
    let decoded;
    try {
        decoded = decodeMessageSparse("SwitchModeRequestQuery", queryBytes);
    }
    catch {
        return undefined;
    }
    const argsRecord = asRecord(decoded.args);
    if (!argsRecord)
        return undefined;
    const targetModeId = str(argsRecord.target_mode_id);
    if (!targetModeId.trim())
        return undefined;
    const toolCallId = str(argsRecord.tool_call_id) || str(decoded.tool_call_id);
    return {
        args: {
            targetModeId,
            explanation: str(argsRecord.explanation),
            toolCallId,
        },
        toolCallId,
    };
}
/** OpenCode plan_enter / plan_exit advertise empty input. */
export function switchModeToolInput() {
    return {};
}
/** Shape `approved{}` / `rejected{reason}` for encodeMessage. */
export function switchModeApprovedResult() {
    return { approved: {} };
}
export function switchModeRejectedResult(reason) {
    return { rejected: { reason } };
}
/**
 * Host tool outcome → Cursor SwitchModeRequestResponse.
 * Question/permission declines and empty failures use the CLI user-reject string.
 */
export function switchModeResultFromToolOutput(output, isError) {
    if (!isError)
        return switchModeApprovedResult();
    const trimmed = output.trim();
    // OpenCode plan tools throw Question.RejectedError on "No" — treat as user reject.
    if (!trimmed
        || /reject/i.test(trimmed)
        || /denied/i.test(trimmed)
        || /permission/i.test(trimmed)
        || /cancelled|canceled|dismissed/i.test(trimmed)) {
        return switchModeRejectedResult(USER_REJECTED_REASON);
    }
    return switchModeRejectedResult(trimmed);
}
/** Record the approved Cursor mode for later system-reminder injection. */
export function setActiveCursorMode(sessionKey, targetModeId, options = {}) {
    if (!sessionKey)
        return;
    const modeId = normalizeSwitchModeId(targetModeId);
    if (!modeId)
        return;
    activeCursorModeBySession.set(sessionKey, {
        modeId,
        firstTurn: true,
        bridgedPlanEntered: options.bridgedPlanEntered === true,
    });
    while (activeCursorModeBySession.size > MAX_ACTIVE_CURSOR_MODES) {
        const oldest = activeCursorModeBySession.keys().next().value;
        if (!oldest)
            break;
        activeCursorModeBySession.delete(oldest);
    }
}
export function getActiveCursorMode(sessionKey) {
    if (!sessionKey)
        return undefined;
    return activeCursorModeBySession.get(sessionKey)?.modeId;
}
/** True while the provider has an approved Cursor plan/spec mode for this session. */
export function isCursorPlanModeActive(sessionKey) {
    const mode = getActiveCursorMode(sessionKey);
    return mode === "plan" || mode === "spec";
}
/** True while Cursor plan/spec mode is one the host enforces (see `bridgedPlanEntered`). */
export function isBridgedCursorPlanModeActive(sessionKey) {
    if (!sessionKey)
        return false;
    const state = activeCursorModeBySession.get(sessionKey);
    return (state?.modeId === "plan" || state?.modeId === "spec") && state.bridgedPlanEntered;
}
/**
 * Cursor plan mode follows the host's `plan` primary agent, as Cursor CLI's
 * mode follows its own mode switch (Shift+Tab, `/plan`).
 *
 * - A turn under the host plan agent puts Cursor in plan mode, however the
 *   host got there (its agent picker, a plan_enter approval).
 * - The host's own exit from that agent (a plan_exit approval, or an agent
 *   switch in its UI) ends Cursor plan mode. Only an observed `plan` → other
 *   transition counts, so Cursor-only modes (debug, ask, …) under the host's
 *   ordinary agent are kept; the next Run then carries the agent-mode
 *   reminder instead of a stale "plan mode is still active" one.
 */
export function followHostPlanAgent(sessionKey, previousHostAgent, hostAgent) {
    if (!sessionKey || !hostAgent)
        return undefined;
    if (hostAgent === "plan") {
        if (isBridgedCursorPlanModeActive(sessionKey))
            return undefined;
        // The host runs its own plan agent, so it enforces this plan mode.
        setActiveCursorMode(sessionKey, "plan", { bridgedPlanEntered: true });
        return "entered";
    }
    if (previousHostAgent !== "plan" || !isCursorPlanModeActive(sessionKey))
        return undefined;
    setActiveCursorMode(sessionKey, "agent");
    return "left";
}
/**
 * `agent.v1.AgentMode` for a Cursor mode id, as Cursor CLI derives
 * `UserMessage.mode` from its current mode: plan, ask, and debug are their own
 * modes; every other mode (agent, spec, triage, …) runs as agent.
 */
export function cursorAgentModeWireValue(modeId) {
    switch (normalizeSwitchModeId(modeId ?? "")) {
        case "plan":
            return 3;
        case "chat":
        case "ask":
        case "search":
            return 2;
        case "debug":
            return 4;
        default:
            return 1;
    }
}
/** Conversation that already received the host plan-exit call shape, per session. */
const hostPlanExitNoteBySession = new Map();
function describeToolArguments(schema) {
    const record = asRecord(schema);
    const properties = asRecord(record?.properties);
    const names = properties ? Object.keys(properties) : [];
    if (names.length === 0)
        return "It takes no arguments: call it with `{}`.";
    const required = new Set(Array.isArray(record?.required) ? record.required.filter((name) => typeof name === "string") : []);
    const lines = names.map((name) => {
        const property = asRecord(properties[name]);
        const type = str(property?.type) || "value";
        const description = str(property?.description).trim();
        return `- \`${name}\` (${type}, ${required.has(name) ? "required" : "optional"})` +
            (description ? `: ${description}` : "");
    });
    return `Its arguments (use exactly these names):\n${lines.join("\n")}`;
}
/**
 * One-shot translation of the host plan agent's workflow into Cursor terms,
 * delivered once per Cursor conversation while that agent owns the turn.
 *
 * With the host's plan file known, Cursor's native CreatePlan carries out the
 * host instruction "write the plan file, then call plan_exit" (see the `exit`
 * CreatePlan bridge), so the model needs no host tool at all. Without it, the
 * model is given `plan_exit`'s exact call shape from the live schema: the
 * RequestContext overlay is names-only, and otherwise it must look the tool up
 * (or guess its arguments) before it can submit the plan.
 */
export function takeHostPlanAgentNote(sessionKey, conversationId, hostAgent, tools, options = {}) {
    if (!sessionKey)
        return undefined;
    if (hostAgent !== "plan") {
        hostPlanExitNoteBySession.delete(sessionKey);
        return undefined;
    }
    const planExit = tools.find((tool) => tool.name === "plan_exit");
    // A host plan-stage tool carries the plan to the host review itself.
    if (tools.some((tool) => tool.name === CURSOR_PLAN_STAGE_TOOL))
        return undefined;
    if (!planExit || hostPlanExitNoteBySession.get(sessionKey) === conversationId)
        return undefined;
    hostPlanExitNoteBySession.delete(sessionKey);
    hostPlanExitNoteBySession.set(sessionKey, conversationId);
    while (hostPlanExitNoteBySession.size > MAX_ACTIVE_CURSOR_MODES) {
        const oldest = hostPlanExitNoteBySession.keys().next().value;
        if (!oldest)
            break;
        hostPlanExitNoteBySession.delete(oldest);
    }
    if (options.hostPlanFile) {
        return wrapReminder("The host plan agent is active. When the plan is ready, record it with CreatePlan. " +
            `CreatePlan saves it as the host's plan file (${options.hostPlanFile}) and submits it ` +
            "to the host's plan review, which asks the user; this carries out the host " +
            "instructions to write the plan file and call plan_exit, so do neither yourself. " +
            "Do not implement until the user approves.");
    }
    return wrapReminder("The host plan agent is active. When the plan file is written and ready for review, " +
        `submit it by calling MCP tool \`plan_exit\` on server \`${options.server ?? "opencode"}\` directly. ` +
        "Its full definition is below, so do not look it up with GetMcpTools first. " +
        describeToolArguments(planExit.inputSchema));
}
export function clearActiveCursorMode(sessionKey) {
    if (!sessionKey)
        return;
    activeCursorModeBySession.delete(sessionKey);
}
export function resetActiveCursorModesForTests() {
    activeCursorModeBySession.clear();
    hostPlanExitNoteBySession.clear();
}
function wrapReminder(body) {
    return `<system_reminder>\n${body.trim()}\n</system_reminder>`;
}
/**
 * Cursor CLI-shaped mode reminder for the active unified mode.
 * Tool names are adapted to OpenCode (`task`, `question`) where the CLI names
 * Cursor-only tools; the behavioral contract matches the CLI reminders.
 */
export function cursorModeSystemReminder(targetModeId, options = {}) {
    const id = normalizeSwitchModeId(targetModeId);
    if (!id)
        return undefined;
    const first = options.firstTurn !== false;
    // A host plan-stage tool writes the artifact and its result names the
    // follow-up that requests approval. plan_exit only leaves plan mode.
    // Without either, CreatePlan asks through `question` whether to implement;
    // with no `question` either, the user leaves plan mode by switching agents.
    // Naming an unavailable tool would strand the model.
    const leavePlan = options.planStageAdvertised
        ? "record the finished plan with Cursor CreatePlan. The host stage tool waits for the host plan review and does not return until the user accepts or declines. Do not call `plan_exit` to submit or skip that review, and do not implement until the tool returns success"
        : options.planExitAdvertised === false
            ? options.questionAdvertised
                ? "record the finished plan with Cursor CreatePlan. Writing it needs no approval; the user is then asked whether to switch to the build agent and start implementing. If they decline, refine the plan and record it again"
                : "record the finished plan (Cursor CreatePlan), then tell the user it is ready: they switch to the build agent to have it implemented"
            : "record the finished plan, then call OpenCode `plan_exit` so the user can approve leaving plan mode";
    if (id === "plan" || id === "spec") {
        return wrapReminder(first
            ? `Plan mode is active. The user does not want execution yet -- you MUST NOT make edits, run non-readonly tools (including changing configs or making commits), or otherwise modify system state. This supersedes any conflicting instruction.

1. Research enough to make an accurate plan.
2. Before finishing, resolve decisions that would materially change the implementation path, touched files, architecture, user-visible behavior, data model, or validation strategy. If investigation cannot resolve one, ask clarifying questions in small batches (use the OpenCode \`question\` tool when available).
3. Do not put choices in the plan for the user to resolve. The plan must present one recommended approach, not unresolved questions or "choose A or B" options.
4. When ready, ${leavePlan}.
5. Do not execute the plan until the user confirms it.`
            : `Plan mode is still active. You MUST NOT make edits, run non-readonly tools (including changing configs or making commits), or otherwise modify system state. This supersedes any conflicting instruction.`);
    }
    if (id === "chat") {
        return wrapReminder(first
            ? `Ask mode is active. The user wants you to answer questions about their codebase or coding in general. You MUST NOT make any edits, run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supersedes any other instructions you have received (for example, to make edits).

Your role in Ask mode:

1. Answer the user's questions comprehensively and accurately. Focus on providing clear, detailed explanations.
2. Use readonly tools to explore the codebase and gather information needed to answer the user's questions.
3. Provide code examples and references when helpful, citing specific file paths and line numbers.
4. If you need more information, ask the user for clarification (OpenCode \`question\` when available).
5. You may provide suggestions about how to implement something, but you MUST NOT actually implement it yourself.
6. If the user asks you to make changes or implement something, politely remind them that you're in Ask mode and can only provide information and guidance. Suggest they switch to Agent mode (OpenCode \`plan_exit\` / SwitchMode target agent) if they want you to make changes.`
            : `Ask mode is still active. You MUST NOT make any edits, run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supersedes any other instructions you have received (for example, to make edits).`);
    }
    if (id === "debug") {
        return wrapReminder(first
            ? `You are now in **DEBUG MODE**. You must debug with **runtime evidence**.

**Why this approach:** Traditional AI agents jump to fixes claiming high confidence, but fail due to lacking runtime information. You cannot and must NOT fix bugs from code-only guesses — you need actual runtime data.

**Your systematic workflow:**
1. Generate 3-5 precise hypotheses about WHY the bug occurs.
2. Instrument code with logs to test hypotheses in parallel.
3. Ask the user to reproduce the bug. Conclude with a <reproduction_steps>...</reproduction_steps> block when the user must run something (mandatory unless the issue is fully confirmed fixed).
4. Analyze logs, accept/reject hypotheses, and only then implement a fix.
5. Verify the fix with runtime evidence before claiming success.

Prefer reproduction, runtime logs, and end-to-end verification over speculative refactors.`
            : `Debug mode is still active. You must debug with **runtime evidence**.

**During fixes:** Do NOT remove instrumentation until post-fix verification logs prove success or the user explicitly asks you to remove it.
**Testing:** Prefer reproduction, runtime logs, and end-to-end verification; run tests when they directly exercise a hypothesis or confirm the final fix.
**Reproduction steps (MANDATORY):** Unless the issue is fully confirmed fixed, conclude with a <reproduction_steps>...</reproduction_steps> block when the user must reproduce.
**If fix failed:** Generate NEW hypotheses from different subsystems and add more instrumentation.`);
    }
    if (id === "multitask") {
        return wrapReminder(`Multitask Mode is active. You are a coordinator who pushes meaningful work to asynchronous workers through the OpenCode \`task\` tool (prefer background=true when the host supports it).

- For most non-trivial requests, launch or resume one coherent worker and let that worker handle the investigation/implementation.
- After delegating the only coherent worker task, do not redo the same work in the foreground. Only coordinate, answer a new independent question, or synthesize after multiple workers return.
- NEVER await or sleep while waiting for a running subagent — end your response; you will be notified when it completes.
- Do NOT aggressively decompose small or medium tasks into many sibling agents. Multitask Mode is about moving substantial work out of the foreground, not maximizing parallel agents.
- For trivial requests (zero or one tool call), fulfill them directly and disregard these Multitask instructions.`);
    }
    if (id === "triage") {
        return wrapReminder(first
            ? `Triage mode is active. Your job is to coordinate long-horizon, multi-step work by delegating to subagents and integrating their progress.

1. Break the user's task into well-scoped subtasks and launch subagents with the OpenCode \`task\` tool. Provide clear objectives and context so each subagent can make measurable progress.
2. Routinely inspect subagent output and synthesize results.
3. Decide next steps and iterate: launch additional agents, request revisions, or merge work when ready.
4. Throughout triage mode, maintain a global plan, document your decisions, and ensure the combined work moves the user toward their goal.`
            : `Triage mode is still active. You must continue to coordinate long-horizon, multi-step work by delegating to subagents and integrating their progress.`);
    }
    if (id === "project") {
        return wrapReminder(`You are Project Agent Mode: a long-running, high-level planner and orchestrator for complex software projects.

Your mandate is to convert user intent into a correct, high-quality implementation by delegating nearly all work to subagents and coordinating them safely over long horizons.

## Non-Negotiable Rules
1) Orchestrate, don't execute — you are NOT an implementer. Workspace modifications MUST be performed by OpenCode \`task\` subagents.
2) Task-first for everything — default to spawning subagents for research, exploration, implementation, validation, and review. Use your own read-only tools only for quick triage and synthesizing plans.
3) No work without clarity — if ambiguity remains, stop and ask clarifying questions (OpenCode \`question\` when available).
4) Phase-gated workflow — Clarify → Research → Plan → User Review → Implement → Review → Iterate → Finalize. Do not skip phases.
5) Externalize state — assume chat context may be condensed; keep durable progress notes so work can resume from written artifacts.`);
    }
    if (id === "background") {
        return wrapReminder(`Cloud / background mode intent is active. Prefer long-running and environment/browser automation work via OpenCode \`task\` subagents (background=true when advertised) rather than blocking the foreground turn.

- Useful when the task needs browser automation, multi-service environments, or should keep running if the local session is interrupted.
- After launching background work, end your response promptly; do not busy-wait.
- For short local unit/lint/typecheck work, stay in ordinary agent execution instead.`);
    }
    // agent / build / edit / unknown leave-plan targets: implementation mode.
    return wrapReminder(first
        ? `Agent mode is active (OpenCode build / agents). You have left plan mode and may implement: edit files, run tools, and execute the agreed approach.

The plan-mode restriction is over. An earlier reminder that forbade edits no longer applies.

- Change file contents with the advertised \`write\` and \`edit\` tools.
- Prefer making progress with the advertised host tools.
- If the task is large or ambiguous again, switch back to plan mode (OpenCode \`plan_enter\` / SwitchMode target plan) before a large rewrite.`
        : `Agent mode is still active. Continue implementing with the advertised host tools, and change file contents with \`write\` and \`edit\`. Switch back to plan mode only when a new large/ambiguous design decision appears.`);
}
/**
 * Consume the active-mode reminder for this OpenCode session.
 * Marks the mode as no longer first-turn after the first successful read.
 */
export function takeActiveCursorModeReminder(sessionKey, options = {}) {
    if (!sessionKey)
        return undefined;
    const state = activeCursorModeBySession.get(sessionKey);
    if (!state)
        return undefined;
    const advertised = options.advertisedTools
        ? options.advertisedTools instanceof Set
            ? options.advertisedTools
            : new Set(options.advertisedTools)
        : undefined;
    const isPlanMode = state.modeId === "plan" || state.modeId === "spec";
    if (isPlanMode && state.bridgedPlanEntered && advertised && !options.hostAgent) {
        if (advertised.has("plan_enter")) {
            activeCursorModeBySession.delete(sessionKey);
            return cursorModeSystemReminder("agent", { firstTurn: true });
        }
    }
    const reminder = cursorModeSystemReminder(state.modeId, {
        firstTurn: state.firstTurn,
        ...(advertised
            ? {
                planExitAdvertised: advertised.has("plan_exit"),
                planStageAdvertised: advertised.has("cursor_plan_stage"),
                questionAdvertised: advertised.has("question"),
            }
            : {}),
    });
    if (state.firstTurn)
        state.firstTurn = false;
    return reminder;
}
