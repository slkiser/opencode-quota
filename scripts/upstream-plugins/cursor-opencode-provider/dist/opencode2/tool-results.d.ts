/**
 * Preserve native result status before OpenCode's AI SDK lowers errors to text.
 * Upstream: https://github.com/anomalyco/opencode/blob/v2.0.27/packages/core/src/aisdk.ts#L652-L685
 * Native part.providerMetadata becomes SDK part.providerOptions (same file, L717-L720).
 */
export type ToolRefusal = "permission_denied" | "rejected";
export type NativeToolFailure = {
    type: string;
    text: string;
    refusal?: ToolRefusal;
};
export declare const TOOL_RESULT_STATUS_KEY = "opencodeToolResult";
export declare function nativeToolFailure(value: unknown, refusal?: ToolRefusal): NativeToolFailure;
/** The native tool hook preserves the underlying typed permission cause. */
export declare function nativeToolRefusal(error: unknown): ToolRefusal | undefined;
/** Metadata travels with each part, including history and independently loaded SDK copies. */
export declare function preserveNativeToolResults(messages: readonly unknown[] | undefined, refusals?: ReadonlyMap<string, ToolRefusal>): any[];
export declare function toolResultFailure(options: unknown, callID: string): NativeToolFailure | undefined;
