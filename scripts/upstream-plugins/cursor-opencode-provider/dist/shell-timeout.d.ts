/** Cursor agent.v1 TimeoutBehavior enum values. */
export declare const CURSOR_TIMEOUT_CANCEL = 1;
export declare const CURSOR_TIMEOUT_BACKGROUND = 2;
/** Private marker for Cursor `background_shell_spawn_args` detach wrappers. */
export declare const BACKGROUND_SHELL_MARKER = "__CURSOR_BACKGROUND_SHELL__";
export type CursorShellPolicy = {
    command: string;
    workingDirectory: string;
    timeoutMs: number;
    timeoutBehavior: number;
    hardTimeoutMs?: number;
    /** Immediate nohup detach for Cursor `background_shell_spawn_args`. */
    backgroundSpawn?: boolean;
    description?: string;
    managedCommand?: string;
    managedJobDirectory?: string;
    shellPath?: string;
};
export type CursorShellOutcome = {
    kind: "exit";
    code: number;
} | {
    kind: "aborted";
} | {
    kind: "timeout";
    timeoutMs: number;
} | {
    kind: "backgrounded";
    shellId: number;
    pid: number;
    command: string;
    workingDirectory: string;
    msToWait: number;
    reason: 1;
    /** Managed terminal record holding the command's output. */
    outputFile?: string;
};
/**
 * Serialize OpenCode 2 shell creates onto their owning tool call. Call from
 * `execute.before` after `prepareCursorShellArgs`, passing the hook event the
 * host later executes. Every call arms, so an ordinary call cannot take a
 * wrapped call's adapter; `prepareCursorShellCreate` releases the holder at
 * its create. Only a create whose command a `create.before` hook rewrote
 * cannot be attributed; that call keeps its own command's lane until
 * `execute.after` or its failure.
 */
export declare function armCursorShellCreate(toolCallId: string, call: {
    readonly input: unknown;
}): Promise<void>;
/** Release a create-before arm when the call is claimed, fails, or finishes. */
export declare function disarmCursorShellCreate(toolCallId: string): void;
/** Track OpenCode's configured shell from the classic config hook. */
export declare function setCursorShellPath(shell: string | undefined, directory?: string): void;
/** The executable selected by native OpenCode config, with its POSIX fallback. */
export declare function resolveCursorShellPath(shell?: string, directory?: string): string;
/**
 * Mirror the relevant part of OpenCode Shell.acceptable(): fish/nu are denied,
 * then POSIX falls back to bash when installed and `/bin/sh` otherwise.
 */
export declare function resolveCursorShellKind(shell?: string | undefined): "bash" | "zsh" | "sh" | "dash" | "other";
export declare function shellPolicyFromMetadata(metadata: Record<string, unknown> | undefined): CursorShellPolicy | undefined;
/** Register a Cursor shell request before OpenCode executes its emitted tool call. */
export declare function registerCursorShellCall(toolCallId: string, metadata: Record<string, unknown> | undefined): void;
/**
 * F11 / soft-background helper.
 *
 * Run a Cursor soft-background command for its foreground window, then leave
 * it detached (`nohup`) if still alive. The sentinel is removed by the after
 * hook before OpenCode stores/renders the result.
 *
 * This approximates Cursor's TIMEOUT_BACKGROUND semantics through OpenCode's
 * foreground-only bash tool. Residual: after OpenCode returns, the child (and
 * optional hard-timeout watchdog) may still be running; this provider does not
 * reap leftover processes — cleanup is left to the user / OS.
 */
export declare function buildSoftBackgroundCommand(policy: CursorShellPolicy): string;
/**
 * F11 / background_shell_spawn_args helper.
 *
 * OpenCode's bash tool is foreground-only. Detach the requested command inside
 * that one foreground call (`nohup … &`) and print a private marker containing
 * the spawned PID and log path. With stdin and all output redirected, the host
 * shell can return immediately instead of retaining OpenCode's tool pipe.
 *
 * Residual: the detached child is not reaped by this provider after OpenCode
 * completes the tool call; cleanup is left to the user / OS.
 */
export declare function buildBackgroundShellCommand(command: string, shellPath?: string): string;
/**
 * Prepare OpenCode Bash args before execution when Cursor requested wrapping.
 *
 * bash/zsh source the shell.env injector, so the original command remains in
 * OpenCode's permission/UI state. sh/dash ignore those startup variables;
 * managed jobs expose the complete launcher and payload for host approval.
 *
 * background_shell_spawn may already contain the inline non-plugin fallback.
 * The classic hook replaces it with the original command (bash/zsh) or the
 * inline managed launcher (sh/dash), avoiding duplicate execution.
 */
export declare function prepareCursorShellArgs(toolCallId: string, args: Record<string, unknown>, options?: {
    preferWrapperCommand?: boolean;
    deferToShellHook?: boolean;
    shellPath?: string;
}): void;
/** Restore the model-facing command in OpenCode's completed tool title. */
export declare function cursorShellOriginalCommand(toolCallId: string): string | undefined;
/** Drop injector temp files for a finished/abandoned Cursor shell call. */
export declare function releaseCursorShellEnv(toolCallId: string): void;
/**
 * Env vars for OpenCode's shell.env hook. bash/zsh execute the injector; the
 * same materialized wrapper backs the direct-command sh/dash fallback.
 */
export declare function cursorShellEnvForCall(toolCallId: string | undefined): Record<string, string> | undefined;
/**
 * OpenCode 2.0.27 calls create.before before its permission scanner, then
 * spawns the selected executable with [-c, command]. Preserve that command
 * and the shell basename the scanner uses. The adapter runs only after host
 * approval, and uses the host's selected executable for the actual payload.
 * Sources: upstream packages/core/src/shell.ts:274-305 and
 * packages/core/src/tool/plugin/shell.ts:125-145 at v2.0.27.
 */
export declare function prepareCursorShellCreate(event: {
    command: string;
    cwd: string;
    shell: string;
    env: Record<string, string | undefined>;
}): void;
/**
 * Turn a stored timeout display back into OpenCode's own timeout block, so a
 * replayed result parses as the timeout it was after its saved outcome is gone.
 */
export declare function restoreOpenCodeTimeout(display: string, timeoutMs: number): string;
/** The timeout recorded for a call whose result has not been consumed yet. */
export declare function cursorShellTimeoutMs(toolCallId: string): number | undefined;
/**
 * Strip private wrapper sentinels / OpenCode timeout envelopes for display.
 * Does not record outcomes — use {@link captureCursorShellResult} for that.
 *
 * OpenCode 2.0 `Tool.Result.output` is structured (an object for shell), not
 * a string. Non-string input is returned unchanged so the 2.0 after-hook can
 * pass structured output through safely.
 */
export declare function sanitizeCursorShellDisplayOutput(output: string, policy?: CursorShellPolicy, capturedOutcome?: CursorShellOutcome): string;
/** Sanitize a secondary display string (e.g. Bash `metadata.output`) for a registered call. */
export declare function sanitizeRegisteredCursorShellOutput(toolCallId: string, output: string): string;
/**
 * Capture Bash completion in the classic plugin's after hook. Returns the
 * sanitized output that OpenCode should store and render.
 *
 * Guards non-string output (OpenCode 2.0 structured `Tool.Result.output`)
 * by returning it unchanged.
 */
export declare function captureCursorShellResult(toolCallId: string, output: string, metadata?: Record<string, unknown>): string;
/** Record the host's authoritative error status, even if its SDK drops that flag. */
export declare function captureCursorShellFailure(toolCallId: string, error: unknown): void;
/** Consume the structured result, with an inline fallback when no plugin hook ran. */
export declare function consumeCursorShellResult(toolCallId: string, output: string): {
    output: string;
    outcome?: CursorShellOutcome;
    error?: string;
};
/** Test/process cleanup. */
export declare function resetCursorShellCalls(): void;
