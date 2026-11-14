import { CURSOR_IMAGE_INPUT } from "./image-input-data.js";
import { CURSOR_MODEL_CONTEXTS } from "./pricing-data.js";
export function getDocumentedCursorModelContext(modelId) {
    const context = CURSOR_MODEL_CONTEXTS[modelId];
    return context ? { ...context } : undefined;
}
/**
 * Image input only where our live probe saw the model's Run read an image
 * (`bun run generate:images`). Cursor's AvailableModels flag is not used.
 */
export function cursorModelReadsImages(modelId) {
    return CURSOR_IMAGE_INPUT[modelId] === true;
}
