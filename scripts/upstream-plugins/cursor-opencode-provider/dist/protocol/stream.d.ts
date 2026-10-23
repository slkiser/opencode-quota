export type StreamEvent = {
    type: "text-delta";
    text: string;
} | {
    type: "reasoning-delta";
    text: string;
} | {
    type: "finish";
    usage: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
    };
    finishReason: string;
} | {
    type: "tool-call-started";
    callId: string;
    toolName: string;
    args: string;
} | {
    type: "tool-call-completed";
    callId: string;
    result: string;
} | {
    type: "tool-input-delta";
    callId: string;
    delta: string;
} | {
    type: "heartbeat";
} | {
    type: "step";
};
/**
 * Parse an AgentServerMessage frame payload into a stream event.
 * Returns null for frames that should be skipped.
 */
export declare function parseInteractionUpdate(payload: Uint8Array): StreamEvent | null;
