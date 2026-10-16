import type { OpencodeToolDef } from "./tools.js";
import type { CursorImageInput } from "../image-input.js";
export type SeedHistoryMessage = {
    role: "system" | "user" | "assistant";
    content: string;
};
export type RunRequestInput = {
    text: string;
    images?: CursorImageInput[];
    modelId: string;
    conversationId: string;
    /** Stable parent group; unlike conversationId, this survives compaction/rebase. */
    conversationGroupId?: string;
    /**
     * Prior chat turns for a seed ConversationStateStructure (no checkpoint).
     * Tool outputs, when required for compaction/recovery, are represented as
     * user-role OpenCode host observations rather than assistant-authored prose.
     */
    history?: SeedHistoryMessage[];
    /**
     * Opaque ConversationStateStructure bytes from the last
     * conversation_checkpoint_update for this conversation_id. When set, echoed
     * as AgentRunRequest.conversation_state (CLI parity). When absent, a seed
     * state carrying only `history` (or empty) is built for turn 1.
     */
    conversationState?: Uint8Array;
    parameterValues?: Array<{
        id: string;
        value: string;
    }>;
    maxMode?: boolean;
    messageId?: string;
    tools?: OpencodeToolDef[];
    /** Pre-resolved descriptors (including config-backed MCP server identity). */
    toolDescriptors?: Array<Record<string, unknown>>;
    /** Prebuilt RequestContext (OpenCode-sourced). */
    requestContext?: Record<string, unknown>;
    /** Resume the supplied checkpoint instead of submitting another user turn. */
    action?: "user" | "resume";
    /**
     * Cursor mode of this user turn (`UserMessage.mode`, an `agent.v1.AgentMode`
     * value). Cursor CLI sends its current mode on every user message.
     */
    mode?: number;
};
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
export declare function buildSeedConversationState(input?: {
    history?: SeedHistoryMessage[];
}): Uint8Array;
/**
 * Build an AgentClientMessage{run_request} for a conversation turn.
 *
 * Live `user_message.text` is the current prompt only — same as Cursor CLI.
 * Cross-turn history is the last server checkpoint re-sent as conversation_state.
 */
export declare function buildRunRequest(input: RunRequestInput): Uint8Array;
/**
 * Build a heartbeat message.
 */
export declare function buildHeartbeat(): Uint8Array;
