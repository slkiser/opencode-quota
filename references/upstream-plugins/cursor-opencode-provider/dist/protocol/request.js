import { encodeMessage, getMessageTypes } from "./messages.js";
/**
 * Seed ConversationStateStructure for the first turn (no checkpoint yet).
 *
 * After the first checkpoint arrives we stop inventing state and echo the
 * server's opaque structure instead (CLI behavior). Compaction resets and
 * rebases also use this seed, with `history` carrying OpenCode's prompt turns
 * so Cursor can continue without the old checkpoint.
 *
 * No `system` entry is seeded: Cursor does not follow a client-authored
 * `system` root message, and neither Cursor client writes
 * `root_prompt_messages_json`. Host system context travels as the
 * system-instructions rule in RequestContext (`systemInstructionsRule`), so
 * `system` history entries are dropped here rather than duplicated.
 *
 * We deliberately do NOT use `AgentRunRequest.custom_system_prompt` (#8): that
 * field is the internal `--system-prompt` CLI override and the server rejects
 * it for normal accounts.
 */
export function buildSeedConversationState(input) {
    const root = getMessageTypes();
    const type = root.lookupType("ConversationStateStructure");
    const messages = [];
    for (const entry of input?.history ?? []) {
        if (!entry.content || entry.role === "system")
            continue;
        messages.push(JSON.stringify({ role: entry.role, content: entry.content }));
    }
    const obj = {};
    if (messages.length > 0)
        obj.root_prompt_messages_json = messages;
    return type.encode(type.fromObject(obj)).finish();
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
    const userMessage = {
        text: input.text,
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
    const conversationState = input.conversationState && input.conversationState.length > 0
        ? input.conversationState
        : buildSeedConversationState({ history: input.history });
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
