import { type AskQuestionResultMessage, type DecodedAskQuestionQuery } from "./ask-question.js";
import { type DecodedGenerateImageQuery } from "./generate-image.js";
import { CURSOR_PLAN_STAGE_TOOL, type CreatePlanBridge, type DecodedCreatePlanQuery, createPlanApprovalQuestionInput } from "./create-plan.js";
import { type DecodedSwitchModeQuery, type SwitchModeBridge, type SwitchModeHostTool } from "./switch-mode.js";
export type InteractionQueryWireInfo = {
    id?: number;
    variantField?: number;
    variantName?: string;
    /** Raw bytes of the selected variant sub-message, when it is length-delimited. */
    variantBytes?: Uint8Array;
};
export type HandledInteraction = {
    id: number;
    variantField: number;
    variantName: string;
    outcome: "rejected" | "acknowledged" | "failed" | "bridged" | "approved";
    /** Decoded model call id, including refusals and lifecycle acknowledgments. */
    toolCallId?: string;
    /**
     * Immediate reply for this query. Absent for bridged *synchronous* AskQuestion
     * or SwitchMode: Cursor blocks until the host tool returns, exactly as its own
     * CLI does while the user is choosing / approving the mode switch.
     */
    reply?: Uint8Array;
    /** Present when `outcome === "bridged"`: the question set to hand OpenCode. */
    askQuestion?: DecodedAskQuestionQuery;
    /**
     * Present when SwitchMode should mutate session mode — bridged to a host
     * tool, or approved outright when entering plan mode needs none. Absent on
     * lifecycle soft-acks (`ack`): those reply `approved{}` without recording
     * a mode. The caller reads `bridge` to decide whether a tool call is emitted,
     * and `args.targetModeId` to record the active Cursor mode when present.
     */
    switchMode?: DecodedSwitchModeQuery & {
        bridge: SwitchModeBridge;
        toolName?: SwitchModeHostTool;
    };
    /**
     * Present when CreatePlan needs a host tool: a host plan-stage tool that
     * owns the write *and* the review, the host's `plan_exit` review of the
     * plan file the provider just wrote (`planUri` / `planPath` set), or the
     * emulated `question` prompt after that write.
     */
    createPlan?: DecodedCreatePlanQuery & {
        bridge: CreatePlanBridge;
        toolName: typeof CURSOR_PLAN_STAGE_TOOL | "plan_exit" | "question";
        planUri?: string;
        /** Filesystem path of the plan the provider just wrote. */
        planPath?: string;
        questionInput?: ReturnType<typeof createPlanApprovalQuestionInput>;
        /** The plan to show the user before the host review. */
        planReview?: string;
    };
    /**
     * Cursor tool call id of a CreatePlan the host plan agent will record
     * instead. Nothing was written, so its display must not be mirrored as a plan.
     */
    deferredCreatePlanToolCallId?: string;
    /** Present when an image generation was approved: the target to expect. */
    generateImage?: DecodedGenerateImageQuery;
};
export type HandleInteractionQueryOptions = {
    /**
     * True when the host advertises `question` on this turn and tool calls are
     * allowed, i.e. the provider can actually surface the prompt to the user.
     */
    canBridgeAskQuestion?: boolean;
    /**
     * True when tool calls are allowed this turn (needed before advertising can
     * be checked for plan_enter / plan_exit).
     */
    allowTools?: boolean;
    /**
     * Host tool names advertised this turn. Used to resolve SwitchMode →
     * plan_enter / plan_exit only when the matching tool is present.
     */
    advertisedTools?: ReadonlySet<string> | Iterable<string>;
    /**
     * True when `cursor_image_save` is advertised, i.e. a generated image can be
     * committed to disk under OpenCode's permission. Approving generation the
     * provider cannot then save would spend the user's Cursor quota for nothing.
     */
    canSaveGeneratedImage?: boolean;
    /**
     * Session workspace root used to place CreatePlan files via {@link hostPlansDir}
     * (host project-config `plans/` in a git worktree, else host global data/plans).
     */
    workspaceRoot?: string;
    /** True when the advertised host plan-stage tool is available. */
    canBridgeCreatePlan?: boolean;
    /** An approved switch into the host `plan` agent waits for this Run to end. */
    hostPlanEntryPending?: boolean;
    /** Host primary agent this Run executes under, when the host reported it. */
    hostAgent?: string;
    /** Provider-recorded Cursor plan/spec mode for the CreatePlan execution gate. */
    planModeActive?: boolean;
    /** The host's own plan file for this session, when the host defines one. */
    hostPlanFile?: string;
    /**
     * Cursor unified mode currently recorded for this session. A SwitchMode to
     * the mode already in effect needs no approval, matching Cursor's own IDE
     * handler and keeping the host's plan review from running twice.
     */
    activeCursorModeId?: string;
};
export declare class UnsupportedInteractionQueryError extends Error {
    constructor(info: InteractionQueryWireInfo);
}
/**
 * Inspect the raw wrapper as well as the decoded object. protobufjs drops
 * fields introduced by newer Cursor schemas; raw inspection lets us fail fast
 * instead of accidentally restoring the heartbeat-only deadlock.
 */
export declare function inspectInteractionQueryWire(agentServerPayload: Uint8Array): InteractionQueryWireInfo;
/**
 * Build the typed response required by Cursor's Run RPC.
 *
 * OpenCode has no Cursor UI callbacks, so UI-bound queries get a conservative
 * headless policy (reject; ack a few no-UI cases).
 *
 * Bridged / persisted exceptions:
 * - AskQuestion (#3) → OpenCode `question` tool
 * - SwitchMode (#4) → OpenCode `plan_enter` / `plan_exit` when advertised
 * - CreatePlan (#7) → the host's plan file (session `Session.plan` file when
 *   known, else a new file under hostPlansDir); empty args still get the CLI
 *   empty-`plan_uri` success ack
 * - GenerateImage (#12) → approve when `cursor_image_save` is advertised
 */
export declare function handleInteractionQuery(query: Record<string, unknown>, agentServerPayload: Uint8Array, options?: HandleInteractionQueryOptions): HandledInteraction;
/** `AgentClientMessage{interaction_response{ask_question_interaction_response}}`. */
export declare function buildAskQuestionInteractionReply(id: number, result: AskQuestionResultMessage): Uint8Array;
/** `AgentClientMessage{interaction_response{switch_mode_request_response}}`. */
export declare function buildSwitchModeInteractionReply(id: number, result: Record<string, unknown>): Uint8Array;
/** `AgentClientMessage{interaction_response{create_plan_request_response}}`. */
export declare function buildCreatePlanInteractionReply(id: number, result: Record<string, unknown>): Uint8Array;
/**
 * Deferred answers for a query already acknowledged with `async`.
 * `originalArgs` must be the server's own `AskQuestionArgs` bytes so Cursor can
 * correlate the completion with the tool call it raised.
 */
export declare function buildAsyncAskQuestionCompletion(originalToolCallId: string, originalArgs: Uint8Array, result: AskQuestionResultMessage): Uint8Array;
