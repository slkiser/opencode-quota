import type { ToolDraft } from "./types.js";
/**
 * OpenCode 2 snapshot: only `codemode === false` tools join the AI SDK catalog.
 * Everything else is Code Mode-only (`packages/core/src/tool.ts` direct vs
 * `codeModeTools`). Plugin-owned todo tools must opt into the direct catalog so
 * Cursor can execute them without going through Code Mode.
 */
export declare const OPENCODE2_DIRECT_TOOL_OPTIONS: {
    readonly codemode: false;
};
/**
 * Force-enable plugin-owned `todowrite` / `todoread` on OpenCode 2.0.
 * Default is off: the host has no TUI/desktop checklist, so advertising
 * these in-memory tools is opt-in. OpenCode 1.x is unaffected (host builtin).
 * Same truthy rule as `CURSOR_PROVIDER_DEBUG` (`1` or `true`).
 */
export declare const CURSOR_OPENCODE2_TODOS_ENV = "CURSOR_OPENCODE2_TODOS";
export declare function isOpenCode2TodosEnabled(env?: NodeJS.ProcessEnv): boolean;
/**
 * 1.x `todowrite` description, shortened. OpenCode 2 has no builtin todo
 * tools; this is the catalog text the model sees when the 2.0 gate is on.
 */
export declare const TODOWRITE_DESCRIPTION = "Create and maintain a structured task list for the current coding session. Tracks progress, organizes multi-step work, and surfaces status to the user.\n\nUse proactively when the work is 3+ distinct steps, non-trivial, or the user lists multiple tasks. Skip single straightforward edits and purely informational questions.\n\nStates: pending, in_progress (exactly one at a time), completed, cancelled.\nUpdate status as you go. Mark completed only after the work \u2014 including verification \u2014 is actually done.";
export declare const TODOREAD_DESCRIPTION = "Read the current session todo list. Takes no arguments. Returns the full list as JSON.";
export declare const TODO_OUTPUT_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly properties: {
        readonly todos: {
            readonly type: "array";
            readonly items: {
                readonly type: "object";
                readonly additionalProperties: false;
                readonly properties: {
                    readonly id: {
                        readonly type: "string";
                    };
                    readonly content: {
                        readonly type: "string";
                    };
                    readonly status: {
                        readonly type: "string";
                        readonly enum: readonly ["pending", "in_progress", "completed", "cancelled"];
                    };
                    readonly priority: {
                        readonly type: "string";
                        readonly enum: readonly ["high", "medium", "low"];
                    };
                };
                readonly required: readonly ["id", "content", "status", "priority"];
            };
        };
    };
    readonly required: readonly ["todos"];
};
/** True when the host editor already owns this tool id. */
export declare function hostHasTool(draft: ToolDraft, name: string): boolean;
/**
 * Register canonical `todowrite` / `todoread` when the 2.0 force-enable gate
 * is on and the host catalog does not already advertise them. No-op when the
 * gate is off (default), on OpenCode 1.x (this function is not called), and
 * on any 2.x host that restores the tools.
 */
export declare function registerTodoTools(draft: ToolDraft): void;
