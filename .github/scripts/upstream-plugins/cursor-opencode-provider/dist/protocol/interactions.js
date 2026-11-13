import { encodeMessage } from "./messages.js";
import { readAllFields } from "./struct.js";
import { SESSION_PERMISSIONS_UNAVAILABLE_REASON } from "./session-edits.js";
import { decodeAskQuestionQuery, MISSING_ARGS_REASON, MISSING_QUERY_REASON, } from "./ask-question.js";
import { decodeGenerateImageQuery, } from "./generate-image.js";
import { CURSOR_PLAN_STAGE_TOOL, buildPlanPersistenceCall, createPlanApprovalQuestionInput, decodeCreatePlanQuery, prepareCreatePlanFile, renderPlanReviewMessage, resolveCreatePlanBridge, resolvePlanPersistence, } from "./create-plan.js";
import { decodeSwitchModeQuery, MISSING_ARGS_REASON as SWITCH_MODE_MISSING_ARGS_REASON, MISSING_QUERY_REASON as SWITCH_MODE_MISSING_QUERY_REASON, resolveSwitchModeBridge, switchModeApprovedResult, SESSION_EDITS_DENIED_SWITCH_REASON, } from "./switch-mode.js";
const HEADLESS_REASON = "This Cursor interaction requires UI approval and is not available through the OpenCode provider.";
/**
 * Rejection used when AskQuestion cannot be bridged because the current
 * OpenCode agent does not advertise `question` (subagents deny it by default,
 * and compaction turns advertise no tools at all). Naming the actual reason
 * keeps the model from concluding that asking is impossible in general.
 */
const ASK_QUESTION_UNAVAILABLE_REASON = "The OpenCode `question` tool is not available to the current agent, so questions "
    + "cannot be shown to the user this turn. State the question in your reply instead.";
const variantNames = {
    2: "web_search_request_query",
    3: "ask_question_interaction_query",
    4: "switch_mode_request_query",
    7: "create_plan_request_query",
    8: "setup_vm_environment_args",
    9: "web_fetch_request_query",
    10: "pr_management_request_query",
    11: "mcp_auth_request_query",
    12: "generate_image_request_query",
    13: "replace_env_args",
    14: "connect_scm_request_query",
};
export class UnsupportedInteractionQueryError extends Error {
    constructor(info) {
        const variant = info.variantField === undefined
            ? "missing variant"
            : `unsupported variant field #${info.variantField}`;
        const id = info.id === undefined ? "missing id" : `id=${info.id}`;
        super(`Cursor interaction query cannot be handled (${id}, ${variant})`);
        this.name = "UnsupportedInteractionQueryError";
    }
}
/**
 * Inspect the raw wrapper as well as the decoded object. protobufjs drops
 * fields introduced by newer Cursor schemas; raw inspection lets us fail fast
 * instead of accidentally restoring the heartbeat-only deadlock.
 */
export function inspectInteractionQueryWire(agentServerPayload) {
    const queryBytes = readAllFields(agentServerPayload)
        .find((field) => field.fn === 7 && field.wt === 2)?.bytes;
    if (!queryBytes)
        return {};
    // InteractionQuery.id is a proto3 uint32. Cursor commonly uses id=0, whose
    // default scalar value is omitted from the wire; absence therefore means
    // zero, not a malformed/missing correlation id.
    let id = 0;
    let variantField;
    let variantBytes;
    for (const field of readAllFields(queryBytes)) {
        if (field.fn === 1 && field.wt === 0)
            id = field.varint;
        else if (field.wt === 2 && variantField === undefined) {
            variantField = field.fn;
            variantBytes = field.bytes;
        }
    }
    return {
        id,
        variantField,
        variantName: variantField === undefined ? undefined : variantNames[variantField],
        variantBytes,
    };
}
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
export function handleInteractionQuery(query, agentServerPayload, options = {}) {
    const info = inspectInteractionQueryWire(agentServerPayload);
    if (info.id === undefined || info.variantField === undefined || !info.variantName) {
        throw new UnsupportedInteractionQueryError(info);
    }
    if (typeof query.id === "number" && query.id !== info.id) {
        throw new Error(`Cursor interaction query id mismatch: decoded=${query.id} wire=${info.id}`);
    }
    if (info.variantField === 3) {
        return handleAskQuestionQuery(info.id, info.variantBytes, options);
    }
    if (info.variantField === 4) {
        return handleSwitchModeQuery(info.id, info.variantBytes, options);
    }
    if (info.variantField === 7) {
        return handleCreatePlanQuery(info.id, info.variantBytes, options);
    }
    if (info.variantField === 12) {
        return handleGenerateImageQuery(info.id, info.variantBytes, options);
    }
    let response;
    let outcome;
    switch (info.variantField) {
        case 2:
            response = { web_search_request_response: { rejected: { reason: HEADLESS_REASON } } };
            outcome = "rejected";
            break;
        case 8:
            // OpenCode owns the local environment; there is no Cursor VM to create.
            response = { setup_vm_environment_result: { success: {} } };
            outcome = "acknowledged";
            break;
        case 9:
            response = { web_fetch_request_response: { rejected: { reason: HEADLESS_REASON } } };
            outcome = "rejected";
            break;
        case 10:
            response = { pr_management_result: { rejected: { reason: HEADLESS_REASON } } };
            outcome = "rejected";
            break;
        case 11:
            response = { mcp_auth_request_response: { rejected: { reason: HEADLESS_REASON } } };
            outcome = "rejected";
            break;
        case 13:
            response = {
                replace_env_result: {
                    failure: {
                        error_message: "Environment replacement is not supported by the OpenCode provider.",
                        setup_logs: "",
                    },
                },
            };
            outcome = "failed";
            break;
        case 14:
            response = { connect_scm_request_response: { rejected: { reason: HEADLESS_REASON } } };
            outcome = "rejected";
            break;
        default:
            throw new UnsupportedInteractionQueryError(info);
    }
    return {
        id: info.id,
        variantField: info.variantField,
        variantName: info.variantName,
        outcome,
        reply: encodeMessage("AgentClientMessage", {
            interaction_response: { id: info.id, ...response },
        }),
    };
}
/**
 * AskQuestion is the one interaction OpenCode can genuinely satisfy, so it is
 * translated instead of refused. Cursor CLI's own handler is mirrored: reject
 * a malformed query, answer `async` immediately when the server asked for a
 * non-blocking prompt, and otherwise hold the query open until the user picks.
 */
function handleAskQuestionQuery(id, variantBytes, options) {
    const base = { id, variantField: 3, variantName: "ask_question_interaction_query", toolCallId: undefined };
    const reject = (reason) => ({
        ...base,
        outcome: "rejected",
        reply: buildAskQuestionInteractionReply(id, { rejected: { reason } }),
    });
    if (!variantBytes)
        return reject(MISSING_QUERY_REASON);
    const decoded = decodeAskQuestionQuery(variantBytes);
    if (!decoded)
        return reject(MISSING_ARGS_REASON);
    base.toolCallId = decoded.toolCallId;
    if (!options.canBridgeAskQuestion)
        return reject(ASK_QUESTION_UNAVAILABLE_REASON);
    return {
        ...base,
        outcome: "bridged",
        askQuestion: decoded,
        // Async queries are unblocked now and answered later through a
        // ConversationAction; synchronous ones keep Cursor waiting, which is what
        // its CLI does while the user is still choosing.
        reply: decoded.args.runAsync
            ? buildAskQuestionInteractionReply(id, { async: {} })
            : undefined,
    };
}
/** `AgentClientMessage{interaction_response{ask_question_interaction_response}}`. */
export function buildAskQuestionInteractionReply(id, result) {
    return encodeMessage("AgentClientMessage", {
        interaction_response: {
            id,
            ask_question_interaction_response: { result },
        },
    });
}
/**
 * SwitchMode is bridged to OpenCode `plan_enter` / `plan_exit` when advertised.
 * Cursor CLI blocks until the user approves or rejects; we hold the query open
 * until the host tool returns, then reply approved{} or rejected{reason}.
 */
function handleSwitchModeQuery(id, variantBytes, options) {
    const base = { id, variantField: 4, variantName: "switch_mode_request_query", toolCallId: undefined };
    const reject = (reason) => ({
        ...base,
        outcome: "rejected",
        reply: buildSwitchModeInteractionReply(id, { rejected: { reason } }),
    });
    if (!variantBytes)
        return reject(SWITCH_MODE_MISSING_QUERY_REASON);
    const decoded = decodeSwitchModeQuery(variantBytes);
    if (!decoded)
        return reject(SWITCH_MODE_MISSING_ARGS_REASON);
    base.toolCallId = decoded.toolCallId;
    const bridge = resolveSwitchModeBridge(decoded.args.targetModeId, {
        allowTools: options.allowTools === true,
        advertised: options.advertisedTools ?? [],
        ...(options.activeCursorModeId ? { activeModeId: options.activeCursorModeId } : {}),
        ...(options.hostAgent ? { hostAgent: options.hostAgent } : {}),
        ...(options.sessionEditsDenied ? { sessionEditsDenied: true } : {}),
        sessionPermissionsUnavailable: options.sessionPermissionsUnavailable,
    });
    if (bridge.kind === "reject")
        return {
            ...reject(bridge.reason),
            ...([SESSION_PERMISSIONS_UNAVAILABLE_REASON, SESSION_EDITS_DENIED_SWITCH_REASON].includes(bridge.reason)
                ? { endTurn: true } : {}),
        };
    // Lifecycle turn: approve on the wire so the model never sees a rejection, but
    // do not attach switchMode — the real turn owns session mode.
    if (bridge.kind === "ack") {
        return {
            ...base,
            outcome: "acknowledged",
            reply: buildSwitchModeInteractionReply(id, switchModeApprovedResult()),
        };
    }
    if (bridge.kind === "approve") {
        // Entering plan mode needs no host tool, so Cursor is released at once and
        // the caller records the mode for the reminder injected on later Runs.
        return {
            ...base,
            outcome: "approved",
            switchMode: { ...decoded, bridge },
            reply: buildSwitchModeInteractionReply(id, switchModeApprovedResult()),
        };
    }
    return {
        ...base,
        outcome: "bridged",
        switchMode: {
            ...decoded,
            bridge,
            toolName: bridge.toolName,
        },
        // Keep Cursor waiting until the host plan tool returns: the host owns the
        // mode-switch approval.
        reply: undefined,
    };
}
/** `AgentClientMessage{interaction_response{switch_mode_request_response}}`. */
export function buildSwitchModeInteractionReply(id, result) {
    return encodeMessage("AgentClientMessage", {
        interaction_response: {
            id,
            switch_mode_request_response: result,
        },
    });
}
/** `AgentClientMessage{interaction_response{create_plan_request_response}}`. */
export function buildCreatePlanInteractionReply(id, result) {
    return encodeMessage("AgentClientMessage", {
        interaction_response: {
            id,
            create_plan_request_response: { result },
        },
    });
}
/**
 * Deferred answers for a query already acknowledged with `async`.
 * `originalArgs` must be the server's own `AskQuestionArgs` bytes so Cursor can
 * correlate the completion with the tool call it raised.
 */
export function buildAsyncAskQuestionCompletion(originalToolCallId, originalArgs, result) {
    return encodeMessage("AgentClientMessage", {
        conversation_action: {
            async_ask_question_completion_action: {
                original_tool_call_id: originalToolCallId,
                original_args: originalArgs,
                result,
            },
        },
    });
}
/**
 * CreatePlan persistence and execution approval. Cursor CLI writes
 * `~/.cursor/plans/*.plan.md` with YAML frontmatter; this provider writes plain
 * markdown under the host's calculated plans dir (`hostPlansDir` / path bridge)
 * so switching models and hosts stays coherent. Empty / missing args keep the
 * CLI empty-`plan_uri` success ack (nothing to write).
 *
 * Host permission may ask to save the plan. Execution review is a separate
 * step resolved from the advertised catalog by {@link resolveCreatePlanBridge}.
 * Review success approves execution; an acknowledgment outside plan mode only
 * confirms persistence. A failed or declined review never approves execution.
 */
function handleCreatePlanQuery(id, variantBytes, options) {
    const base = { id, variantField: 7, variantName: "create_plan_request_query", toolCallId: undefined };
    const reply = (result) => ({
        ...base,
        outcome: result.error ? "failed" : "acknowledged",
        reply: encodeMessage("AgentClientMessage", {
            interaction_response: {
                id,
                create_plan_request_response: { result },
            },
        }),
    });
    // Missing / empty args: CLI headless fallback — success with empty plan_uri.
    if (!variantBytes)
        return reply({ success: {}, plan_uri: "" });
    const decoded = decodeCreatePlanQuery(variantBytes);
    if (!decoded)
        return reply({ success: {}, plan_uri: "" });
    base.toolCallId = decoded.toolCallId;
    const bridge = resolveCreatePlanBridge({
        allowTools: options.allowTools === true,
        canStage: options.canBridgeCreatePlan === true,
        advertised: options.advertisedTools ?? [],
        hostPlanEntryPending: options.hostPlanEntryPending === true,
        ...(options.hostAgent ? { hostAgent: options.hostAgent } : {}),
        planModeActive: options.planModeActive === true,
        ...(options.hostPlanFile ? { hostPlanFile: options.hostPlanFile } : {}),
        ...(options.sessionEditsDenied ? { sessionEditsDenied: true } : {}),
    });
    // The host's plan agent records and reviews the plan; write nothing here.
    if (bridge.kind === "defer") {
        return {
            ...reply({ error: { error: bridge.reason }, plan_uri: "" }),
            ...(decoded.toolCallId ? { deferredCreatePlanToolCallId: decoded.toolCallId } : {}),
        };
    }
    if (options.allowTools && options.sessionPermissionsUnavailable) {
        return {
            ...reply({ error: { error: SESSION_PERMISSIONS_UNAVAILABLE_REASON }, plan_uri: "" }),
            endTurn: true,
        };
    }
    // The host plan-stage tool owns the write and the review together.
    if (bridge.kind === "stage") {
        return {
            ...base,
            outcome: "bridged",
            createPlan: { ...decoded, bridge, toolName: CURSOR_PLAN_STAGE_TOOL },
            reply: undefined,
        };
    }
    // A lifecycle turn (title generation, compaction) runs alongside the real one
    // and would otherwise persist a second, throwaway plan file for the same
    // request. Ack it the CLI way instead of emitting a host write.
    if (options.allowTools !== true)
        return reply({ success: {}, plan_uri: "" });
    const workspaceRoot = options.workspaceRoot?.trim();
    if (!workspaceRoot) {
        const result = {
            error: { error: "CreatePlan requires a workspace root to write the plan file" },
            plan_uri: "",
        };
        return bridge.kind === "hold" ? { ...reply(result), endTurn: true } : reply(result);
    }
    const planTarget = bridge.kind === "exit" ? bridge.planPath : options.hostPlanFile;
    const prepared = prepareCreatePlanFile(decoded.args, workspaceRoot, Date.now(), planTarget);
    if (!prepared.ok) {
        const result = { error: { error: prepared.error }, plan_uri: "" };
        return bridge.kind === "hold" ? { ...reply(result), endTurn: true } : reply(result);
    }
    const route = resolvePlanPersistence(options.advertisedTools ?? [], options.hostFilePathKey ?? "filePath");
    if (route.kind === "unsupported") {
        const result = { error: { error: route.error }, plan_uri: "" };
        return bridge.kind === "hold" ? { ...reply(result), endTurn: true } : reply(result);
    }
    const persistence = buildPlanPersistenceCall(route, prepared.planPath, prepared.markdown);
    if (!persistence.ok) {
        const result = { error: { error: persistence.error }, plan_uri: "" };
        return bridge.kind === "hold" ? { ...reply(result), endTurn: true } : reply(result);
    }
    const afterWrite = bridge.kind === "exit" ? { kind: "review", toolName: "plan_exit" }
        : bridge.kind === "approve" ? { kind: "review", toolName: "question" }
            : bridge.kind === "hold" ? { kind: "hold" }
                : { kind: "ack" };
    return {
        ...base,
        outcome: "bridged",
        createPlan: {
            ...decoded,
            bridge,
            toolName: persistence.toolName,
            planUri: prepared.planUri,
            planPath: prepared.planPath,
            markdown: prepared.markdown,
            planReview: renderPlanReviewMessage(prepared.markdown, prepared.planPath),
            ...(afterWrite.kind === "review"
                ? {
                    questionInput: afterWrite.toolName === "question"
                        ? createPlanApprovalQuestionInput(prepared.planPath)
                        : undefined,
                }
                : {}),
            persistence: {
                toolName: persistence.toolName,
                input: persistence.input,
                afterWrite,
            },
        },
        reply: undefined,
    };
}
/**
 * GenerateImage approval. Cursor renders its own confirmation in the CLI; here
 * the meaningful gate is OpenCode's `edit` permission raised by
 * `cursor_image_save` when the finished bytes are written, so generation itself
 * is approved whenever the provider can actually commit the result. Approving
 * without a commit path would spend Cursor quota on an image that then has
 * nowhere to go.
 */
function handleGenerateImageQuery(id, variantBytes, options) {
    const base = { id, variantField: 12, variantName: "generate_image_request_query", toolCallId: undefined };
    const reject = (reason) => ({
        ...base,
        outcome: "rejected",
        reply: encodeMessage("AgentClientMessage", {
            interaction_response: { id, generate_image_request_response: { rejected: { reason } } },
        }),
    });
    if (!variantBytes)
        return reject("Missing generate image query");
    const decoded = decodeGenerateImageQuery(variantBytes);
    if (!decoded)
        return reject("Missing generate image arguments");
    base.toolCallId = decoded.toolCallId;
    if (!options.canSaveGeneratedImage) {
        return reject("This OpenCode agent cannot save a generated image, so generating one would "
            + "produce nothing. Describe the image in your reply instead.");
    }
    return {
        ...base,
        outcome: "acknowledged",
        generateImage: decoded,
        reply: encodeMessage("AgentClientMessage", {
            interaction_response: {
                id,
                // Cursor's CLI returns the description the user may have edited at the
                // prompt. There is no text field on OpenCode's permission, so the
                // model's own description is passed through unchanged.
                generate_image_request_response: { approved: { description: decoded.description } },
            },
        }),
    };
}
