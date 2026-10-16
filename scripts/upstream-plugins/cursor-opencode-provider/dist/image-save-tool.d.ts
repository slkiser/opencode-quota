import { executeCursorImageSave } from "./image-save.js";
/** Build the classic OpenCode image-save tool with the host's own Zod helper. */
export declare function createCursorImageSaveTool(factory: {
    tool: (input: Record<string, unknown>) => Record<string, unknown>;
    schema: {
        string: () => any;
    };
}): Record<string, unknown>;
/** Host-neutral JSON-schema fallback for hosts with no classic helper. */
export declare const cursorImageSaveTool: {
    description: string;
    args: {
        image_id: {
            type: string;
            description: string;
        };
    };
    execute: typeof executeCursorImageSave;
};
