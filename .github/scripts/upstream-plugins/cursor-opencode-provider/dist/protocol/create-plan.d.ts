/**
 * Cursor-native CreatePlan → host-default plan file.
 *
 * Cursor raises `create_plan_request_query` (#7) with CreatePlanArgs and expects
 * a CreatePlanResult carrying `plan_uri`. Cursor CLI writes under
 * `~/.cursor/plans/*.plan.md` with YAML frontmatter; this provider deliberately
 * does **not** — plans must stay host-portable so switching models does not
 * strand users on Cursor-specific paths or frontmatter.
 *
 * Location is the host's own: the session plan file when the host defines one
 * (`hostPlanFilePath`, OpenCode 1.x `Session.plan`), otherwise a new
 * `<created>-<slug>.md` under {@link hostPlansDir} (OpenCode 2.0's Plan
 * directory, OpenCode 1.x `<data>/plans`, or an installed path bridge).
 *
 * Body is plain markdown (the same shape a plan-mode model would write with
 * `write`). Cursor YAML frontmatter is never emitted.
 *
 * Native CreatePlan persistence goes through an advertised host `write` or
 * patch tool — never a direct filesystem write from this module. File
 * permission prompts authorize that save; execution review is a later step.
 */
import { type HostPatchTool } from "./apply-patch.js";
import { type OpencodeQuestionInput } from "./ask-question.js";
import type { HostFilePathKey } from "./tools.js";
export type CursorPlanTodo = {
    id: string;
    content: string;
    status: string;
};
export type CursorCreatePlanArgs = {
    plan: string;
    overview: string;
    name: string;
    isProject: boolean;
    todos: CursorPlanTodo[];
};
export type DecodedCreatePlanQuery = {
    args: CursorCreatePlanArgs;
    toolCallId: string;
};
export type CreatePlanWriteResult = {
    ok: true;
    planPath: string;
    planUri: string;
    markdown: string;
} | {
    ok: false;
    error: string;
};
/** Prepared plan content and destination — no filesystem mutation. */
export type PreparedCreatePlanFile = CreatePlanWriteResult;
/** Optional host plan-stage tool advertised by a compatible host. */
export declare const CURSOR_PLAN_STAGE_TOOL = "cursor_plan_stage";
/** Held InteractionQuery continuation field for CreatePlan write and review. */
export declare const CREATE_PLAN_RESULT_FIELD = "create_plan_request_response";
/** Internal CreatePlan continuation phase stored on pending metadata. */
export type CreatePlanContinuationPhase = "write" | "review";
/** After a successful host plan write, what the provider does next. */
export type CreatePlanAfterWrite = {
    kind: "review";
    toolName: "plan_exit" | "question";
} | {
    kind: "ack";
} | {
    kind: "hold";
};
export type PlanPersistenceRoute = {
    kind: "write";
    toolName: "write";
    filePathKey: HostFilePathKey;
} | {
    kind: "patch";
    toolName: HostPatchTool;
} | {
    kind: "unsupported";
    error: string;
};
export type PlanPersistenceCall = {
    ok: true;
    toolName: "write" | HostPatchTool;
    input: Record<string, unknown>;
} | {
    ok: false;
    error: string;
};
export type CursorPlanStageInput = {
    plan_uri: string;
    content: string;
    title: string;
};
/**
 * How a CreatePlan query is satisfied this turn. Keyed only on the advertised
 * catalog and the provider's own plan-mode state — never on host identity.
 *
 * - `stage`   a host plan-stage tool is advertised; the host writes the plan.
 *             Its tool result is the approval outcome (success = approved,
 *             error = not approved). The result may name the host's own
 *             follow-up approval call. This provider does not invent that prompt.
 * - `ack`     nothing to ask with (or a lifecycle turn / CreatePlan outside
 *             plan mode): persist through a host file tool, or for a lifecycle
 *             turn skip the write, and acknowledge the CLI way.
 * - `approve` plan mode is active and the host advertises `question` but not
 *             a plan review tool: persist through a host file tool, then ask
 *             with upstream `PlanExitTool`'s own prompt (OpenCode 1.x / 2.0
 *             without `plan_exit`). Explicit "Yes" is execution approval.
 * - `exit`    the host's `plan` agent is active, advertises `plan_exit`, and
 *             its own plan file is known: persist there through a host file
 *             tool and run the host `plan_exit` review. The host owns approval
 *             and execution; the turn that carries the result leaves `plan`
 *             only on approval.
 * - `defer`   the host's `plan` agent owns planning but CreatePlan cannot be
 *             carried out yet: an approved switch into it is still pending (it
 *             applies after this Run), or its plan file is unknown. Nothing is
 *             written; the error tells the model which host workflow follows.
 * - `hold`    the session's edit rule still denies edits. The plan is persisted
 *             through a host file tool and shown, and Cursor receives the
 *             not-approved error. Nothing asks the user or switches agents: an
 *             answer cannot lift the rule. Host file permission may still ask
 *             while saving; that authorizes the file operation only.
 *
 * Persistence precedes any execution review: saving needs no implementation
 * approval, executing does, and only the host asks for that.
 */
export type CreatePlanBridge = {
    kind: "stage";
} | {
    kind: "ack";
} | {
    kind: "approve";
} | {
    kind: "hold";
} | {
    kind: "defer";
    reason: string;
} | {
    kind: "exit";
    planPath: string;
};
/** CreatePlan raised before an approved switch into the host plan agent took effect. */
export declare const CREATE_PLAN_HOST_PLAN_PENDING_REASON: string;
/** CreatePlan raised while the host's own plan agent owns the plan file and its review. */
export declare const CREATE_PLAN_HOST_PLAN_WORKFLOW_REASON: string;
/**
 * Cursor-visible reason when the user picks No or dismisses the approval
 * prompt. Ends the owning turn; a new user message is required before more work.
 */
export declare const CREATE_PLAN_NOT_APPROVED_REASON: string;
/**
 * Cursor-visible reason when the user typed freeform feedback instead of Yes/No.
 * The owning turn continues in plan mode so the model can revise.
 */
export declare function createPlanRefineReason(feedback: string): string;
/** Cursor-visible reason when a session edit deny still blocks execution. */
export declare function createPlanSessionEditsDeniedReason(planPath: string): string;
/** Upstream `PlanExitTool` wording, with the plan the provider just wrote. */
export declare function createPlanApprovalQuestion(planLabel: string): string;
export declare const CREATE_PLAN_APPROVAL_HEADER = "Build Agent";
/** Resolve how this CreatePlan is satisfied (see {@link CreatePlanBridge}). */
export declare function resolveCreatePlanBridge(options: {
    allowTools: boolean;
    canStage?: boolean;
    advertised: ReadonlySet<string> | Iterable<string>;
    /** An approved switch into the host `plan` agent waits for this Run to end. */
    hostPlanEntryPending?: boolean;
    /** Host primary agent of this Run, when the host reported it. */
    hostAgent?: string;
    /** Provider-recorded Cursor plan/spec mode (the gate out of planning). */
    planModeActive?: boolean;
    /** The host's own plan file for this session, when the host defines one. */
    hostPlanFile?: string;
    /**
     * The session's last `edit` rule on `*` is deny. An approval cannot lift it,
     * so the plan is saved through a host file tool without asking to implement
     * or switching agents. Host file permission may still prompt for that save.
     */
    sessionEditsDenied?: boolean;
}): CreatePlanBridge;
/** Host `question` input mirroring upstream `PlanExitTool`'s own prompt. */
export declare function createPlanApprovalQuestionInput(planLabel: string): OpencodeQuestionInput;
/**
 * How the emulated CreatePlan `question` approval resolved.
 *
 * - `approved` — explicit Yes: leave plan and start implementing.
 * - `declined` — No, unanswered, dismissed, failed, or bare "Other": end the
 *   owning turn and keep the plan agent.
 * - `refine` — the user typed freeform feedback: continue this turn in plan
 *   mode and send that text back through the CreatePlan reply.
 */
export type CreatePlanApprovalOutcome = {
    kind: "approved";
} | {
    kind: "declined";
} | {
    kind: "refine";
    feedback: string;
};
/** Classify an emulated CreatePlan approval `question` result. */
export declare function createPlanApprovalOutcome(output: string, isError: boolean, question: string): CreatePlanApprovalOutcome;
/**
 * True when the emulated approval prompt came back as an explicit "Yes".
 * An unanswered, dismissed, failed, No, or freeform prompt is not approval.
 */
export declare function createPlanApproved(output: string, isError: boolean, question: string): boolean;
/** Decode a `create_plan_request_query` body, or undefined when unusable. */
export declare function decodeCreatePlanQuery(queryBytes: Uint8Array): DecodedCreatePlanQuery | undefined;
/** OpenCode-style adjective-noun slug (core/src/util/slug.ts). */
export declare function randomPlanSlug(seed?: number): string;
/** Slugify a human title into a filesystem-safe token. */
export declare function slugifyPlanName(name: string): string;
/** Build the advertised host plan-stage artifact payload. */
export declare function createPlanStageInput(args: CursorCreatePlanArgs): CursorPlanStageInput;
/**
 * Resolve the absolute plan file path via {@link hostPlansDir}.
 * Filename shape matches OpenCode Session.plan: `<created>-<slug>.md`.
 */
export declare function resolveHostPlanPath(workspaceRoot: string, name?: string, created?: number): string;
/** @deprecated Prefer {@link resolveHostPlanPath}. */
export declare const resolveOpencodePlanPath: typeof resolveHostPlanPath;
/**
 * Render plain markdown for the plan file. No Cursor YAML frontmatter.
 * Prefer `args.plan` as the body; prepend a title/overview when useful; append
 * a markdown checklist for todos.
 */
export declare function renderOpencodePlanMarkdown(args: CursorCreatePlanArgs): string;
/**
 * Resolve plan destination and markdown without touching the filesystem.
 * Empty / missing content is the caller's responsibility (empty plan_uri ack).
 */
export declare function prepareCreatePlanFile(args: CursorCreatePlanArgs, workspaceRoot: string, created?: number, 
/** Exact host-owned plan file; default is a new file under {@link hostPlansDir}. */
target?: string): PreparedCreatePlanFile;
/**
 * Prefer an advertised `write`, otherwise a host patch tool. Never invent a
 * binary or shell fallback when neither is available.
 */
export declare function resolvePlanPersistence(advertised: ReadonlySet<string> | Iterable<string>, filePathKey?: HostFilePathKey): PlanPersistenceRoute;
/** Build the host write or Add File patch call for a prepared plan. */
export declare function buildPlanPersistenceCall(route: Exclude<PlanPersistenceRoute, {
    kind: "unsupported";
}>, planPath: string, markdown: string): PlanPersistenceCall;
/**
 * Test helper: prepare then write the plan under {@link hostPlansDir}.
 * Production CreatePlan paths must use a host file tool instead.
 */
export declare function writeOpencodePlanFile(args: CursorCreatePlanArgs, workspaceRoot: string, created?: number, 
/** Exact host-owned plan file; default is a new file under {@link hostPlansDir}. */
target?: string): CreatePlanWriteResult;
/**
 * The plan as the user reads it before approving execution.
 *
 * Cursor routes the plan body through the interaction query rather than the
 * text stream, so without this the user is asked to approve a plan they were
 * never shown. It goes into the assistant message — the host renders markdown
 * there, it scrolls, and it survives answering the prompt. It must not go into
 * the question itself: OpenCode renders the question dock outside its
 * scrollbox with `flexShrink={0}`, so a full plan there would push the
 * conversation off screen.
 */
export declare function renderPlanReviewMessage(markdown: string, planPath: string): string;
