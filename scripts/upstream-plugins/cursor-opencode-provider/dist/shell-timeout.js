import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
/** Cursor agent.v1 TimeoutBehavior enum values. */
export const CURSOR_TIMEOUT_CANCEL = 1;
export const CURSOR_TIMEOUT_BACKGROUND = 2;
const MAX_TRACKED_SHELL_CALLS = 512;
const OPENCODE_TIMEOUT_GRACE_MS = 15_000;
const POLL_INTERVAL_MS = 100;
const BACKGROUND_MARKER = "__CURSOR_SHELL_BACKGROUND__";
const EXIT_MARKER = "__CURSOR_SHELL_EXIT__";
const TIMEOUT_MARKER = "__CURSOR_SHELL_TIMEOUT__";
/** Private marker for Cursor `background_shell_spawn_args` detach wrappers. */
export const BACKGROUND_SHELL_MARKER = "__CURSOR_BACKGROUND_SHELL__";
const policies = new Map();
const outcomes = new Map();
/** callIDs that need shell.env injectors or a direct-command fallback. */
const pendingEnvWraps = new Set();
const activeEnvWraps = new Map();
let configuredShell;
/** Track OpenCode's configured shell from the classic config hook. */
export function setCursorShellPath(shell) {
    configuredShell = shell?.trim() || undefined;
}
function executableOnPath(name) {
    for (const dir of (process.env.PATH ?? "").split(delimiter)) {
        if (dir && existsSync(join(dir, name)))
            return true;
    }
    return false;
}
/**
 * Mirror the relevant part of OpenCode Shell.acceptable(): fish/nu are denied,
 * then POSIX falls back to bash when installed and `/bin/sh` otherwise.
 */
export function resolveCursorShellKind(shell = configuredShell ?? process.env.SHELL) {
    let name = shell ? basename(shell).toLowerCase().replace(/\.exe$/, "") : "";
    if (name === "fish" || name === "nu" || !name) {
        name = executableOnPath("bash") ? "bash" : "sh";
    }
    if (name === "bash" || name === "zsh" || name === "sh" || name === "dash")
        return name;
    return "other";
}
function remember(map, key, value, onEvict) {
    map.delete(key);
    map.set(key, value);
    while (map.size > MAX_TRACKED_SHELL_CALLS) {
        const oldest = map.keys().next().value;
        if (!oldest)
            break;
        const evicted = map.get(oldest);
        map.delete(oldest);
        if (evicted !== undefined && onEvict)
            onEvict(evicted);
    }
}
function finiteNonNegative(value) {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n) || n < 0)
        return undefined;
    return Math.floor(n);
}
export function shellPolicyFromMetadata(metadata) {
    if (!metadata)
        return undefined;
    if (metadata.background_shell_spawn === true) {
        return {
            command: typeof metadata.command === "string" ? metadata.command : "",
            workingDirectory: typeof metadata.working_directory === "string" ? metadata.working_directory : "",
            timeoutMs: 0,
            timeoutBehavior: 0,
            backgroundSpawn: true,
        };
    }
    if (metadata.shell_stream !== true)
        return undefined;
    const timeoutMs = finiteNonNegative(metadata.timeout_ms) ?? 30_000;
    const timeoutBehavior = finiteNonNegative(metadata.timeout_behavior) ?? 0;
    const hardTimeoutMs = finiteNonNegative(metadata.hard_timeout_ms);
    return {
        command: typeof metadata.command === "string" ? metadata.command : "",
        workingDirectory: typeof metadata.working_directory === "string" ? metadata.working_directory : "",
        timeoutMs,
        timeoutBehavior,
        ...(hardTimeoutMs !== undefined && hardTimeoutMs > 0 ? { hardTimeoutMs } : {}),
    };
}
/** Register a Cursor shell request before OpenCode executes its emitted tool call. */
export function registerCursorShellCall(toolCallId, metadata) {
    const policy = shellPolicyFromMetadata(metadata);
    if (!policy || !toolCallId.startsWith("cursor_"))
        return;
    remember(policies, toolCallId, policy);
}
function shellQuote(value) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
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
export function buildSoftBackgroundCommand(policy) {
    const polls = Math.ceil(policy.timeoutMs / POLL_INTERVAL_MS);
    const hardPolls = policy.hardTimeoutMs !== undefined
        ? Math.max(1, Math.ceil(policy.hardTimeoutMs / POLL_INTERVAL_MS))
        : undefined;
    const lines = [
        'cursor_shell_log="$(mktemp "${TMPDIR:-/tmp}/cursor-opencode-shell.XXXXXX")" || exit 1',
        `nohup sh -c ${shellQuote(policy.command)} >"$cursor_shell_log" 2>&1 </dev/null &`,
        "cursor_shell_pid=$!",
    ];
    if (hardPolls !== undefined) {
        lines.push('cursor_shell_status="$(mktemp "${TMPDIR:-/tmp}/cursor-opencode-shell-status.XXXXXX")" || exit 1', `nohup sh -c 'cursor_hard_poll=0; while [ "$cursor_hard_poll" -lt "$1" ] && kill -0 "$2" 2>/dev/null; do sleep ${POLL_INTERVAL_MS / 1000}; cursor_hard_poll=$((cursor_hard_poll + 1)); done; if kill -0 "$2" 2>/dev/null; then printf timeout >"$3"; kill -TERM "$2" 2>/dev/null; sleep 3; kill -KILL "$2" 2>/dev/null; fi' cursor-shell-watchdog ${hardPolls} "$cursor_shell_pid" "$cursor_shell_status" >/dev/null 2>&1 </dev/null &`, "cursor_shell_watchdog_pid=$!");
    }
    else {
        lines.push('cursor_shell_status=""', 'cursor_shell_watchdog_pid=""');
    }
    lines.push(
    // Avoid interactive job-control noise ("Terminated: 15 …") when we later
    // reap the watchdog; that text can otherwise land after our private marker
    // and leak into OpenCode's bash UI.
    "set +m 2>/dev/null || true", 'if [ -n "$cursor_shell_watchdog_pid" ]; then disown "$cursor_shell_watchdog_pid" 2>/dev/null || true; fi', 'disown "$cursor_shell_pid" 2>/dev/null || true', "cursor_shell_poll=0", `while [ "$cursor_shell_poll" -lt ${polls} ] && kill -0 "$cursor_shell_pid" 2>/dev/null; do`, `  sleep ${POLL_INTERVAL_MS / 1000}`, "  cursor_shell_poll=$((cursor_shell_poll + 1))", "done", 'if kill -0 "$cursor_shell_pid" 2>/dev/null; then', '  cat "$cursor_shell_log"', `  printf '\n${BACKGROUND_MARKER}%s:%s\n' "$cursor_shell_pid" "$cursor_shell_log"`, "  exit 0", "fi", 'wait "$cursor_shell_pid" 2>/dev/null', "cursor_shell_code=$?", 'cat "$cursor_shell_log"', 'if [ -n "$cursor_shell_status" ] && [ "$(cat "$cursor_shell_status" 2>/dev/null)" = timeout ]; then', 
    // Reap the watchdog before printing the private marker so any residual
    // shell diagnostics cannot trail the sentinel.
    '  if [ -n "$cursor_shell_watchdog_pid" ]; then kill "$cursor_shell_watchdog_pid" 2>/dev/null || true; wait "$cursor_shell_watchdog_pid" 2>/dev/null || true; fi', `  printf '\n${TIMEOUT_MARKER}%s\n' ${policy.hardTimeoutMs ?? policy.timeoutMs}`, "else", '  if [ -n "$cursor_shell_watchdog_pid" ]; then kill "$cursor_shell_watchdog_pid" 2>/dev/null || true; wait "$cursor_shell_watchdog_pid" 2>/dev/null || true; fi', `  printf '\n${EXIT_MARKER}%s\n' "$cursor_shell_code"`, "fi", 'rm -f -- "$cursor_shell_log"', 'if [ -n "$cursor_shell_status" ]; then rm -f -- "$cursor_shell_status"; fi');
    return lines.join("\n");
}
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
export function buildBackgroundShellCommand(command) {
    return [
        'bg_log="$(mktemp "${TMPDIR:-/tmp}/cursor-opencode-bg.XXXXXX")" || exit 1',
        `nohup sh -c ${shellQuote(command)} >"$bg_log" 2>&1 </dev/null &`,
        "bg_pid=$!",
        `printf '${BACKGROUND_SHELL_MARKER}%s:%s\\n' "$bg_pid" "$bg_log"`,
    ].join("\n");
}
function wrapperBodyForPolicy(policy) {
    if (policy.backgroundSpawn)
        return buildBackgroundShellCommand(policy.command);
    if (policy.timeoutBehavior === CURSOR_TIMEOUT_BACKGROUND)
        return buildSoftBackgroundCommand(policy);
    return undefined;
}
function writeShellEnvInjector(wrapperBody) {
    const dir = mkdtempSync(join(tmpdir(), "cursor-opencode-wrap-"));
    const wrapperPath = join(dir, "wrapper.sh");
    const bashEnvPath = join(dir, "bashenv.sh");
    const zshenvPath = join(dir, ".zshenv");
    writeFileSync(wrapperPath, `${wrapperBody}\n`, { mode: 0o700 });
    // Sourced by bash (BASH_ENV) or zsh (.zshenv via ZDOTDIR). `exec`
    // replaces the host shell before OpenCode's `-c <original>` body runs.
    const injector = [
        "unset BASH_ENV ZDOTDIR ENV CURSOR_OPENCODE_WRAP_ACTIVE",
        `exec /bin/sh ${shellQuote(wrapperPath)}`,
        "",
    ].join("\n");
    writeFileSync(bashEnvPath, injector, { mode: 0o600 });
    writeFileSync(zshenvPath, injector, { mode: 0o600 });
    return {
        wrapperPath,
        env: {
            BASH_ENV: bashEnvPath,
            ZDOTDIR: dir,
        },
        cleanup: () => {
            try {
                rmSync(dir, { recursive: true, force: true });
            }
            catch {
                // best-effort temp cleanup
            }
        },
    };
}
function ensureShellEnvWrap(toolCallId, policy) {
    const existing = activeEnvWraps.get(toolCallId);
    if (existing)
        return existing;
    const wrapperBody = wrapperBodyForPolicy(policy);
    if (!wrapperBody)
        return undefined;
    const wrap = writeShellEnvInjector(wrapperBody);
    remember(activeEnvWraps, toolCallId, wrap, (evicted) => evicted.cleanup());
    return wrap;
}
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
export function prepareCursorShellArgs(toolCallId, args, options = {}) {
    const policy = policies.get(toolCallId);
    if (!policy)
        return;
    if (!policy.backgroundSpawn && policy.timeoutBehavior !== CURSOR_TIMEOUT_BACKGROUND)
        return;
    pendingEnvWraps.add(toolCallId);
    if (!policy.backgroundSpawn) {
        // The wrapper returns just after Cursor's foreground window. OpenCode's own
        // timeout is only an outer safety net and must not win the race.
        args.timeout = Math.max(OPENCODE_TIMEOUT_GRACE_MS, policy.timeoutMs + OPENCODE_TIMEOUT_GRACE_MS);
    }
    const shellKind = resolveCursorShellKind();
    // OpenCode 2.0 has no `shell.env` hook, so bash/zsh cannot be wrapped by
    // sourcing an injector. Callers there opt into the wrapper-file command —
    // the same mechanism sh/dash already use — which needs no env injection.
    const envInjectable = !options.preferWrapperCommand && (shellKind === "bash" || shellKind === "zsh");
    if (process.platform === "win32" || envInjectable) {
        // Native Windows PowerShell/cmd wrapping remains unsupported; do not emit
        // a POSIX /bin/sh command there. Git Bash still uses the env path above.
        args.command = policy.command;
        return;
    }
    const wrap = ensureShellEnvWrap(toolCallId, policy);
    if (wrap)
        args.command = `exec /bin/sh ${shellQuote(wrap.wrapperPath)}`;
}
/** Restore the model-facing command in OpenCode's completed tool title. */
export function cursorShellOriginalCommand(toolCallId) {
    return policies.get(toolCallId)?.command || undefined;
}
/** Drop injector temp files for a finished/abandoned Cursor shell call. */
export function releaseCursorShellEnv(toolCallId) {
    pendingEnvWraps.delete(toolCallId);
    const active = activeEnvWraps.get(toolCallId);
    if (!active)
        return;
    activeEnvWraps.delete(toolCallId);
    active.cleanup();
}
/**
 * Env vars for OpenCode's shell.env hook. bash/zsh execute the injector; the
 * same materialized wrapper backs the direct-command sh/dash fallback.
 */
export function cursorShellEnvForCall(toolCallId) {
    if (typeof toolCallId !== "string" || !toolCallId || !pendingEnvWraps.has(toolCallId))
        return undefined;
    const policy = policies.get(toolCallId);
    if (!policy)
        return undefined;
    const wrap = ensureShellEnvWrap(toolCallId, policy);
    if (!wrap)
        return undefined;
    pendingEnvWraps.delete(toolCallId);
    return wrap.env;
}
/**
 * OpenCode 2.0 `shell.create.before` has no tool-call id. Correlate the pending
 * wrap by command + working directory when possible, then fall back to the
 * original command for hosts that omit the directory.
 */
export function cursorShellEnvForCommand(command, workingDirectory) {
    if (typeof command !== "string" || !command)
        return undefined;
    if (workingDirectory) {
        for (const [id, policy] of policies) {
            if (!pendingEnvWraps.has(id))
                continue;
            if (policy.command === command && policy.workingDirectory === workingDirectory) {
                return cursorShellEnvForCall(id);
            }
        }
    }
    for (const [id, policy] of policies) {
        if (!pendingEnvWraps.has(id))
            continue;
        if (policy.command === command)
            return cursorShellEnvForCall(id);
    }
    return undefined;
}
function withoutMarker(output, index) {
    let clean = output.slice(0, index).replace(/[\t ]+$/gm, "").replace(/\n{2,}$/, "\n");
    if (clean.trim() === "" || clean.trim() === "(no output)")
        clean = "";
    return clean;
}
/**
 * OpenCode only stores/renders text (`output` / `metadata.output`). Private
 * markers become typed Cursor outcomes, but stripping them alone can leave a
 * blank or partial bash bubble that looks like success. Append a short
 * user-facing status so the UI explains background handoff / timeout.
 */
function formatShellOutcomeDisplay(clean, outcome) {
    let notice;
    if (outcome.kind === "backgrounded") {
        notice = outcome.msToWait > 0
            ? `Still running in the background (pid ${outcome.pid}) after ${outcome.msToWait}ms.`
            : `Started in the background (pid ${outcome.pid}).`;
    }
    else if (outcome.kind === "timeout") {
        notice = `Timed out after ${outcome.timeoutMs}ms.`;
    }
    if (!notice)
        return clean;
    if (!clean)
        return `${notice}\n`;
    return clean.endsWith("\n") ? `${clean}${notice}\n` : `${clean}\n${notice}\n`;
}
/**
 * Find the last private wrapper sentinel.
 *
 * Soft-background wrappers print the marker as the final intentional line, but
 * the host shell can still append job-control diagnostics afterwards (e.g.
 * "Terminated: 15 … nohup sh -c '…cursor-shell-watchdog…'"). Match the sentinel
 * on its own line and discard everything from that point to EOF.
 */
function lastPrivateMarker(output, marker, valuePattern) {
    const re = new RegExp(`(?:^|\\r?\\n)(${marker}${valuePattern})`, "g");
    let match;
    let last;
    while ((match = re.exec(output)) !== null) {
        if (match.index === undefined || match[1] === undefined)
            continue;
        const index = match[0].startsWith("\r\n")
            ? match.index + 2
            : match[0].startsWith("\n")
                ? match.index + 1
                : match.index;
        last = { index, values: match.slice(2) };
    }
    return last;
}
function parseOpenCodeTimeout(output) {
    const closeTag = "</shell_metadata>";
    const closeAt = output.lastIndexOf(closeTag);
    if (closeAt === -1 || output.slice(closeAt + closeTag.length).trim() !== "")
        return undefined;
    const header = /<shell_metadata>\r?\nshell tool terminated command after exceeding timeout (\d+) ms\./;
    const match = header.exec(output.slice(0, closeAt));
    if (!match || match.index === undefined)
        return undefined;
    return { output: withoutMarker(output, match.index), timeoutMs: Number(match[1]) };
}
function parseSoftBackgroundOutcome(output, policy) {
    const background = lastPrivateMarker(output, BACKGROUND_MARKER, "(\\d+):([^\\r\\n]+)");
    if (background) {
        const pid = Number(background.values[0]);
        if (Number.isSafeInteger(pid) && pid > 0 && pid <= 0xffff_ffff) {
            return {
                output: withoutMarker(output, background.index),
                outcome: {
                    kind: "backgrounded",
                    shellId: pid,
                    pid,
                    command: policy?.command ?? "",
                    workingDirectory: policy?.workingDirectory ?? "",
                    msToWait: policy?.timeoutMs ?? 0,
                    reason: 1,
                },
            };
        }
    }
    const timeout = lastPrivateMarker(output, TIMEOUT_MARKER, "(\\d+)");
    if (timeout) {
        return {
            output: withoutMarker(output, timeout.index),
            outcome: { kind: "timeout", timeoutMs: Number(timeout.values[0]) },
        };
    }
    const exit = lastPrivateMarker(output, EXIT_MARKER, "(-?\\d+)");
    if (exit) {
        return {
            output: withoutMarker(output, exit.index),
            outcome: { kind: "exit", code: Number(exit.values[0]) },
        };
    }
    return undefined;
}
function parseBackgroundSpawnOutcome(output, policy) {
    const match = lastPrivateMarker(output, BACKGROUND_SHELL_MARKER, "(\\d+):([^\\r\\n]+)");
    if (!match)
        return undefined;
    const pid = Number(match.values[0]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffff_ffff)
        return undefined;
    return {
        output: withoutMarker(output, match.index),
        outcome: {
            kind: "backgrounded",
            shellId: pid,
            pid,
            command: policy?.command ?? "",
            workingDirectory: policy?.workingDirectory ?? "",
            msToWait: 0,
            reason: 1,
        },
    };
}
/**
 * Strip private wrapper sentinels / OpenCode timeout envelopes for display.
 * Does not record outcomes — use {@link captureCursorShellResult} for that.
 *
 * OpenCode 2.0 `Tool.Result.output` is structured (an object for shell), not
 * a string. Non-string input is returned unchanged so the 2.0 after-hook can
 * pass structured output through safely.
 */
export function sanitizeCursorShellDisplayOutput(output, policy) {
    if (typeof output !== "string")
        return output;
    if (policy?.backgroundSpawn) {
        const spawn = parseBackgroundSpawnOutcome(output, policy);
        if (spawn)
            return formatShellOutcomeDisplay(spawn.output, spawn.outcome);
    }
    if (policy?.timeoutBehavior === CURSOR_TIMEOUT_BACKGROUND) {
        const wrapper = parseSoftBackgroundOutcome(output, policy);
        if (wrapper)
            return formatShellOutcomeDisplay(wrapper.output, wrapper.outcome);
    }
    const timeout = parseOpenCodeTimeout(output);
    if (timeout) {
        return formatShellOutcomeDisplay(timeout.output, {
            kind: "timeout",
            timeoutMs: timeout.timeoutMs,
        });
    }
    return output;
}
/** Sanitize a secondary display string (e.g. Bash `metadata.output`) for a registered call. */
export function sanitizeRegisteredCursorShellOutput(toolCallId, output) {
    if (typeof output !== "string")
        return output;
    if (typeof toolCallId !== "string" || !toolCallId)
        return output;
    return sanitizeCursorShellDisplayOutput(output, policies.get(toolCallId));
}
/**
 * Capture Bash completion in the classic plugin's after hook. Returns the
 * sanitized output that OpenCode should store and render.
 *
 * Guards non-string output (OpenCode 2.0 structured `Tool.Result.output`)
 * by returning it unchanged.
 */
export function captureCursorShellResult(toolCallId, output, metadata) {
    if (typeof output !== "string")
        return output;
    if (typeof toolCallId !== "string" || !toolCallId.startsWith("cursor_"))
        return output;
    const policy = policies.get(toolCallId);
    if (policy?.backgroundSpawn) {
        const spawn = parseBackgroundSpawnOutcome(output, policy);
        if (spawn) {
            remember(outcomes, toolCallId, spawn.outcome);
            return formatShellOutcomeDisplay(spawn.output, spawn.outcome);
        }
    }
    // Private wrapper sentinels are meaningful only for calls we transformed.
    // A normal foreground command is allowed to print the same text verbatim.
    const wrapper = policy?.timeoutBehavior === CURSOR_TIMEOUT_BACKGROUND
        ? parseSoftBackgroundOutcome(output, policy)
        : undefined;
    if (wrapper) {
        remember(outcomes, toolCallId, wrapper.outcome);
        return formatShellOutcomeDisplay(wrapper.output, wrapper.outcome);
    }
    const timeout = parseOpenCodeTimeout(output);
    if (timeout) {
        const outcome = { kind: "timeout", timeoutMs: timeout.timeoutMs };
        remember(outcomes, toolCallId, outcome);
        return formatShellOutcomeDisplay(timeout.output, outcome);
    }
    const exitCode = finiteNonNegative(metadata?.exit);
    if (exitCode !== undefined)
        remember(outcomes, toolCallId, { kind: "exit", code: exitCode });
    return output;
}
/** Consume the structured result, with an inline fallback when no plugin hook ran. */
export function consumeCursorShellResult(toolCallId, output) {
    if (typeof toolCallId !== "string" || !toolCallId) {
        return { output };
    }
    let clean = output;
    if (!outcomes.has(toolCallId))
        clean = captureCursorShellResult(toolCallId, output);
    const outcome = outcomes.get(toolCallId);
    outcomes.delete(toolCallId);
    policies.delete(toolCallId);
    releaseCursorShellEnv(toolCallId);
    return { output: clean, outcome };
}
/** Test/process cleanup. */
export function resetCursorShellCalls() {
    for (const wrap of activeEnvWraps.values())
        wrap.cleanup();
    activeEnvWraps.clear();
    pendingEnvWraps.clear();
    policies.clear();
    outcomes.clear();
    configuredShell = undefined;
}
