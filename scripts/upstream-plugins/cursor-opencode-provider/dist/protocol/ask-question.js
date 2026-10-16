/**
 * Cursor-native AskQuestion ⇄ OpenCode `question` translation.
 *
 * Cursor's AskQuestion is not a tool the client executes — the server raises an
 * `InteractionQuery` (`ask_question_interaction_query`, field 3) and blocks the
 * Run until the client answers with an `AskQuestionResult`. OpenCode has an
 * equivalent host tool (`question`), so the provider translates rather than
 * refusing: refusing made models narrate "the AskQuestion tool is unavailable"
 * and fall back to prose instead of ever calling the advertised host tool.
 *
 * Every rule below mirrors Cursor CLI, decompiled at
 * `<cursor-cli-checkout>/cursor/cli{,-local}`:
 *
 * - `src/utils/interaction-utils.ts` — `BU` (freeform option id), `Q7` (display
 *   options), `iX` (selection → success), `N$` (rejection + default reason).
 * - `chunk-7076/dist/ui.js` (`askQuestionInteractionQuery` case) and
 *   `subagent/subagent-prompt-handler.js` (`requestAskQuestion`) — the
 *   sync/async split and the exact rejection reasons.
 *
 * Keep the reason strings byte-identical to the CLI's: they reach the model as
 * tool feedback, and Cursor's server-side prompting is tuned against them.
 */
import { decodeMessageSparse } from "./messages.js";
/** Cursor's synthetic "type your own answer" option id (interaction-utils `BU`). */
export const FREEFORM_OPTION_ID = "__freeform_other__";
/**
 * `PendingExec.resultField` marking a held-open AskQuestion. It is not an
 * `ExecClientMessage` field: continuation dispatches on it to write an
 * InteractionResponse or a ConversationAction instead of an exec result.
 */
export const ASK_QUESTION_RESULT_FIELD = "ask_question_interaction_response";
/** Default rejection reason when the user skips (interaction-utils `N$`). */
export const SKIPPED_REASON = "Questions skipped by user";
/** Rejection used when the host dismisses the prompt (CLI `resolveAskQuestionPrompt`). */
export const DISMISSED_REASON = "Ask-question prompt dismissed";
export const MISSING_QUERY_REASON = "Missing ask-question query";
export const MISSING_ARGS_REASON = "Missing ask-question arguments";
/** OpenCode's `question` tool caps its short header label at 30 chars. */
const HEADER_MAX_LENGTH = 30;
function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
}
function str(value) {
    return typeof value === "string" ? value : "";
}
/**
 * Extract the raw bytes of `AskQuestionInteractionQuery.args` (#1) without
 * decoding. protobufjs hands back a decoded copy that would silently drop
 * unknown fields on re-encode; the async completion action must echo the
 * server's own bytes.
 */
function extractArgsBytes(queryBytes) {
    let offset = 0;
    while (offset < queryBytes.length) {
        let key = 0;
        let shift = 0;
        while (offset < queryBytes.length) {
            const byte = queryBytes[offset++];
            key |= (byte & 0x7f) << shift;
            if ((byte & 0x80) === 0)
                break;
            shift += 7;
            if (shift > 28)
                return undefined;
        }
        const fieldNumber = key >>> 3;
        const wireType = key & 7;
        if (wireType === 2) {
            let length = 0;
            let lengthShift = 0;
            while (offset < queryBytes.length) {
                const byte = queryBytes[offset++];
                length |= (byte & 0x7f) << lengthShift;
                if ((byte & 0x80) === 0)
                    break;
                lengthShift += 7;
                if (lengthShift > 28)
                    return undefined;
            }
            if (offset + length > queryBytes.length)
                return undefined;
            if (fieldNumber === 1)
                return queryBytes.subarray(offset, offset + length);
            offset += length;
        }
        else if (wireType === 0) {
            while (offset < queryBytes.length && (queryBytes[offset++] & 0x80) !== 0) {
                // skip varint continuation bytes
            }
        }
        else if (wireType === 5) {
            offset += 4;
        }
        else if (wireType === 1) {
            offset += 8;
        }
        else {
            return undefined;
        }
    }
    return undefined;
}
/**
 * Decode an `ask_question_interaction_query` body. Returns undefined when the
 * body carries no usable question set — the caller then rejects with the CLI's
 * own "missing" reason rather than bridging an empty prompt to the host.
 */
export function decodeAskQuestionQuery(queryBytes) {
    let decoded;
    try {
        decoded = decodeMessageSparse("AskQuestionInteractionQuery", queryBytes);
    }
    catch {
        return undefined;
    }
    const rawArgs = extractArgsBytes(queryBytes);
    const argsRecord = asRecord(decoded.args);
    if (!argsRecord || !rawArgs)
        return undefined;
    const questions = Array.isArray(argsRecord.questions)
        ? argsRecord.questions.flatMap((raw) => {
            const item = asRecord(raw);
            if (!item)
                return [];
            const prompt = str(item.prompt);
            if (!prompt)
                return [];
            const options = Array.isArray(item.options)
                ? item.options.flatMap((rawOption) => {
                    const option = asRecord(rawOption);
                    if (!option)
                        return [];
                    const label = str(option.label);
                    if (!label)
                        return [];
                    return [{ id: str(option.id), label }];
                })
                : [];
            return [{
                    id: str(item.id),
                    prompt,
                    options,
                    allowMultiple: item.allow_multiple === true,
                }];
        })
        : [];
    if (questions.length === 0)
        return undefined;
    return {
        args: {
            title: str(argsRecord.title),
            questions,
            runAsync: argsRecord.run_async === true,
        },
        rawArgs,
        toolCallId: str(decoded.tool_call_id),
    };
}
/**
 * Cursor CLI drops a trailing catch-all option before rendering, because it
 * always appends its own freeform "Other" row (interaction-utils `Q7`).
 * OpenCode's `question` tool does the same thing via `custom` (default true,
 * and not settable from the tool schema), so the strip is required here too or
 * the user sees two "Other" entries for one question.
 */
export function isCatchAllOptionLabel(label) {
    const normalized = label.toLowerCase().trim();
    return (normalized === "other"
        || normalized === "something else"
        || normalized.startsWith("other:")
        || normalized.startsWith("other -")
        || normalized.startsWith("other (")
        || normalized.startsWith("something else:")
        || normalized.startsWith("something else -")
        || normalized.startsWith("something else ("));
}
/** Options as Cursor would display them: trailing catch-all removed. */
export function displayOptions(question) {
    const last = question.options.at(-1);
    if (last && isCatchAllOptionLabel(last.label))
        return question.options.slice(0, -1);
    return question.options.slice();
}
/** OpenCode `Question.Prompt.header`: short label, max 30 chars. */
export function questionHeader(title) {
    const trimmed = title.trim();
    if (!trimmed)
        return "Question";
    return trimmed.length > HEADER_MAX_LENGTH
        ? trimmed.slice(0, HEADER_MAX_LENGTH - 1).trimEnd() + "…"
        : trimmed;
}
/**
 * Fill required OpenCode `question` fields when a model call omits them.
 * Live OC1 failure: SchemaError Missing key at ["questions"][0]["header"].
 */
export function normalizeOpencodeQuestionArgs(args) {
    if (!Array.isArray(args.questions))
        return args;
    return {
        ...args,
        questions: args.questions.map((item) => {
            if (!item || typeof item !== "object" || Array.isArray(item))
                return item;
            const q = item;
            const prompt = typeof q.question === "string" ? q.question : "";
            const existing = typeof q.header === "string" ? q.header : "";
            const options = Array.isArray(q.options)
                ? q.options.map((opt) => {
                    if (!opt || typeof opt !== "object" || Array.isArray(opt))
                        return opt;
                    const o = opt;
                    return {
                        ...o,
                        ...(o.description === undefined ? { description: "" } : {}),
                    };
                })
                : q.options;
            return {
                ...q,
                header: questionHeader(existing.trim() || prompt),
                options,
            };
        }),
    };
}
/**
 * Build the OpenCode `question` tool input. `Question.Prompt` requires
 * `question`, `header`, and `options[{label, description}]`; Cursor options
 * carry no description, so it stays empty rather than being invented.
 */
export function askQuestionToolInput(args) {
    return {
        questions: args.questions.map((question) => ({
            question: question.prompt,
            header: questionHeader(args.title),
            options: displayOptions(question).map((option) => ({
                label: option.label,
                description: "",
            })),
            ...(question.allowMultiple ? { multiple: true } : {}),
        })),
    };
}
/** `AskQuestionResult{rejected}` — interaction-utils `N$`. */
export function rejectedResult(reason) {
    return { rejected: { reason: reason ?? SKIPPED_REASON } };
}
/** `AskQuestionResult{async}` — the immediate reply for `run_async` queries. */
export function asyncResult() {
    return { async: {} };
}
/**
 * Pull each question's answer text out of a host `question` tool output.
 *
 * OpenCode 1.x returns prose (`metadata.answers` does not cross the AI SDK
 * boundary):
 *
 *   User has answered your questions: "<q1>"="<a, b>", "<q2>"="Unanswered". You
 *   can now continue with the user's answers in mind.
 *
 * OpenCode 2.0 sends the tool's declared output as JSON
 * (`{ "answers": [["Yes"], …] }`) and does not put that prose on the AI SDK
 * tool-result. Answers are positional.
 *
 * The prose is located by its `"<question>"="` anchor — robust
 * against commas, quotes and `"="` inside question or answer text, and against
 * duplicate questions. Returns undefined for a question whose anchor is
 * absent, which is treated as unanswered rather than guessed at.
 */
export function parseAnswerSegments(questions, output) {
    const fromJson = parseJsonAnswerSegments(output, questions.length);
    if (fromJson)
        return fromJson;
    const answers = [];
    let cursor = 0;
    for (const question of questions) {
        const anchor = `"${question.prompt}"="`;
        const start = output.indexOf(anchor, cursor);
        if (start < 0) {
            answers.push(undefined);
            continue;
        }
        const valueStart = start + anchor.length;
        // The value ends at the last quote before the next anchor (or the trailing
        // `. You can now continue…`). Searching backwards from the next anchor
        // keeps quoted text inside an answer intact.
        const nextAnchorStart = questions
            .map((other) => output.indexOf(`"${other.prompt}"="`, valueStart))
            .filter((index) => index > valueStart)
            .reduce((min, index) => (min < 0 || index < min ? index : min), -1);
        const searchEnd = nextAnchorStart >= 0 ? nextAnchorStart : output.length;
        const valueEnd = output.lastIndexOf('"', searchEnd - 1);
        if (valueEnd < valueStart) {
            answers.push(undefined);
            continue;
        }
        answers.push(output.slice(valueStart, valueEnd));
        cursor = valueEnd;
    }
    return answers;
}
function cellText(cell) {
    if (typeof cell === "string")
        return cell;
    if (typeof cell === "number" || typeof cell === "boolean")
        return String(cell);
    if (Array.isArray(cell)) {
        const parts = cell.map((item) => (typeof item === "string" ? item : "")).filter(Boolean);
        return parts.length > 0 ? parts.join(", ") : undefined;
    }
    return undefined;
}
/** OpenCode 2 `question` output `{ answers: string[][] }`, or a JSON array of cells. */
function parseJsonAnswerSegments(output, count) {
    const trimmed = output.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("["))
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(trimmed);
    }
    catch {
        return undefined;
    }
    const cells = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object" && Array.isArray(parsed.answers)
            ? parsed.answers
            : undefined;
    if (!cells)
        return undefined;
    return Array.from({ length: count }, (_, index) => cellText(cells[index]));
}
/** OpenCode's placeholder for a question the user left blank. */
const UNANSWERED = "Unanswered";
/**
 * Map one question's answer labels back onto Cursor option ids.
 *
 * OpenCode returns labels, so a label that matches an option we sent becomes a
 * `selected_option_id`; anything else is the user's custom answer and becomes
 * `freeform_text`. Cursor CLI's `iX` substitutes the literal "Other" when the
 * freeform row was chosen without text, so an empty custom answer does too.
 */
export function answerForQuestion(question, segment) {
    const answer = { question_id: question.id };
    if (segment === undefined || segment.trim().length === 0 || segment.trim() === UNANSWERED) {
        return answer;
    }
    const byLabel = new Map(displayOptions(question).map((option) => [option.label.trim().toLowerCase(), option.id]));
    const selected = [];
    const custom = [];
    // `multiple: true` answers arrive joined with ", " (question tool `formatted`).
    for (const piece of segment.split(", ")) {
        const label = piece.trim();
        if (!label)
            continue;
        const optionId = byLabel.get(label.toLowerCase());
        if (optionId !== undefined)
            selected.push(optionId);
        else
            custom.push(label);
    }
    if (selected.length > 0)
        answer.selected_option_ids = selected;
    if (custom.length > 0)
        answer.freeform_text = custom.join(", ");
    else if (selected.length === 0)
        answer.freeform_text = "Other";
    return answer;
}
/**
 * Translate an OpenCode `question` tool result into an `AskQuestionResult`.
 *
 * A tool error means the host dismissed or failed the prompt — OpenCode's
 * `Question.RejectedError` is the dismissal path — so it maps to the CLI's
 * rejection rather than an empty success, which the model would read as "the
 * user answered nothing".
 */
export function askQuestionResultFromToolOutput(args, output, isError) {
    if (isError) {
        const reason = output.trim();
        return rejectedResult(reason.length > 0 ? reason : DISMISSED_REASON);
    }
    const segments = parseAnswerSegments(args.questions, output);
    return {
        success: {
            answers: args.questions.map((question, index) => answerForQuestion(question, segments[index])),
        },
    };
}
