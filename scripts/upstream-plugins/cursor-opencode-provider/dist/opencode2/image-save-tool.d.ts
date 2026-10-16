import type { PluginContext, ToolDraft } from "./types.js";
/**
 * Register the handle-only image commit tool on the OpenCode 2.0 direct
 * catalog. Catalog `permission: "edit"` hides it when the host agent denies
 * edits. Per-call `ask` is used when the runtime context provides it;
 * otherwise containment still gates the write (opaque `image_id` only).
 */
export declare function registerCursorImageSaveTool(draft: ToolDraft, ctx: PluginContext): void;
