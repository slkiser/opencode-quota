/**
 * Synthesis of OpenCode `apply_patch` envelopes from Cursor's native write/edit
 * exec requests.
 *
 * ## Why this exists
 *
 * OpenCode 1.x does not merely *add* `apply_patch` for GPT models — it removes
 * `edit` and `write` from the catalog in exchange. From
 * `packages/opencode/src/tool/registry.ts` (`ToolRegistry.tools`):
 *
 * ```ts
 * // use apply tool in same format as codex
 * const usePatch =
 *   input.modelID.includes("gpt-") && !input.modelID.includes("oss") && !input.modelID.includes("gpt-4")
 * if (tool.id === ApplyPatchTool.id) return usePatch
 * if (tool.id === EditTool.id || tool.id === WriteTool.id) return !usePatch
 * ```
 *
 * The predicate runs on the *API* model id, so every Cursor `gpt-5*` model
 * matches (and, as a quirk of substring matching, `gpt-3.5-*` does too while
 * `gpt-4o` does not).
 *
 * Upstream context, in case this ever needs revisiting:
 *
 * - Introduced by opencode PR #9127 ("apply_patch tool for openai models"). The
 *   intent is to hand GPT/Codex models the tool surface they were post-trained
 *   on; the same commit tells the codex system prompt to prefer `apply_patch`.
 * - The *exclusivity* is deliberate. On opencode issue #34491 a maintainer
 *   describes the gate as a "band-aid", "intentionally minimal", whose purpose
 *   is that "GPT no longer receives edit + write + apply_patch simultaneously",
 *   and notes that a plugin-side opt-out "isn't feasible today".
 * - opencode issue #19942 reported exactly this hazard — model-conditional tool
 *   substitution makes model-agnostic integrations impossible — and was closed
 *   `not_planned` by a stale bot.
 * - opencode issue #35408 (open, milestone 2.0) proposes a
 *   `ctx.session.context(...)` hook exposing a mutable tool roster, and lists
 *   "Select `apply_patch` versus `edit` + `write`" as work to move out of the
 *   registry. Once that lands, a host-side opt-out replaces this shim.
 * - OpenCode 2.0 (`packages/core`) has **no** such gate: `apply_patch`, `edit`
 *   and `write` are all registered unconditionally in `tool/builtins.ts`. This
 *   translation is therefore 1.x-only in practice, but it is keyed off the
 *   advertised set rather than a version check, so it simply never fires on 2.0.
 *
 * ## Why translation, not advertisement
 *
 * `toolsToDescriptors` forwards every advertised host tool to Cursor verbatim,
 * so `opencode-apply_patch` already appears in Cursor's catalog whenever
 * OpenCode advertises it, and an `mcp_args` call naming it already executes.
 * What breaks is Cursor's *native* write/edit channel (`write_args`,
 * `pi_edit_args`), which this provider resolves to the fixed host names
 * `write`/`edit`.
 *
 * Translating on our side is the only option: Cursor's agent protocol has no
 * patch-format edit tool at all (its `ToolCall` oneof offers whole-file
 * `edit_tool_call`/`write_args` and substring `pi_edit_tool_call`/`pi_edit_args`;
 * `apply_agent_diff_tool_call` is unrelated — it applies a cloud agent's diff by
 * `agent_id`). Cursor's CLI also contains no model-conditional branching
 * whatsoever, and `ModelDetails` carries no tool-capability flags, so the same
 * native requests arrive for every model. Those names are absent from
 * the catalog, so the request is refused before it reaches OpenCode.
 *
 * ## Format notes (verified against `packages/opencode/src/patch/index.ts`)
 *
 * - `*** Add File:` **overwrites an existing file** — the tool's `add` case uses
 *   `oldContent = ""` and never stats the target (upstream test: "adds file
 *   overwriting existing file"). A whole-file write therefore needs no diff and
 *   no existence check.
 * - An empty `@@` header is a valid chunk start: the parser stores
 *   `change_context: contextLine || undefined`, and a missing context simply
 *   means "match `old_lines` from the current scan position".
 * - Every payload line is prefixed with `+`, `-`, or a space, and the parser
 *   only breaks on *unprefixed* `***` / `@@`. Content lines that themselves
 *   begin with `***` or `@@` therefore survive a round trip unharmed.
 * - `Add File` content is rejoined with `\n` and normalized to exactly one
 *   trailing newline. A write of content with no trailing newline gains one.
 * - Update chunks match **whole lines** via `seekSequence`, unlike OpenCode
 *   `edit`, which is substring-based. Substring edits must be expanded to line
 *   boundaries before they can be expressed as a patch — see `planSubstringEdit`.
 * - Renames are rejected by OpenCode 2.0's implementation ("apply_patch moves
 *   are not supported yet"), so `*** Move to:` is never emitted here.
 */
export const APPLY_PATCH_TOOL = "apply_patch";
const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
/**
 * Whole-file write as `*** Add File:`. Valid whether or not the target exists —
 * OpenCode's add case overwrites unconditionally.
 */
export function buildAddFilePatch(filePath, content) {
    const lines = splitLines(content);
    return [BEGIN, `*** Add File: ${filePath}`, ...lines.map((line) => `+${line}`), END].join("\n");
}
/** Targeted replacement as `*** Update File:` with one `@@` chunk per change. */
export function buildUpdateFilePatch(filePath, chunks) {
    const body = [];
    for (const chunk of chunks) {
        body.push("@@");
        for (const line of chunk.oldLines)
            body.push(`-${line}`);
        for (const line of chunk.newLines)
            body.push(`+${line}`);
    }
    return [BEGIN, `*** Update File: ${filePath}`, ...body, END].join("\n");
}
/**
 * Expand a substring replacement to the whole lines it touches, because
 * `apply_patch` matches line sequences rather than substrings.
 *
 * Refuses rather than guessing: an absent match, or an ambiguous one without
 * `replaceAll`, would otherwise be silently applied to the wrong region.
 */
export function planSubstringEdit(source, oldString, newString, replaceAll = false) {
    if (oldString === "")
        return { ok: false, reason: "the text to replace is empty" };
    const offsets = [];
    for (let at = source.indexOf(oldString); at !== -1; at = source.indexOf(oldString, at + oldString.length)) {
        offsets.push(at);
    }
    if (offsets.length === 0)
        return { ok: false, reason: "the text to replace was not found in the file" };
    if (offsets.length > 1 && !replaceAll) {
        return {
            ok: false,
            reason: `the text to replace appears ${offsets.length} times; it must be unique`,
        };
    }
    const targets = replaceAll ? offsets : offsets.slice(0, 1);
    const chunks = [];
    let previousEnd = -1;
    for (const offset of targets) {
        const start = lineStart(source, offset);
        const end = lineEnd(source, offset + oldString.length);
        // Overlapping expansions would emit the same original lines twice, and the
        // second chunk could never match after the first replaced them.
        if (start < previousEnd) {
            return { ok: false, reason: "overlapping replacements cannot be expressed as a patch" };
        }
        previousEnd = end;
        const before = source.slice(start, offset);
        const after = source.slice(offset + oldString.length, end);
        chunks.push({
            oldLines: splitLines(source.slice(start, end)),
            newLines: splitLines(before + newString + after),
        });
    }
    return { ok: true, chunks };
}
/**
 * Split into patch payload lines. A trailing newline is dropped so it is not
 * emitted as a spurious empty line — OpenCode re-adds exactly one on apply.
 */
function splitLines(text) {
    const normalized = text.endsWith("\n") ? text.slice(0, -1) : text;
    return normalized.split("\n");
}
function lineStart(source, offset) {
    const at = source.lastIndexOf("\n", offset - 1);
    return at === -1 ? 0 : at + 1;
}
function lineEnd(source, offset) {
    const at = source.indexOf("\n", offset);
    return at === -1 ? source.length : at;
}
