/**
 * Commit a staged Cursor image to disk, gated by OpenCode's own permission.
 *
 * Host-neutral on purpose: `./image-save-tool.ts` performs the `tool()` value
 * import from `@opencode-ai/plugin`, which the OpenCode 2.0 entrypoint must not
 * pull in (see the note in `./web-search-tool.ts`). Only that file may import
 * the plugin package; this module is safe on every graph.
 */
/**
 * Marks a refusal that must reach Cursor as `WriteResult.permission_denied`
 * rather than a generic error — the variant its own executor returns and its
 * agent branches on. Both sides of this string are ours, so matching on it is
 * a contract, not a guess at someone else's message.
 */
export declare const IMAGE_PERMISSION_DENIED_PREFIX = "CursorImagePermissionDenied:";
/** The subset of OpenCode's plugin ToolContext this needs. */
export type ImageSaveToolContext = {
    worktree: string;
    directory: string;
    /**
     * Classic OpenCode 1.x `ToolContext.ask`. A host whose tool context has no
     * permission prompt (OpenCode 2.0's public `ToolContext`) passes `null`
     * explicitly: the commit then writes after containment, gated only by the
     * tool's catalog permission. A missing `ask` is refused, never treated as
     * permission.
     */
    ask: ((input: {
        permission: string;
        patterns: string[];
        always: string[];
        metadata: Record<string, unknown>;
    }) => Promise<void>) | null;
};
export type ImageSaveResult = {
    title: string;
    output: string;
    bytes: number;
    attachments?: Array<{
        type: "file";
        mime: string;
        url: string;
        filename?: string;
    }>;
};
/**
 * Prove the staged target still resolves inside one of the roots it was mapped
 * into. `remapCursorImageWritePath` already chose the location; this re-checks
 * it against the *real* paths, because a symlink planted between mapping and
 * commit could otherwise redirect the write. Mirrors the containment rule the
 * correlated-edit read applies before answering with complete file content.
 */
export declare function resolveContainedImagePath(target: string, allowedRoots: readonly string[]): {
    path: string;
    relative: string;
    root: string;
} | {
    error: string;
};
/**
 * Execute the commit. `image_id` is the only input: the path and bytes come
 * from this process's staging table, so a caller without a real handle — the
 * model of any provider, replaying a used id, or guessing — writes nothing.
 */
export declare function executeCursorImageSave(args: {
    image_id?: unknown;
}, ctx: ImageSaveToolContext): Promise<ImageSaveResult>;
