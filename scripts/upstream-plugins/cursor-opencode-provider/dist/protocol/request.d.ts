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
     * Prior chat turns for a Run without a checkpoint, carried in the live user
     * text (see {@link seedHistoryUserText}). Tool outputs, when required for
     * compaction/recovery, are represented as user-role OpenCode host
     * observations rather than assistant-authored prose.
     */
    history?: SeedHistoryMessage[];
    /**
     * Opaque ConversationStateStructure bytes from the last
     * conversation_checkpoint_update for this conversation_id. When set, echoed
     * as AgentRunRequest.conversation_state (CLI parity). When absent, an empty
     * seed state is sent and `history` travels in the user text.
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
export declare function buildSeedConversationState(): Uint8Array;
/**
 * Prior turns of a Run without a checkpoint, as a transcript ahead of the live
 * user text. `system` entries are dropped: host system context travels as the
 * system-instructions rule in RequestContext. Closing tags inside a message are
 * escaped so a message cannot end its own block early.
 */
export declare function seedHistoryUserText(text: string, history: readonly SeedHistoryMessage[] | undefined): string;
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
/**
 * ACM #5 `exec_client_control_message.heartbeat{id}`: Cursor CLI sends it every
 * 3 s for each exec it is still running, keyed by the exec message id. The CLI
 * leaves a zero id out, as proto3 does for a default scalar; protobufjs would
 * write it explicitly, so it is omitted here to send the CLI's exact bytes.
 */
export declare function buildExecHeartbeat(execId: number): Uint8Array;
/** Stops the live Run, as Cursor CLI does on a user Stop before it closes the stream. */
export declare function buildCancelAction(reason: string): Uint8Array;
