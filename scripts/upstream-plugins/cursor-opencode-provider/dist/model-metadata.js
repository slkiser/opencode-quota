import { CURSOR_MODEL_CAPABILITIES, CURSOR_MODEL_CONTEXTS } from "./pricing-data.js";
export function getDocumentedCursorModelContext(modelId) {
    const context = CURSOR_MODEL_CONTEXTS[modelId];
    return context ? { ...context } : undefined;
}
export function getDocumentedCursorModelCapabilities(modelId) {
    const capabilities = CURSOR_MODEL_CAPABILITIES[modelId];
    return capabilities ? { ...capabilities } : undefined;
}
export function resolveCursorModelSupportsImages(modelId, availableModelsValue) {
    return availableModelsValue ?? getDocumentedCursorModelCapabilities(modelId)?.supportsImages ?? false;
}
