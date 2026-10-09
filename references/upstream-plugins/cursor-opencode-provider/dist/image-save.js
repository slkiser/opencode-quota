/**
 * Commit a staged Cursor image to disk, gated by OpenCode's own permission.
 *
 * Host-neutral on purpose: `./image-save-tool.ts` performs the `tool()` value
 * import from `@opencode-ai/plugin`, which the OpenCode 2.0 entrypoint must not
 * pull in (see the note in `./web-search-tool.ts`). Only that file may import
 * the plugin package; this module is safe on every graph.
 */
import fs from "node:fs";
import path from "node:path";
import { errorMessage, trace } from "./debug.js";
import { takePendingCursorImage } from "./image-staging.js";
/**
 * Marks a refusal that must reach Cursor as `WriteResult.permission_denied`
 * rather than a generic error — the variant its own executor returns and its
 * agent branches on. Both sides of this string are ours, so matching on it is
 * a contract, not a guess at someone else's message.
 */
export const IMAGE_PERMISSION_DENIED_PREFIX = "CursorImagePermissionDenied:";
/**
 * Prove the staged target still resolves inside one of the roots it was mapped
 * into. `remapCursorImageWritePath` already chose the location; this re-checks
 * it against the *real* paths, because a symlink planted between mapping and
 * commit could otherwise redirect the write. Mirrors the containment rule the
 * correlated-edit read applies before answering with complete file content.
 */
export function resolveContainedImagePath(target, allowedRoots) {
    const roots = allowedRoots.filter(Boolean).map((root) => path.resolve(root));
    if (roots.length === 0)
        return { error: "no writable root is configured" };
    const absolute = path.isAbsolute(target) ? path.resolve(target) : path.resolve(roots[0], target);
    // The file need not exist yet; its closest existing ancestor must still
    // resolve inside an allowed root.
    let probe = absolute;
    let realProbe;
    while (true) {
        try {
            realProbe = fs.realpathSync(probe);
            break;
        }
        catch {
            const parent = path.dirname(probe);
            if (parent === probe)
                break;
            probe = parent;
        }
    }
    if (realProbe === undefined)
        return { error: "target path could not be resolved" };
    const suffix = path.relative(probe, absolute);
    const realTarget = suffix ? path.join(realProbe, suffix) : realProbe;
    for (const root of roots) {
        let realRoot;
        try {
            realRoot = fs.realpathSync(root);
        }
        catch {
            realRoot = root;
        }
        const relative = path.relative(realRoot, realTarget);
        if (relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
            // Report the root as the caller supplied it (resolved but not realpathed)
            // so callers can compare it against their own roots — on macOS a temp dir
            // realpaths from /var to /private/var and would never match otherwise.
            return { path: realTarget, relative, root };
        }
    }
    return { error: "target path resolves outside the workspace and project folder" };
}
/**
 * Resolve a root the same way the target was resolved. Comparing a realpath
 * target against a lexical root misreads a symlinked project root (macOS
 * /var → /private/var, or a worktree reached through a link) as external.
 */
function realRoot(root) {
    const resolved = path.resolve(root);
    try {
        return fs.realpathSync(resolved);
    }
    catch {
        return resolved;
    }
}
/**
 * Mirror of OpenCode's `containsPath`: a target inside the session directory or
 * worktree is internal. A worktree of `/` is skipped there because it would
 * match every absolute path and silently disable the external gate.
 */
function isInsideProject(target, worktree, directory) {
    for (const root of [directory, worktree]) {
        if (!root || root === "/")
            continue;
        const relative = path.relative(realRoot(root), target);
        if (relative === "")
            return true;
        if (relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
            return true;
    }
    return false;
}
/**
 * Execute the commit. `image_id` is the only input: the path and bytes come
 * from this process's staging table, so a caller without a real handle — the
 * model of any provider, replaying a used id, or guessing — writes nothing.
 */
export async function executeCursorImageSave(args, ctx) {
    const imageId = typeof args.image_id === "string" ? args.image_id : "";
    if (!imageId)
        throw new Error("No image id was provided, so there is nothing to save.");
    const image = takePendingCursorImage(imageId);
    if (!image) {
        // Expired, already committed, or never existed. Identical response for all
        // three: nothing here should confirm whether an id was ever valid.
        throw new Error("No pending Cursor image matches that id. It may have already been saved or expired.");
    }
    const workspace = ctx.worktree || ctx.directory;
    const contained = resolveContainedImagePath(image.path, [image.projectDir, workspace].filter((root) => !!root));
    if ("error" in contained) {
        trace(`image save: refused path=${JSON.stringify(image.path)} reason=${contained.error}`);
        throw new Error(`Refusing to save the generated image: ${contained.error}.`);
    }
    // Mirror what OpenCode's own `write` tool does, in the same order: an
    // external-directory gate for targets outside the project, then the `edit`
    // permission. Cursor writes generated images into the project folder, which
    // is under the host cache and therefore *outside* the worktree — exactly the
    // case `assertExternalDirectory` exists for. Asking only for `edit` would
    // quietly skip a boundary the host enforces for every one of its own writes.
    const editPattern = path.relative(realRoot(workspace), contained.path);
    if (typeof ctx.ask === "function") {
        try {
            if (!isInsideProject(contained.path, workspace, ctx.directory)) {
                const parentDir = path.dirname(contained.path);
                const glob = path.join(parentDir, "*").replaceAll("\\", "/");
                await ctx.ask({
                    permission: "external_directory",
                    patterns: [glob],
                    always: [glob],
                    metadata: { filepath: contained.path, parentDir },
                });
            }
            await ctx.ask({
                permission: "edit",
                patterns: [editPattern],
                always: ["*"],
                metadata: {
                    filepath: contained.path,
                    mime: image.mime,
                    bytes: image.data.length,
                    source: "cursor-generate-image",
                },
            });
        }
        catch (error) {
            const reason = errorMessage(error);
            trace(`image save: permission refused path=${JSON.stringify(contained.path)} reason=${reason}`);
            throw new Error(`${IMAGE_PERMISSION_DENIED_PREFIX} ${reason}`);
        }
    }
    else if (ctx.ask === null) {
        trace(`image save: host cannot prompt; writing after containment ` +
            `path=${JSON.stringify(contained.path)}`);
    }
    else {
        const reason = "this host did not provide a permission prompt for the write";
        trace(`image save: permission refused path=${JSON.stringify(contained.path)} reason=${reason}`);
        throw new Error(`${IMAGE_PERMISSION_DENIED_PREFIX} ${reason}`);
    }
    // Cursor writes generated images into an `assets/` subdirectory that will not
    // exist on a first generation, so the parent chain is created here — after
    // the permission, so a refusal leaves no directories behind.
    const directory = path.dirname(contained.path);
    try {
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(contained.path, image.data);
    }
    catch (error) {
        // Most often something already occupies a path component (EEXIST/ENOTDIR).
        // Say which path is blocked; the raw errno alone tells the model nothing.
        const reason = errorMessage(error);
        trace(`image save: write failed path=${JSON.stringify(contained.path)} reason=${reason}`);
        throw new Error(`Could not save the generated image to ${contained.path}: ${reason}. `
            + `Check that ${directory} is a writable directory.`);
    }
    trace(`image save: wrote path=${JSON.stringify(contained.path)} ` +
        `bytes=${image.data.length} mime=${image.mime}`);
    // No `attachments`, deliberately. OpenCode gates media-in-tool-result on an
    // allowlist of `model.api.npm` values (@ai-sdk/anthropic, @ai-sdk/openai, …)
    // that no third-party provider can join, so an image attachment is always
    // "extracted to be sent as a separate user message" (message-v2.ts:299-305).
    // That trailing user message makes the next turn stop looking like a tool
    // continuation, so the provider opens a fresh Run and Cursor never receives
    // the write result it is waiting for — observed live: the Run was superseded
    // with pending=1 and a full 1.7 MB rebase was paid. Text only keeps the
    // held-Run contract intact; the file is on disk and Cursor holds the image
    // server-side already.
    return {
        title: editPattern,
        output: `Saved the generated image to ${contained.path} (${image.data.length} bytes).`,
        bytes: image.data.length,
    };
}
