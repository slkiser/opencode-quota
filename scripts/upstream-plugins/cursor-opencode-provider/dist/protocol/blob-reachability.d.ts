type ResolveBlob = (id: Uint8Array) => Uint8Array | undefined;
/**
 * Return the blob ids reachable from Cursor's latest ConversationStateStructure.
 *
 * This mirrors Cursor CLI's conversation-export traversal: turns lead to their
 * user message and steps, shell turns lead to command/output, state-level
 * summaries/todos/prompts are direct refs, and subagent states recurse. Unknown
 * protobuf fields are deliberately ignored for forward compatibility.
 *
 * `resolveBlob` must also resolve Cursor's content-as-id values. Throwing on a
 * missing hash or malformed referenced message makes the caller retain its full
 * snapshot rather than risk publishing an incomplete restart graph.
 */
export declare function collectReachableConversationBlobIds(checkpoint: Uint8Array, resolveBlob: ResolveBlob): Set<string>;
export {};
