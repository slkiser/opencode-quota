/**
 * Cursor-native GenerateImage.
 *
 * Cursor generates the image on its own servers, then writes it to the client
 * exactly like any other file — Cursor CLI's agent issues
 * `WriteArgs{path, file_bytes, return_file_content_after_write: false}` to
 * `<artifactsFolder|projectFolder>/assets/<basename(file_path)>` and reads the
 * client's `WriteResult` back, checking for `permission_denied`
 * (`agent-cli-local/src/index.ts:84752-84776`).
 *
 * The display `generate_image_tool_call.result.image_data` is **not** the write
 * channel: the CLI feeds it to its terminal preview cache and falls back to
 * reading the path off disk, so the file already exists by then. Never write
 * from that frame — the bytes would be written twice.
 *
 * So the client-side work is: approve the interaction, then honour a binary
 * write. OpenCode's `write` tool cannot carry bytes (string content, BOM split,
 * diff, `Format.file()`), so the bytes are staged (`../image-staging.ts`) and
 * committed by the `cursor_image_save` plugin tool, which raises OpenCode's
 * `edit` permission. A refusal returns Cursor's own `permission_denied`.
 */
import path from "node:path";
import { decodeMessageSparse } from "./messages.js";
/** Host tool id that commits a staged image. Registered by the classic plugin. */
export const CURSOR_IMAGE_SAVE_TOOL = "cursor_image_save";
/** Cursor's agent always writes generated images into this subdirectory. */
export const CURSOR_IMAGE_ASSETS_DIR = "assets";
const IMAGE_MIME_BY_EXTENSION = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
};
/** Prefer encoded bytes: Cursor can send JPEG data with a .png target name. */
export function imageMimeForPath(filePath, data) {
    if (data) {
        const matches = (signature, offset = 0) => signature.every((byte, index) => data[offset + index] === byte);
        if (matches([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
            return "image/png";
        if (matches([0xff, 0xd8, 0xff]))
            return "image/jpeg";
        if (matches([0x47, 0x49, 0x46, 0x38]) && (data[4] === 0x37 || data[4] === 0x39) && data[5] === 0x61) {
            return "image/gif";
        }
        if (matches([0x52, 0x49, 0x46, 0x46]) && matches([0x57, 0x45, 0x42, 0x50], 8))
            return "image/webp";
    }
    const dot = path.basename(filePath).lastIndexOf(".");
    if (dot <= 0)
        return "image/png";
    return IMAGE_MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? "image/png";
}
function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
}
function str(value) {
    return typeof value === "string" ? value : "";
}
/** Decode a `generate_image_request_query` body, or undefined when unusable. */
export function decodeGenerateImageQuery(queryBytes) {
    let decoded;
    try {
        decoded = decodeMessageSparse("GenerateImageRequestQuery", queryBytes);
    }
    catch {
        return undefined;
    }
    const args = asRecord(decoded.args);
    if (!args)
        return undefined;
    const description = str(args.description);
    if (!description)
        return undefined;
    return {
        description,
        filePath: str(args.file_path),
        referenceImagePaths: Array.isArray(args.reference_image_paths)
            ? args.reference_image_paths.filter((item) => typeof item === "string")
            : [],
        toolCallId: str(decoded.tool_call_id),
    };
}
function isInside(root, target) {
    const relative = path.relative(path.resolve(root), path.resolve(target));
    return relative !== "" && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
/**
 * Map Cursor's intended write target onto a real location under this host.
 *
 * Cursor composes the path from the `project_folder` this provider advertised,
 * so an untouched target already resolves under the host cache project
 * directory and is kept as-is. A target inside the workspace is also honoured
 * verbatim — that is a location the user can see. Anything else (a path built
 * from a folder we never advertised, or an attempted escape) is rebased onto
 * `<projectDir>/assets/<basename>` rather than refused, so the model still gets
 * a file where it expects one instead of a failed generation.
 */
export function remapCursorImageWritePath(target, roots) {
    const projectDir = path.resolve(roots.projectDir);
    const assets = path.join(projectDir, CURSOR_IMAGE_ASSETS_DIR);
    const fallback = path.join(assets, path.basename(target) || "generated-image.png");
    if (!target)
        return fallback;
    const absolute = path.isAbsolute(target) ? target : path.resolve(projectDir, target);
    if (isInside(projectDir, absolute))
        return path.resolve(absolute);
    if (roots.workspaceRoot && isInside(roots.workspaceRoot, absolute))
        return path.resolve(absolute);
    return fallback;
}
