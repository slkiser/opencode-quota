import { encodeMessage, getMessageTypes } from "./messages.js";
/**
 * Empty ConversationStateStructure for a Run without a checkpoint (turn 1,
 * compaction, rebase, reseed). After the first checkpoint arrives we stop
 * inventing state and echo the server's opaque structure instead (CLI behavior).
 *
 * Nothing goes in `root_prompt_messages_json` (#1). Neither Cursor client
 * writes it: Cursor checkpoints fill it with references to the conversation's
 * own rendered root prompt. A client-written entry stands in for that prompt,
 * so Cursor stops rendering RequestContext rules, skills and subagents — the
 * host system-instructions rule included. Verified live 2026-10-09
 * (claude-sonnet-5-5): two seeded history messages there gave checkpoint
 * categories `rules:0, subagents:0` and a reply that ignored the rule; the same
 * history in the user text kept both. History therefore travels in the user
 * text ({@link seedHistoryUserText}).
 *
 * We deliberately do NOT use `AgentRunRequest.custom_system_prompt` (#8): that
 * field is the internal `--system-prompt` CLI override and the server rejects
 * it for normal accounts.
 */
export function buildSeedConversationState() {
    const type = getMessageTypes().lookupType("ConversationStateStructure");
    return type.encode(type.fromObject({})).finish();
}
const SEED_HISTORY_TAGS = /<\/(conversation_history|user|assistant)>/gi;
/**
 * Prior turns of a Run without a checkpoint, as a transcript ahead of the live
 * user text. `system` entries are dropped: host system context travels as the
 * system-instructions rule in RequestContext. Closing tags inside a message are
 * escaped so a message cannot end its own block early.
 */
export function seedHistoryUserText(text, history) {
    const entries = (history ?? []).filter((entry) => entry.content && entry.role !== "system");
    if (entries.length === 0)
        return text;
    const transcript = entries
        .map((entry) => `<${entry.role}>\n${entry.content.replace(SEED_HISTORY_TAGS, "<\\/$1>")}\n</${entry.role}>`)
        .join("\n\n");
    return `<conversation_history>\n${transcript}\n</conversation_history>\n\n${text}`;
}
/**
 * Build an AgentClientMessage{run_request} for a conversation turn.
 *
 * Live `user_message.text` is the current prompt only — same as Cursor CLI.
 * Cross-turn history is the last server checkpoint re-sent as conversation_state.
 */
export function buildRunRequest(input) {
    const msgId = input.messageId ?? crypto.randomUUID();
    // Advertise host tools on UserMessageAction.request_context (#2) via slim
    // mcp_meta_tool_options. AgentRunRequest.mcp_tools (#4) stays empty on real
    // turns (CLI prewarm-only). Full defs are session.toolDescriptors + exec #36.
    const requestContext = input.requestContext;
    const seeded = !(input.conversationState && input.conversationState.length > 0);
    const userMessage = {
        text: seeded ? seedHistoryUserText(input.text, input.history) : input.text,
        message_id: msgId,
    };
    if (input.mode !== undefined)
        userMessage.mode = input.mode;
    if (input.images?.length) {
        userMessage.selected_context = {
            selected_images: input.images.map((image) => ({
                data: image.data,
                uuid: crypto.randomUUID(),
                path: image.filename,
                mime_type: image.mimeType,
            })),
        };
    }
    const userMessageAction = { user_message: userMessage };
    if (requestContext)
        userMessageAction.request_context = requestContext;
    const action = input.action === "resume"
        ? { resume_action: {} }
        : { user_message_action: userMessageAction };
    const conversationState = seeded
        ? buildSeedConversationState()
        : input.conversationState;
    const runRequest = {
        conversation_id: input.conversationId,
        conversation_group_id: input.conversationGroupId ?? input.conversationId,
        run_id: msgId,
        action,
        requested_model: {
            // The provider always selects a concrete model. Cursor's "default"
            // pseudo-model (Auto) is never used here — we send the real id plus the
            // chosen variant's parameter values.
            model_id: input.modelId,
            max_mode: input.maxMode ?? false,
            parameters: input.parameterValues ?? [],
        },
        conversation_state: conversationState,
        mcp_tools: { mcp_tools: [] },
        unknown_flag: 0,
        field_12: 0,
    };
    return encodeMessage("AgentClientMessage", {
        run_request: runRequest,
    });
}
/**
 * Build a heartbeat message.
 */
export function buildHeartbeat() {
    return encodeMessage("AgentClientMessage", {
        client_heartbeat: {},
    });
}
/**
 * ACM #5 `exec_client_control_message.heartbeat{id}`: Cursor CLI sends it every
 * 3 s for each exec it is still running, keyed by the exec message id. The CLI
 * leaves a zero id out, as proto3 does for a default scalar; protobufjs would
 * write it explicitly, so it is omitted here to send the CLI's exact bytes.
 */
export function buildExecHeartbeat(execId) {
    return encodeMessage("AgentClientMessage", {
        exec_client_control_message: { heartbeat: execId === 0 ? {} : { id: execId } },
    });
}
/** Stops the live Run, as Cursor CLI does on a user Stop before it closes the stream. */
export function buildCancelAction(reason) {
    return encodeMessage("AgentClientMessage", {
        conversation_action: { cancel_action: { reason } },
    });
}
