/**
 * Synthesis of OpenCode `apply_patch` (2.0: `patch`) envelopes from Cursor's
 * native write/edit exec requests.
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
 * - OpenCode 2.0 (`packages/core`) keeps the gate under a new name. The tool is
 *   `patch` (still `{ patchText }`, same envelope format), and
 *   `tool/plugin/patch.ts` applies the same model-id predicate in its session
 *   `context`/`compaction`/`generate` hooks, deleting `edit` and `write` for GPT models and
 *   `patch` for everyone else. Both names are recognised here; which one the
 *   host offers is read from the advertised set rather than a version check.
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
 * ## Format notes (verified against `packages/opencode/src/patch/index.ts` and 2.0's `packages/util/src/patch.ts`)
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
 * - `Add File` content is rejoined with `\n`; the tool appends a final newline
 *   only when nonempty content lacks one. Keep the trailing empty payload line
 *   so blank lines survive. Nonempty unterminated content cannot round-trip.
 * - OpenCode 2's `patch` parser strips a trailing `\r` from every payload
 *   line, unlike 1.x `apply_patch`. Refuse that lossy encoding on `patch`.
 * - Update chunks match **whole lines** via `seekSequence`, unlike OpenCode
 *   `edit`, which is substring-based. Substring edits must be expanded to line
 *   boundaries before they can be expressed as a patch — see `planSubstringEdit`.
 * - Cursor's write/edit requests never rename, so `*** Move to:` is never
 *   emitted here.
 */
/** OpenCode 1.x name for the patch tool. */
export declare const APPLY_PATCH_TOOL = "apply_patch";
/** OpenCode 2.0 name for the same tool (renamed from `apply_patch`). */
export declare const PATCH_TOOL = "patch";
export type HostPatchTool = typeof APPLY_PATCH_TOOL | typeof PATCH_TOOL;
/** The patch tool this host advertises in place of `edit`/`write`, if any. */
export declare function hostPatchTool(advertised: ReadonlySet<string>): HostPatchTool | undefined;
export declare function isHostPatchTool(name: string): name is HostPatchTool;
/** One `@@` chunk: replace `oldLines` with `newLines`. */
export type UpdateChunk = {
    oldLines: string[];
    newLines: string[];
};
/**
 * Whole-file write as `*** Add File:`. Valid whether or not the target exists —
 * OpenCode's add case overwrites unconditionally.
 */
export declare function buildAddFilePatch(filePath: string, content: string, tool?: HostPatchTool): string;
/** Targeted replacement as `*** Update File:` with one `@@` chunk per change. */
export declare function buildUpdateFilePatch(filePath: string, chunks: UpdateChunk[], tool?: HostPatchTool): string;
export type SubstringEditPlan = {
    ok: true;
    chunks: UpdateChunk[];
} | {
    ok: false;
    reason: string;
};
/**
 * Expand a substring replacement to the whole lines it touches, because
 * `apply_patch` matches line sequences rather than substrings.
 *
 * Refuses rather than guessing: an absent match, or an ambiguous one without
 * `replaceAll`, would otherwise be silently applied to the wrong region.
 */
export declare function planSubstringEdit(source: string, oldString: string, newString: string, replaceAll?: boolean): SubstringEditPlan;
