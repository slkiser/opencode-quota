import { trace } from "./debug.js";
import { readAllFieldsStrict } from "./protocol/struct.js";
export class AttemptReplaySafety {
    sessionId;
    barrierReason;
    constructor(sessionId) {
        this.sessionId = sessionId;
    }
    markBarrier(reason) {
        if (this.barrierReason)
            return;
        this.barrierReason = reason;
        trace(`replay barrier: reason=${reason} sessionId=${this.sessionId}`);
    }
    applyTo(failure) {
        failure.replaySafe = this.barrierReason === undefined && failure.replaySafe;
        if (this.barrierReason) {
            trace(`replay suppressed: reason=${this.barrierReason} sessionId=${this.sessionId}`);
        }
        return failure;
    }
}
// Field numbers follow Cursor CLI 2026.09.28 `agent.v1`; the extracted
// agent.proto lags the live server.
// `InteractionUpdate` oneof members this client recognizes. Besides the
// declared ones: `thinking_completed` #5 (duration), `token_delta` #8 (count),
// `tool_call_delta` #15 (argument stream, like `partial_tool_call` #7),
// `routed_model` #24 (display name) and `tool_requests_listed` #27 (count)
// carry no output and no state. Other members stay barriers.
const INTERACTION_UPDATE_FIELDS = new Set([1, 2, 3, 4, 5, 7, 8, 13, 14, 15, 16, 17, 24, 27]);
/** `InteractionUpdate.message_started_at_ms` #25: a timestamp beside the oneof member. */
const INTERACTION_UPDATE_STARTED_AT = 25;
const INTERACTION_QUERY_FIELDS = new Set([2, 3, 4, 7, 8, 9, 10, 11, 12, 13, 14]);
const TOP_LEVEL_FIELDS = new Set([1, 2, 3, 4, 5, 7]);
/** `AgentServerMessage.ttft_breakdown` #8: timing metrics beside the oneof member. */
const SERVER_MESSAGE_TTFT = 8;
/** At most one occurrence of an optional field, with the expected wire type. */
function optionalField(fields, fn, wt) {
    const matches = fields.filter((field) => field.fn === fn);
    return matches.length <= 1 && matches.every((field) => field.wt === wt);
}
function nestedFields(topLevel, field) {
    if (topLevel?.fn !== field || topLevel.wt !== 2 || !topLevel.bytes)
        return [];
    return readAllFieldsStrict(topLevel.bytes) ?? [];
}
function analyzeExecWire(topLevel) {
    const variants = nestedFields(topLevel, 2)
        .filter((field) => ![1, 15, 19].includes(field.fn));
    const exactVariant = (field) => variants.length === 1 && variants[0].fn === field && variants[0].wt === 2;
    return {
        exactRequestContext: exactVariant(10),
        exactMcpState: exactVariant(36),
    };
}
// `KvServerMessage` = id #1, oneof get #2 / set #3, `span_context` #4 (tracing);
// Cursor sends the span on live KV requests.
function validKvWire(topLevel) {
    const fields = nestedFields(topLevel, 4);
    const spans = fields.filter((field) => field.fn === 4);
    if (spans.length > 1 || spans.some((field) => field.wt !== 2))
        return false;
    const variants = fields.filter((field) => field.fn !== 1 && field.fn !== 4);
    const variant = variants.length === 1 ? variants[0] : undefined;
    const args = variant?.wt === 2 && variant.bytes
        ? (readAllFieldsStrict(variant.bytes) ?? [])
        : [];
    const blobIds = args.filter((field) => field.fn === 1 && field.wt === 2 && (field.bytes?.length ?? 0) > 0);
    return !!variant
        && [2, 3].includes(variant.fn)
        && variant.wt === 2
        && blobIds.length === 1
        && args.every((field) => field.wt === 2 && (field.fn === 1 || (variant.fn === 3 && field.fn === 2)));
}
function validInteractionUpdateWire(topLevel, decoded) {
    if (!decoded)
        return true;
    const all = nestedFields(topLevel, 1);
    if (!optionalField(all, INTERACTION_UPDATE_STARTED_AT, 0))
        return false;
    const fields = all.filter((field) => field.fn !== INTERACTION_UPDATE_STARTED_AT);
    const update = fields.length === 1 ? fields[0] : undefined;
    if (!update || update.wt !== 2 || !INTERACTION_UPDATE_FIELDS.has(update.fn))
        return false;
    if (![1, 4].includes(update.fn))
        return true;
    const delta = update.bytes ? (readAllFieldsStrict(update.bytes) ?? []) : [];
    const text = delta.filter((field) => field.fn === 1);
    // #2 is `TextDeltaUpdate.is_server_notice` (bool) or
    // `ThinkingDeltaUpdate.thinking_style` (enum); both varints.
    const flag = delta.filter((field) => field.fn === 2);
    return text.length === 1 && text[0].wt === 2
        && optionalField(delta, 2, 0)
        && delta.length === text.length + flag.length;
}
function validInteractionQueryWire(topLevel, decoded) {
    if (!decoded)
        return true;
    const fields = nestedFields(topLevel, 7);
    const ids = fields.filter((field) => field.fn === 1);
    const variants = fields.filter((field) => field.fn !== 1);
    return ids.length <= 1
        && ids.every((field) => field.wt === 0)
        && variants.length === 1
        && variants[0].wt === 2
        && INTERACTION_QUERY_FIELDS.has(variants[0].fn);
}
function decodedMatchesWire(topLevel, decoded) {
    return !((topLevel?.fn === 1 && !decoded.interactionUpdate)
        || (topLevel?.fn === 2 && !decoded.exec)
        || (topLevel?.fn === 4 && !decoded.kv)
        || (topLevel?.fn === 5 && !decoded.execControl)
        || (topLevel?.fn === 7 && !decoded.interactionQuery));
}
function hasSemanticProgress(decoded) {
    const update = decoded.interactionUpdate;
    const text = update?.text_delta?.text;
    const thinking = update?.thinking_delta?.text;
    return (typeof text === "string" && text.length > 0)
        || (typeof thinking === "string" && thinking.length > 0)
        || !!update?.turn_ended
        || !!update?.tool_call_started
        || !!update?.tool_call_completed
        || !!decoded.exec
        || !!decoded.kv
        || !!decoded.execControl
        || !!decoded.interactionQuery
        || !!decoded.checkpointBytes?.length;
}
/**
 * Field numbers and wire types of a frame, nested three levels, without any
 * payload bytes: `1:2{16:2{1:0}}`. Compare it with `agent.proto` when a frame
 * is classified unknown.
 */
export function describeFrameLayout(payload, depth = 3) {
    const fields = readAllFieldsStrict(payload);
    if (!fields)
        return "?";
    return fields.map((field) => {
        const nested = depth > 1 && field.wt === 2 && field.bytes && field.bytes.length > 0
            ? readAllFieldsStrict(field.bytes)
            : undefined;
        const inner = nested && nested.length > 0 ? `{${describeFrameLayout(field.bytes, depth - 1)}}` : "";
        return `${field.fn}:${field.wt}${inner}`;
    }).join(",");
}
/** Classify one decoded server frame without performing any protocol side effects. */
export function analyzeReplayFrame(payload, decoded) {
    const allTopLevel = readAllFieldsStrict(payload) ?? [];
    const ttftValid = optionalField(allTopLevel, SERVER_MESSAGE_TTFT, 2);
    const topLevelFields = allTopLevel.filter((field) => field.fn !== SERVER_MESSAGE_TTFT);
    const topLevel = ttftValid && topLevelFields.length === 1 ? topLevelFields[0] : undefined;
    const exec = analyzeExecWire(topLevel);
    const validKv = validKvWire(topLevel);
    const malformed = !topLevel
        || topLevel.wt !== 2
        || !TOP_LEVEL_FIELDS.has(topLevel.fn)
        || !validInteractionUpdateWire(topLevel, decoded.interactionUpdate)
        || !validInteractionQueryWire(topLevel, decoded.interactionQuery)
        || !decodedMatchesWire(topLevel, decoded)
        || !!decoded.execControl;
    let barrier;
    if (decoded.interactionUpdate?.tool_call_started || decoded.interactionUpdate?.tool_call_completed) {
        barrier = "display-tool-lifecycle";
    }
    else if (malformed || (topLevel.fn === 4 && !validKv)) {
        barrier = "unknown-or-malformed-frame";
    }
    else if (topLevel.fn === 2 && !exec.exactRequestContext && !exec.exactMcpState) {
        barrier = "non-control-exec";
    }
    return {
        semanticProgress: hasSemanticProgress(decoded),
        barrier,
    };
}
