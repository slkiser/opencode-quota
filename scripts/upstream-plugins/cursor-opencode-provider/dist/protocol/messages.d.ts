import protobuf from "protobufjs";
export declare function createMessageTypes(): protobuf.Root;
export declare function getMessageTypes(): protobuf.Root;
export declare function encodeMessage(typeName: string, message: Record<string, unknown>): Uint8Array;
export declare function decodeMessage<T = Record<string, unknown>>(typeName: string, data: Uint8Array): T;
/** Decode without inventing absent proto defaults (used for byte-stable snapshots). */
export declare function decodeMessageSparse<T = Record<string, unknown>>(typeName: string, data: Uint8Array): T;
/**
 * Diagnostic-only: walk AgentServerMessage.interaction_update(1).turn_ended(14)
 * without going through our hand-written TurnEnded schema, so a `cache_write`/
 * `reasoning_tokens` question can be checked against the raw wire instead of
 * guessed. Confirmed field ids 1-5 (input/output/cache_read/cache_write/
 * reasoning) decode correctly. Live captures routinely include `f4` explicitly
 * as `0` while `f3` (cache_read) and `f5` (reasoning) are non-zero — Cursor's
 * agent TurnEnded populates the field but does not report write counts here.
 */
export declare function debugWalkTurnEnded(payload: Uint8Array): string;
/**
 * Decode a protobuf sub-message from a frame payload that wraps it in
 * a top-level field key + length varint.  Skips the outer wrapper and
 * decodes the inner body as `typeName`.
 */
export declare function decodeWrappedMessage<T = Record<string, unknown>>(typeName: string, data: Uint8Array): T;
