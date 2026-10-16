export type WorkspaceGroundingOptions = {
    /** OpenCode 2 file tools take `path` and do not say it must be absolute. */
    requireAbsolutePathArg?: boolean;
};
/**
 * Attach the exact workspace root to a model-visible string.
 *
 * Idempotent: a second call does not stack another root line. The absolute-path
 * sentence is added only when requested, and only once.
 */
export declare function appendWorkspaceRootGrounding(reason: string, workspaceRoot: string | undefined, options?: WorkspaceGroundingOptions): string;
/**
 * Checkpointed Runs omit the system prompt, which is where the root normally
 * lives. Put the same reminder on the live user message so a later turn cannot
 * invent an absolute prefix before any tool result arrives.
 */
export declare function appendCheckpointUserGrounding(userText: string, workspaceRoot: string | undefined, options?: WorkspaceGroundingOptions): string;
