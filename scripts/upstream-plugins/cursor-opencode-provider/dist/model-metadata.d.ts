export type CursorModelContext = {
    maxContext?: number;
    maxContextForMaxMode?: number;
};
export type CursorModelCapabilities = {
    supportsImages: boolean;
};
export declare function getDocumentedCursorModelContext(modelId: string): CursorModelContext | undefined;
export declare function getDocumentedCursorModelCapabilities(modelId: string): CursorModelCapabilities | undefined;
export declare function resolveCursorModelSupportsImages(modelId: string, availableModelsValue?: boolean): boolean;
