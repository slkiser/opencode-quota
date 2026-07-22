/**
 * NOTE: Format/protocol conversion logic is typically in the app layer (Plugin), but is implemented here inside the SDK as a special case.
 * Reason:
 * Format conversion (OpenAI format to Gemini/Agy native and vice versa) is tightly coupled with Agy's unique streaming SSE data parsing,
 * thought chain deduplication, and signature self-healing (Thinking Recovery / Signature Cache) in multi-turn dialogues.
 * Encapsulating this conversion in the SDK completely shields the OpenCode plugin app layer from non-standard API interaction complexities,
 * allowing the plugin to simply call and forward standard OpenAI formatted requests and response streams.
 */
/**
 * Converts OpenAI's `tool_calls` into Gemini's `functionCall` sections.
 */
export declare function transformOpenAIToolCalls(requestPayload: Record<string, unknown>): void;
/**
 * Adds synthesized thoughtSignature to function calls in the flattened and wrapped payload.
 */
export declare function addThoughtSignaturesToFunctionCalls(requestPayload: Record<string, unknown>): void;
