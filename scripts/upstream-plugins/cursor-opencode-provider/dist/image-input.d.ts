export declare const MAX_CURSOR_IMAGE_INPUT_BYTES: number;
export type CursorImageInput = {
    data: Uint8Array;
    filename: string;
    mimeType: string;
};
export type CursorHistoryImageExtraction = {
    images: CursorImageInput[];
    hashes: string[];
    candidateCount: number;
    duplicateCount: number;
    /** Unreadable optional tool media; explicit user attachments still fail loudly. */
    omittedCount?: number;
};
export type CursorPromptImageExtraction = CursorHistoryImageExtraction & {
    userImageCount: number;
};
export declare function hasCursorUserImages(lastUser: Record<string, unknown> | undefined): boolean;
export declare function assertCursorUserImageSupport(lastUser: Record<string, unknown> | undefined, supportsImages: boolean, modelId: string): void;
export declare function extractCursorUserImages(lastUser: Record<string, unknown> | undefined, signal?: AbortSignal, maxBytes?: number): Promise<CursorImageInput[]>;
export declare function extractCursorHistoryImages(prompt: readonly unknown[], options: {
    supportsImages: boolean;
    seenHashes?: ReadonlySet<string>;
    signal?: AbortSignal;
    maxBytes?: number;
    filenameOffset?: number;
}): Promise<CursorHistoryImageExtraction>;
/**
 * Decode the images a host tool returned (its own `file-data` / `image-data`
 * parts, or the `file` parts OpenCode moves into the trailing
 * `Attached media from tool result:` message) for a held-Run exec result.
 * Non-image parts are skipped; a part that cannot be decoded is dropped so the
 * text result is still delivered.
 */
export declare function extractCursorToolResultImages(parts: readonly unknown[], options?: {
    signal?: AbortSignal;
    maxBytes?: number;
    maxImages?: number;
}): Promise<{
    images: CursorImageInput[];
    hashes: string[];
    omittedCount: number;
}>;
export declare function extractCursorPromptImages(prompt: readonly unknown[], lastUser: Record<string, unknown> | undefined, options: {
    supportsImages: boolean;
    seenHistoryHashes?: ReadonlySet<string>;
    signal?: AbortSignal;
    maxBytes?: number;
}): Promise<CursorPromptImageExtraction>;
