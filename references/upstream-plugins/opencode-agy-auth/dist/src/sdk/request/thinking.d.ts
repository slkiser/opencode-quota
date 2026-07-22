/**
 * NOTE: Special Design - Streaming deduplication and signature state self-healing
 * Agy/Gemini official API has the following non-standard behaviors and strict constraints that must be specially handled here:
 * 1. [Streaming Deduplication]: In the data packets returned by the official API during streaming, thought chain (Thinking) content is output cumulatively.
 *    We must perform hash comparison and truncation on each returned delta to prevent the IDE from receiving duplicate text.
 * 2. [Signature State Self-healing]: In multi-turn dialogues, if the thoughtSignature is lost due to tool calls or client state breakage,
 *    the official API throws a signature mismatch error. An auto-detection mechanism (e.g., needsThinkingRecovery) is designed here to, upon signature breakage,
 *    automatically backfill/align fallback thought chain fragments and signatures in context messages, allowing the dialogue chain to self-heal and continue.
 */
/**
 * Cached signed thought chain data structure
 */
export interface SignedThinking {
    /** Full thought chain text content */
    text: string;
    /** Corresponding server signature */
    signature: string;
}
/**
 * External contract interface for signature storage manager
 */
export interface SignatureStore {
    get(sessionKey: string): SignedThinking | undefined;
    set(sessionKey: string, value: SignedThinking): void;
    has(sessionKey: string): boolean;
    delete(sessionKey: string): void;
}
/**
 * Custom callback functions for the streaming phase
 */
export interface StreamingCallbacks {
    onCacheSignature?: (sessionKey: string, text: string, signature: string) => void;
    onInjectDebug?: (response: unknown, debugText: string) => unknown;
    transformThinkingParts?: (parts: unknown) => unknown;
    onTurnStateUpdate?: (sessionKey: string, state: {
        turnHasThinking: boolean;
        lastModelHasToolCalls: boolean;
    }) => void;
}
/**
 * Configuration parameters for the streaming phase
 */
export interface StreamingOptions {
    /** Unique identifier for the signature session, used for cross-turn signature recovery */
    signatureSessionKey?: string;
    /** Debugging text to inject into the stream (optional) */
    debugText?: string;
    /** Whether to cache the latest generated signature in this stream */
    cacheSignatures?: boolean;
    /** Set of already rendered thought chain hashes, used to avoid duplicate output in tool call loops */
    displayedThinkingHashes?: Set<string>;
}
/**
 * Text buffer for caching thought chains of a specific index or type (handles streaming chunk cumulative output)
 */
export interface ThoughtBuffer {
    get(index: number): string | undefined;
    set(index: number, text: string): void;
    clear(): void;
}
/**
 * Agent and tool interaction state record during multi-turn dialogue runtime
 */
export interface ConversationState {
    /** Whether inside an incomplete tool call loop (i.e., last turn ended with functionResponse, continuing this turn) */
    inToolLoop: boolean;
    /** Array index of the first model reply message in the current dialogue turn */
    turnStartIdx: number;
    /** Whether the start of the current dialogue turn contains a thought chain (thought) */
    turnHasThinking: boolean;
    /** Array index of the last model reply message */
    lastModelIdx: number;
    /** Whether the last model message contains a thought chain */
    lastModelHasThinking: boolean;
    /** Whether the last model message contains a tool call (tool_use) */
    lastModelHasToolCalls: boolean;
}
/**
 * Creates a memory Map-based signature storage manager
 */
export declare function createSignatureStore(): SignatureStore;
/**
 * Creates a thought chain text accumulation buffer for temporarily storing streaming chunks
 */
export declare function createThoughtBuffer(): ThoughtBuffer;
/**
 * Default global memory signature storage
 */
export declare const defaultSignatureStore: SignatureStore;
/**
 * Analyzes multi-turn historical dialogue arrays to extract context metrics like agent interaction loop state, model message positions, whether the turn has thoughts, etc.
 */
export declare function analyzeConversationState(contents: any[]): ConversationState;
/**
 * Closes the tool execution loop and injects transition content to smoothly recover the dialogue without providing the old thought chain
 */
export declare function closeToolLoopForThinking(contents: any[]): any[];
/**
 * Checks if the current state meets conditions to trigger historical self-healing
 */
export declare function needsThinkingRecovery(state: ConversationState): boolean;
/**
 * Determines if the current model reply message had its thought chain pruned (has only tool calls but lost its preceding thought chain description)
 */
export declare function looksLikeCompactedThinkingTurn(msg: any): boolean;
/**
 * Deeply determines if the start of this Turn contains historical rounds whose thought chains might have been pruned/compressed by the system
 */
export declare function hasPossibleCompactedThinking(contents: any[], turnStartIdx: number): boolean;
/**
 * For streaming SSE data packets, calculates and locally strips duplicated thought chain text
 * Simultaneously supports Gemini's exclusive candidates.content structure and Claude's exclusive content[type=thinking] structure
 */
export declare function deduplicateThinkingText(response: unknown, sentBuffer: ThoughtBuffer, displayedThinkingHashes?: Set<string>): unknown;
/**
 * Caches thought chain content and its validation signature from the returned message body for signature alignment in the next interaction round
 * Also supports Gemini signature mechanism (candidates[].thoughtSignature) and Claude signature mechanism (content[].signature)
 */
export declare function cacheThinkingSignaturesFromResponse(response: unknown, signatureSessionKey: string, signatureStore: SignatureStore, thoughtBuffer: ThoughtBuffer, onCacheSignature?: (sessionKey: string, text: string, signature: string) => void): void;
/**
 * Transforms a single complete SSE event, triggering thought chain caching and incremental deduplication here
 */
export declare function transformSseEvent(eventText: string, signatureStore: SignatureStore, thoughtBuffer: ThoughtBuffer, sentThinkingBuffer: ThoughtBuffer, callbacks: StreamingCallbacks, options: StreamingOptions, debugState: {
    injected: boolean;
}): string;
/**
 * Creates a TransformStream processor to split, deduplicate, and recombine the output stream
 */
export declare function createStreamingTransformer(signatureStore: SignatureStore, callbacks: StreamingCallbacks, options?: StreamingOptions): TransformStream<Uint8Array, Uint8Array>;
