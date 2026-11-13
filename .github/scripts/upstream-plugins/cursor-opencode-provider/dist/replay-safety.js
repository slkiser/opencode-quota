import { trace } from "./debug.js";
import { readAllFieldsStrict } from "./protocol/struct.js";
/** Host output without execution authority: sending the turn again repeats no side effect. */
const OUTPUT_ONLY_BARRIERS = new Set([
    "visible-text", "visible-reasoning", "visible-tool-row",
]);
/** Past this many tracked injections a Run's echoes are no longer matched (fail closed). */
const MAX_RUN_INJECTIONS = 64;
const MAX_APPENDED_INJECTIONS = 128;
/** Remember an injection before writing it, so its echo can be recognized. */
export function trackRunInjection(injections, injection) {
    injections.push(injection);
    if (injections.length > MAX_RUN_INJECTIONS)
        injections.splice(0, injections.length - MAX_RUN_INJECTIONS);
}
export function markRunInjectionDelivered(injections, injectionId) {
    const injection = injectionId ? injections?.find((candidate) => candidate.injectionId === injectionId) : undefined;
    if (injection)
        injection.delivered = true;
}
/**
 * The injection an appended message echoes: the same `message_id` and text, already delivered.
 * A match is consumed, so a second echo of the same message stays unmatched.
 */
export function takeAppendedInjection(injections, message) {
    if (!injections || !message)
        return undefined;
    const index = injections.findIndex((candidate) => candidate.messageId === message.messageId);
    const injection = index === -1 ? undefined : injections[index];
    if (!injection?.delivered || injection.text !== message.text)
        return undefined;
    injections.splice(index, 1);
    return injection.kind === "steer"
        ? { kind: "steer", injectionId: injection.injectionId }
        : { kind: "note", injectionId: injection.injectionId, notes: [...injection.notes ?? []] };
}
const OWNED_ANSWERS = new Set(["edit-handshake", "task-attachment"]);
/**
 * Whether host history holds everything the Run's execs did. `completed` holds
 * `sessionId:execId` of each host result in the prompt being rebuilt. A provider
 * answer needs no result of its own; an edit handshake or Task attachment read
 * needs a host exec of the same call whose result history holds.
 */
export function historyCoverage(state, completed) {
    const execs = state?.execs ?? [];
    const hostExecs = execs.filter((exec) => !exec.answer);
    const resultHeld = (exec) => completed.has(`${exec.sessionId}:${exec.id}`);
    const answers = {};
    let complete = hostExecs.every(resultHeld);
    for (const exec of execs) {
        if (!exec.answer)
            continue;
        answers[exec.answer] = (answers[exec.answer] ?? 0) + 1;
        if (OWNED_ANSWERS.has(exec.answer)
            && !(exec.callId && hostExecs.some((owner) => owner.callId === exec.callId && resultHeld(owner)))) {
            complete = false;
        }
    }
    return { hostExecs: hostExecs.length, answers, complete };
}
/** Every display call must be represented by a host exec or a completed inline catalog lookup. */
export function announcedCallsClaimed(state) {
    const claimed = new Set(state?.execs?.flatMap((exec) => exec.callId ? [exec.callId] : []));
    return (state?.announcedCalls ?? []).every((callId) => claimed.has(callId)
        || state?.catalogCalls?.[callId] === "completed");
}
export class AttemptReplaySafety {
    sessionId;
    state;
    barrierReason;
    stateful = false;
    /** A barrier of this attempt other than an echo of the Run's own injection. */
    otherBarrier = false;
    constructor(sessionId, state = {}) {
        this.sessionId = sessionId;
        this.state = state;
        this.stateful = state.statefulBarrier !== undefined;
    }
    markBarrier(reason) {
        this.mark(reason, reason === "non-control-exec");
    }
    /**
     * A display lifecycle frame. A started call stays a stateful barrier but
     * blocks a history rebuild only until a host exec claims it; completion of a
     * claimed call adds nothing history lacks. The sole server-side exception is
     * a completed inline catalog lookup: it has no execution side effect. Other
     * server-side calls and frames without a call id cannot be rebuilt.
     */
    recordToolLifecycle(lifecycle) {
        if (lifecycle?.catalog && lifecycle.kind === "completed"
            && this.state.catalogCalls?.[lifecycle.callId] === "started") {
            this.state.catalogCalls[lifecycle.callId] = "completed";
            trace(`recovery: inline-catalog-completed callId=${lifecycle.callId} sessionId=${this.sessionId}`);
            return;
        }
        const claimed = !!lifecycle && !!this.state.execs?.some((exec) => exec.callId === lifecycle.callId);
        if (lifecycle?.kind === "completed" && claimed) {
            trace(`replay: display completion of claimed callId=${lifecycle.callId} sessionId=${this.sessionId}`);
            return;
        }
        if (lifecycle?.kind === "started" && !claimed) {
            if (this.state.catalogCalls?.[lifecycle.callId]) {
                this.mark("display-tool-lifecycle", false);
                return;
            }
            if (lifecycle.catalog) {
                this.state.catalogCalls ??= Object.create(null);
                this.state.catalogCalls[lifecycle.callId] = "started";
            }
            const announced = this.state.announcedCalls ??= [];
            if (!announced.includes(lifecycle.callId))
                announced.push(lifecycle.callId);
            this.mark("display-tool-lifecycle", true);
            return;
        }
        this.mark("display-tool-lifecycle", false);
    }
    recordExec(id, callId) {
        const execs = this.state.execs ??= [];
        if (typeof id !== "number" || !Number.isSafeInteger(id)
            || execs.some(exec => exec.sessionId === this.sessionId && exec.id === id)) {
            this.markHistoryUnsafe(`invalid-or-repeated-exec-id id=${String(id)}`);
            return;
        }
        execs.push({ sessionId: this.sessionId, id, ...(callId ? { callId } : {}) });
    }
    /** The provider answered this exec itself; nothing ran on the host. */
    recordProviderAnswer(id, answer) {
        const exec = this.state.execs?.find(exec => exec.sessionId === this.sessionId && exec.id === id);
        if (exec)
            exec.answer = answer;
    }
    /**
     * A `user_message_appended` update, with the Run's own injection it echoes. A stateful barrier
     * either way; only a matched echo leaves the history rebuild to the rebuild-time check.
     */
    recordAppendedMessage(injection) {
        const appended = this.state.appendedInjections ??= [];
        if (!injection || appended.length >= MAX_APPENDED_INJECTIONS) {
            this.mark("stateful-interaction", false, injection ? "too-many-appended-injections" : "unmatched-appended-message");
            return;
        }
        appended.push(injection);
        trace(`recovery: appended-echo kind=${injection.kind} injectionId=${injection.injectionId} sessionId=${this.sessionId}`);
        this.mark("stateful-interaction", true, undefined, true);
    }
    markHistoryUnsafe(cause) {
        this.state.historyRebaseUnsafe = true;
        trace(`recovery: history-unsafe cause=${cause} sessionId=${this.sessionId}`);
    }
    mark(reason, historyRepresentable, detail, injectionEcho = false) {
        if (!injectionEcho)
            this.otherBarrier = true;
        if (!OUTPUT_ONLY_BARRIERS.has(reason)) {
            this.stateful = true;
            this.state.statefulBarrier ??= reason;
            if (!historyRepresentable)
                this.markHistoryUnsafe(detail ? `${reason} ${detail}` : reason);
        }
        if (this.barrierReason)
            return;
        this.barrierReason = reason;
        trace(`replay barrier: reason=${reason} sessionId=${this.sessionId}`);
    }
    applyTo(failure) {
        failure.replaySafe = this.barrierReason === undefined && !this.stateful && failure.replaySafe;
        if (this.barrierReason) {
            failure.replayBarrier = this.stateful ? "stateful" : "output-only";
            if (!this.otherBarrier)
                failure.replayBarrierEchoesOnly = true;
            trace(`replay suppressed: reason=${this.barrierReason} barrier=${failure.replayBarrier} ` +
                `sessionId=${this.sessionId}`);
        }
        return failure;
    }
}
/** Validate the raw oneof and its nested fields; decoding alone drops unknown bytes. */
function inlineCatalog(topLevel, completed) {
    const update = nestedFields(topLevel, 1).find(field => field.fn === (completed ? 3 : 2));
    const lifecycle = update?.bytes && readAllFieldsStrict(update.bytes);
    const call = lifecycle && lifecycle.find(field => field.fn === 2);
    const toolFields = call?.bytes && readAllFieldsStrict(call.bytes);
    // Cursor CLI: tool_call_id #57, started_at_ms #59, completed_at_ms #60.
    if (!toolFields || !optionalField(toolFields, 57, 2)
        || !optionalField(toolFields, 59, 0) || !optionalField(toolFields, 60, 0))
        return false;
    const variants = toolFields.filter(field => ![57, 59, 60].includes(field.fn));
    if (variants.length !== 1 || variants[0].fn !== 44 || variants[0].wt !== 2)
        return false;
    const catalog = variants[0].bytes && readAllFieldsStrict(variants[0].bytes);
    if (!catalog || !catalog.every(field => [1, 2].includes(field.fn) && field.wt === 2)
        || ![1, 2].every(field => optionalField(catalog, field, 2)))
        return false;
    const args = catalog.find(field => field.fn === 1)?.bytes;
    const fields = args && readAllFieldsStrict(args);
    if (!fields || !fields.every(field => [1, 2, 3, 4].includes(field.fn) && field.wt === 2)
        || ![1, 2, 3, 4].every(field => optionalField(fields, field, 2)))
        return false;
    const result = catalog.find(field => field.fn === 2)?.bytes;
    if (!completed)
        return result === undefined;
    const outcome = result && readAllFieldsStrict(result);
    if (!outcome || outcome.length !== 1 || outcome[0].fn !== 1 || outcome[0].wt !== 2)
        return false;
    const success = outcome[0].bytes && readAllFieldsStrict(outcome[0].bytes);
    return !!success && success.every(field => [1, 2].includes(field.fn) && field.wt === 2)
        && [1, 2].every(field => optionalField(success, field, 2))
        && success.some(field => field.fn === 1)
        && !success.some(field => field.fn === 2 && field.bytes?.length);
}
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
// Cursor's echo of an injection carries, besides text #1 and message_id #2, a
// flag and two timestamps (#24–#26, varints) in a recorded 2026 frame; the
// shipped CLI descriptors this client follows predate them.
const APPENDED_ECHO_METADATA = [24, 25, 26];
/**
 * `UserMessageAppendedUpdate.user_message` holding only what a client
 * `user_context` injection sends (text #1 and message_id #2, each once) plus
 * Cursor's echo metadata. Anything else (selected context, mode, another
 * field) is not an echo of this client's own message. Call only on a frame
 * `validInteractionUpdateWire` accepted: update #6 then holds exactly one
 * length-delimited `user_message` #1.
 */
function appendedEcho(topLevel) {
    const update = nestedFields(topLevel, 1).find((field) => field.fn === 6);
    const message = readAllFieldsStrict(readAllFieldsStrict(update.bytes)[0].bytes);
    if (!message
        || !message.every((field) => [1, 2].includes(field.fn) ? field.wt === 2 : APPENDED_ECHO_METADATA.includes(field.fn) && field.wt === 0)
        || ![1, 2, ...APPENDED_ECHO_METADATA].every((fn) => message.filter((field) => field.fn === fn).length <= 1))
        return undefined;
    const text = message.find((field) => field.fn === 1)?.bytes;
    const id = message.find((field) => field.fn === 2)?.bytes;
    if (!text?.length || !id?.length)
        return undefined;
    try {
        return { messageId: strictUtf8.decode(id), text: strictUtf8.decode(text) };
    }
    catch {
        return undefined;
    }
}
// Field numbers follow Cursor CLI 2026.09.28 `agent.v1`; the extracted
// agent.proto lags the live server.
// `InteractionUpdate` oneof members this client recognizes. Besides the
// declared ones: `thinking_completed` #5 (duration), `token_delta` #8 (count),
// `tool_call_delta` #15 (argument stream, like `partial_tool_call` #7),
// `context_injection_state` #23 (status of a client injection, which Cursor
// CLI only shows for queued steers), `routed_model` #24 (display name) and
// `tool_requests_listed` #27 (count) carry no output and no state. Other
// members stay barriers. `user_message_appended` #6 is recognized but stateful:
// the shipped CLI commits its pending turn and starts one from the user message.
// An echo of this client's own injection can still be rebuilt from host history.
const INTERACTION_UPDATE_FIELDS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 13, 14, 15, 16, 17, 23, 24, 27]);
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
    const fields = nestedFields(topLevel, 2);
    // accept_hook_additional_contexts #55 is metadata, not an execution variant.
    const metadataValid = optionalField(fields, 1, 0) && optionalField(fields, 15, 2)
        && optionalField(fields, 19, 2) && optionalField(fields, 55, 0);
    const variants = fields.filter((field) => ![1, 15, 19, 55].includes(field.fn));
    const exactVariant = (field) => metadataValid && variants.length === 1 && variants[0].fn === field && variants[0].wt === 2;
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
    if (update.fn === 6) {
        const appended = update.bytes ? readAllFieldsStrict(update.bytes) : undefined;
        return !!decoded.user_message_appended && appended?.length === 1
            && appended[0].fn === 1 && appended[0].wt === 2;
    }
    if (update.fn === 2 || update.fn === 3) {
        // ToolCallStarted / ToolCallCompleted: call_id #1, tool_call #2,
        // model_call_id #3. A decoder can discard unknown or repeated fields;
        // those bytes must not authorize a history rebuild.
        const lifecycle = update.bytes ? readAllFieldsStrict(update.bytes) : undefined;
        return !!lifecycle && lifecycle.every((field) => [1, 2, 3].includes(field.fn))
            && [1, 2, 3].every((field) => optionalField(lifecycle, field, 2));
    }
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
    const started = decoded.interactionUpdate?.tool_call_started;
    const completed = decoded.interactionUpdate?.tool_call_completed;
    if (started || completed) {
        const callId = (started ?? completed)?.call_id;
        return {
            barrier: "display-tool-lifecycle",
            ...(!malformed && typeof callId === "string" && callId.length > 0
                ? { toolLifecycle: { kind: started ? "started" : "completed", callId,
                        ...(inlineCatalog(topLevel, !!completed) ? { catalog: true } : {}),
                    } }
                : {}),
        };
    }
    let barrier;
    if (malformed || (topLevel.fn === 4 && !validKv)) {
        barrier = "unknown-or-malformed-frame";
    }
    else if (topLevel.fn === 1 && decoded.interactionUpdate?.user_message_appended) {
        const appendedUserMessage = appendedEcho(topLevel);
        return { barrier: "stateful-interaction", ...(appendedUserMessage ? { appendedUserMessage } : {}) };
    }
    else if (topLevel.fn === 2 && !exec.exactRequestContext && !exec.exactMcpState) {
        barrier = "non-control-exec";
    }
    return { barrier };
}
