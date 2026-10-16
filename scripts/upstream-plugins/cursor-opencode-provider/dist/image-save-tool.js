import { executeCursorImageSave } from "./image-save.js";
/** Build the classic OpenCode image-save tool with the host's own Zod helper. */
export function createCursorImageSaveTool(factory) {
    return factory.tool({
        description: "Save an image that Cursor generated during this session to its target path. "
            + "Takes only the id of an already-generated image — it cannot write arbitrary "
            + "files, and it is not a general-purpose file writer. You do not normally call "
            + "this: the Cursor provider issues it after an image is generated.",
        args: {
            image_id: factory.schema.string().describe("Id of the pending Cursor-generated image to save"),
        },
        execute: executeCursorImageSave,
    });
}
/** Host-neutral JSON-schema fallback for hosts with no classic helper. */
export const cursorImageSaveTool = {
    description: "Save an image that Cursor generated during this session to its target path. "
        + "Takes only the id of an already-generated image — it cannot write arbitrary "
        + "files, and it is not a general-purpose file writer. You do not normally call "
        + "this: the Cursor provider issues it after an image is generated.",
    args: {
        image_id: { type: "string", description: "Id of the pending Cursor-generated image to save" },
    },
    execute: executeCursorImageSave,
};
