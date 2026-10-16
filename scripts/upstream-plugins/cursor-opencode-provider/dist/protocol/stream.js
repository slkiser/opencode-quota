import { decodeMessage } from "./messages.js";
/**
 * Parse an AgentServerMessage frame payload into a stream event.
 * Returns null for frames that should be skipped.
 */
export function parseInteractionUpdate(payload) {
    const asm = decodeMessage("AgentServerMessage", payload);
    const iu = asm.interaction_update;
    if (!iu)
        return null;
    if (iu.heartbeat)
        return { type: "heartbeat" };
    if (iu.text_delta) {
        const td = iu.text_delta;
        return { type: "text-delta", text: td.text ?? "" };
    }
    if (iu.thinking_delta) {
        const td = iu.thinking_delta;
        return { type: "reasoning-delta", text: td.text ?? "" };
    }
    if (iu.turn_ended) {
        const te = iu.turn_ended;
        return {
            type: "finish",
            usage: {
                input: te.input_tokens ?? 0,
                output: te.output_tokens ?? 0,
                cacheRead: te.cache_read ?? 0,
                cacheWrite: te.cache_write ?? 0,
            },
            finishReason: "stop",
        };
    }
    if (iu.tool_call_started) {
        const tc = iu.tool_call_started;
        const toolCall = tc.tool_call;
        const variant = toolCall && typeof toolCall === "object"
            ? Object.keys(toolCall).find((k) => k.endsWith("_tool_call"))
            : undefined;
        const variantPayload = variant && toolCall ? toolCall[variant] : undefined;
        const args = variantPayload?.args ?? variantPayload;
        return {
            type: "tool-call-started",
            callId: tc.call_id ?? "",
            toolName: variant ?? "",
            args: JSON.stringify(args ?? {}),
        };
    }
    if (iu.tool_call_completed) {
        const tc = iu.tool_call_completed;
        const toolCall = tc.tool_call;
        return {
            type: "tool-call-completed",
            callId: tc.call_id ?? "",
            result: JSON.stringify(toolCall ?? {}),
        };
    }
    if (iu.partial_tool_call) {
        const ptc = iu.partial_tool_call;
        return {
            type: "tool-input-delta",
            callId: ptc.call_id ?? "",
            delta: ptc.args_text_delta ?? "",
        };
    }
    if (iu.step_started || iu.step_completed) {
        return { type: "step" };
    }
    return null;
}
