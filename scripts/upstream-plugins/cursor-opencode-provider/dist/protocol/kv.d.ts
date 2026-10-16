import type { CursorSession } from "../session.js";
/**
 * Handle a server `KvServerMessage` (AgentServerMessage #4). Cursor moves large
 * payloads out-of-band via this blob channel:
 *  - `set_blob_args{blob_id, blob_data}` → server stores a blob on the client.
 *    We persist it (per-session + durable per conversation_id) and ACK.
 *  - `get_blob_args{blob_id}` → server asks the client for a blob it stored.
 *    We return `get_blob_result{blob_data}` (empty if unknown hash).
 * The reply MUST be sent as `AgentClientMessage.kv_client_message` (field #3) on
 * the same Run stream, echoing `id`. If we don't reply, the server hangs the
 * turn (endless heartbeats, never any interaction_update) — the "no response"
 * root cause.
 *
 * Returns the AgentClientMessage bytes to write back, or null if the message
 * carried no get/set blob request.
 */
export declare function handleKvServerMessage(ksm: Record<string, unknown>, session: CursorSession): {
    reply: Uint8Array;
    replyBlobBytes: number;
    kind: "set" | "get";
    id: number;
    blobIdHex: string;
    found: boolean;
    echoed?: boolean;
} | null;
