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
};
export type CursorShellOutcome = {
    kind: "exit";
    code: number;
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
};
/** Track OpenCode's configured shell from the classic config hook. */
export declare function setCursorShellPath(shell: string | undefined): void;
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
export declare function buildBackgroundShellCommand(command: string): string;
/**
 * Prepare OpenCode Bash args before execution when Cursor requested wrapping.
 *
 * bash/zsh source the shell.env injector, so the original command remains in
 * OpenCode's permission/UI state. sh/dash ignore those startup variables; for
 * them, use a short `exec wrapper.sh` command that contains no user payload.
 *
 * background_shell_spawn may already contain the inline non-plugin fallback.
 * The classic hook replaces it with the original command (bash/zsh) or the
 * shorter wrapper-file command (sh/dash), avoiding duplicate execution.
 */
export declare function prepareCursorShellArgs(toolCallId: string, args: Record<string, unknown>, options?: {
    preferWrapperCommand?: boolean;
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
 * OpenCode 2.0 `shell.create.before` has no tool-call id. Correlate the pending
 * wrap by command + working directory when possible, then fall back to the
 * original command for hosts that omit the directory.
 */
export declare function cursorShellEnvForCommand(command: string | undefined, workingDirectory?: string): Record<string, string> | undefined;
/**
 * Strip private wrapper sentinels / OpenCode timeout envelopes for display.
 * Does not record outcomes — use {@link captureCursorShellResult} for that.
 *
 * OpenCode 2.0 `Tool.Result.output` is structured (an object for shell), not
 * a string. Non-string input is returned unchanged so the 2.0 after-hook can
 * pass structured output through safely.
 */
export declare function sanitizeCursorShellDisplayOutput(output: string, policy?: CursorShellPolicy): string;
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
/** Consume the structured result, with an inline fallback when no plugin hook ran. */
export declare function consumeCursorShellResult(toolCallId: string, output: string): {
    output: string;
    outcome?: CursorShellOutcome;
};
/** Test/process cleanup. */
export declare function resetCursorShellCalls(): void;
