import { type HostToolDialect } from "./tools.js";
/**
 * Cursor's interaction_update.tool_call_* carries a typed ToolCall oneof
 * (shell_tool_call, update_todos_tool_call, mcp_tool_call, …). Some of those
 * never become ExecServerMessage requests — Cursor completes them display-only
 * — so OpenCode would never see a tool-call unless we bridge them here.
 */
export type DisplayToolCall = {
    callId: string;
    variant: string;
    /** Preferred OpenCode tool id before advertisement checks. */
    preferredToolName: string;
    args: Record<string, unknown>;
    /** False when the Cursor call cannot be represented safely in OpenCode. */
    bridgeable?: boolean;
};
export type BridgedOpenCodeToolCall = {
    toolName: string;
    args: Record<string, unknown>;
    callId: string;
    variant: string;
};
/** Display variants Cursor executes itself (mcp_state + optional write spill). */
export declare function isNativeDisplayToolCall(variant: string): boolean;
/** Server-side dynamic-call failures may complete without a started/exec frame. */
export declare function displayMcpToolError(toolCall: Record<string, unknown> | undefined): string | undefined;
/** Native discovery errors are server-side results, never host execution. */
export declare function displayNativeDiscoveryError(toolCall: Record<string, unknown> | undefined): string | undefined;
/**
 * Normalize a full todo snapshot for `mirroredTodos` storage. Returns
 * undefined when the input is not a todo array (nothing to learn). Drops the
 * synthetic "plan" id minted for create_plan mirrors so later merges never
 * resurrect it.
 */
export declare function snapshotMirroredTodos(todos: unknown): Array<Record<string, unknown>> | undefined;
/**
 * Refresh the mirrored snapshot from a host `todoread` tool result. The host
 * list is authoritative; returns undefined when the output is not recognizable
 * todo JSON (prose, caps, errors) so a stale-but-useful snapshot survives.
 */
export declare function snapshotMirroredTodosFromReadOutput(output: string): Array<Record<string, unknown>> | undefined;
/**
 * Overlay Cursor merge patches onto a previously mirrored full todo list.
 * Preserves prior order; appends newly introduced ids in patch order.
 *
 * Matching is by id first, then by exact (trimmed) content. The content
 * fallback covers mixed flows where the prior snapshot came from a direct
 * host `todowrite` (positional ids) while the patch references Cursor-side
 * ids for the same tasks. Patch items with neither an id/content match nor
 * their own content are skipped — a status-only update for an unknown item
 * cannot be mapped onto the host list.
 */
export declare function applyTodoMerge(prior: ReadonlyArray<Record<string, unknown>>, patch: unknown): Array<Record<string, unknown>>;
/**
 * Decode a Cursor ToolCall oneof into a display tool call we can bridge.
 *
 * @param priorMirroredTodos Last full todo snapshot mirrored this Run; used to
 *   expand Cursor `merge: true` updates that omit ToolCallCompleted.success.todos.
 */
export declare function parseDisplayToolCall(callId: string, toolCall: Record<string, unknown> | undefined, priorMirroredTodos?: ReadonlyArray<Record<string, unknown>>): DisplayToolCall | undefined;
/**
 * Pick an advertised OpenCode tool for a display call, remapping args as needed.
 * Returns undefined when nothing compatible is advertised this turn.
 */
export declare function resolveBridgedOpenCodeToolCall(display: DisplayToolCall, advertised: Iterable<string>, dialect?: HostToolDialect): BridgedOpenCodeToolCall | undefined;
/** Advertised OpenCode tool ids from Cursor McpToolDefinition descriptors. */
export declare function advertisedToolNamesFromDescriptors(descriptors: Array<Record<string, unknown>>): string[];
/** Walk a protobuf message and return top-level field numbers present. */
export declare function listProtobufFieldNumbers(buf: Uint8Array): number[];
/**
 * Extract nested bytes for path of field numbers (each must be wire type 2).
 * Returns undefined if any segment is missing.
 */
export declare function extractProtobufSubmessage(buf: Uint8Array, path: number[]): Uint8Array | undefined;
/**
 * Pull Cursor's tool_call_id out of a raw ExecServerMessage args variant so we
 * can correlate display tool_call_started with the authoritative exec path.
 */
export declare function extractExecDisplayCallId(execMsg: Record<string, unknown>): string | undefined;
