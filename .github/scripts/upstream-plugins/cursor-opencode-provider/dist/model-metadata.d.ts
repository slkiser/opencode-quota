export type CursorModelContext = {
    maxContext?: number;
    maxContextForMaxMode?: number;
};
export declare function getDocumentedCursorModelContext(modelId: string): CursorModelContext | undefined;
/**
 * Image input only where our live probe saw the model's Run read an image
 * (`bun run generate:images`). Cursor's AvailableModels flag is not used.
 */
export declare function cursorModelReadsImages(modelId: string): boolean;
