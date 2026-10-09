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
/** Cursor's synthetic "type your own answer" option id (interaction-utils `BU`). */
export declare const FREEFORM_OPTION_ID = "__freeform_other__";
/**
 * `PendingExec.resultField` marking a held-open AskQuestion. It is not an
 * `ExecClientMessage` field: continuation dispatches on it to write an
 * InteractionResponse or a ConversationAction instead of an exec result.
 */
export declare const ASK_QUESTION_RESULT_FIELD = "ask_question_interaction_response";
/** Default rejection reason when the user skips (interaction-utils `N$`). */
export declare const SKIPPED_REASON = "Questions skipped by user";
/** Rejection used when the host dismisses the prompt (CLI `resolveAskQuestionPrompt`). */
export declare const DISMISSED_REASON = "Ask-question prompt dismissed";
export declare const MISSING_QUERY_REASON = "Missing ask-question query";
export declare const MISSING_ARGS_REASON = "Missing ask-question arguments";
export type CursorAskQuestionOption = {
    id: string;
    label: string;
};
export type CursorAskQuestionItem = {
    id: string;
    prompt: string;
    options: CursorAskQuestionOption[];
    allowMultiple: boolean;
};
export type CursorAskQuestionArgs = {
    title: string;
    questions: CursorAskQuestionItem[];
    runAsync: boolean;
};
export type DecodedAskQuestionQuery = {
    args: CursorAskQuestionArgs;
    /**
     * The exact `AskQuestionArgs` sub-message bytes. Async completion echoes
     * `original_args` verbatim so fields this schema does not model survive.
     */
    rawArgs: Uint8Array;
    toolCallId: string;
};
/** `AskQuestionResult` oneof, shaped for `encodeMessage`. */
export type AskQuestionResultMessage = Record<string, unknown>;
/**
 * Decode an `ask_question_interaction_query` body. Returns undefined when the
 * body carries no usable question set — the caller then rejects with the CLI's
 * own "missing" reason rather than bridging an empty prompt to the host.
 */
export declare function decodeAskQuestionQuery(queryBytes: Uint8Array): DecodedAskQuestionQuery | undefined;
/**
 * Cursor CLI drops a trailing catch-all option before rendering, because it
 * always appends its own freeform "Other" row (interaction-utils `Q7`).
 * OpenCode's `question` tool does the same thing via `custom` (default true,
 * and not settable from the tool schema), so the strip is required here too or
 * the user sees two "Other" entries for one question.
 */
export declare function isCatchAllOptionLabel(label: string): boolean;
/** Options as Cursor would display them: trailing catch-all removed. */
export declare function displayOptions(question: CursorAskQuestionItem): CursorAskQuestionOption[];
/** OpenCode `Question.Prompt.header`: short label, max 30 chars. */
export declare function questionHeader(title: string): string;
/**
 * Fill required OpenCode `question` fields when a model call omits them.
 * Live OC1 failure: SchemaError Missing key at ["questions"][0]["header"].
 */
export declare function normalizeOpencodeQuestionArgs(args: Record<string, unknown>): Record<string, unknown>;
export type OpencodeQuestionInput = {
    questions: Array<{
        question: string;
        header: string;
        options: Array<{
            label: string;
            description: string;
        }>;
        multiple?: boolean;
    }>;
};
/**
 * Build the OpenCode `question` tool input. `Question.Prompt` requires
 * `question`, `header`, and `options[{label, description}]`; Cursor options
 * carry no description, so it stays empty rather than being invented.
 */
export declare function askQuestionToolInput(args: CursorAskQuestionArgs): OpencodeQuestionInput;
/** `AskQuestionResult{rejected}` — interaction-utils `N$`. */
export declare function rejectedResult(reason?: string): AskQuestionResultMessage;
/** `AskQuestionResult{async}` — the immediate reply for `run_async` queries. */
export declare function asyncResult(): AskQuestionResultMessage;
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
export declare function parseAnswerSegments(questions: readonly CursorAskQuestionItem[], output: string): Array<string | undefined>;
/**
 * Map one question's answer labels back onto Cursor option ids.
 *
 * OpenCode returns labels, so a label that matches an option we sent becomes a
 * `selected_option_id`; anything else is the user's custom answer and becomes
 * `freeform_text`. Cursor CLI's `iX` substitutes the literal "Other" when the
 * freeform row was chosen without text, so an empty custom answer does too.
 */
export declare function answerForQuestion(question: CursorAskQuestionItem, segment: string | undefined): Record<string, unknown>;
/**
 * Translate an OpenCode `question` tool result into an `AskQuestionResult`.
 *
 * A tool error means the host dismissed or failed the prompt — OpenCode's
 * `Question.RejectedError` is the dismissal path — so it maps to the CLI's
 * rejection rather than an empty success, which the model would read as "the
 * user answered nothing".
 */
export declare function askQuestionResultFromToolOutput(args: CursorAskQuestionArgs, output: string, isError: boolean): AskQuestionResultMessage;
