import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname as pathDirectory, join, resolve } from "node:path";
import { releaseUnstartedTerminal } from "./terminal-runner.js";
import { processShared } from "./process-shared.js";
/** Cursor agent.v1 TimeoutBehavior enum values. */
export const CURSOR_TIMEOUT_CANCEL = 1;
export const CURSOR_TIMEOUT_BACKGROUND = 2;
const MAX_TRACKED_SHELL_CALLS = 512;
const OPENCODE_TIMEOUT_GRACE_MS = 15_000;
const POLL_INTERVAL_MS = 100;
/** Past the window, a hard-timed-out command gets the watchdog's 3 s TERM grace plus slack. */
const TIMEOUT_SETTLE_MS = 4_000;
const BACKGROUND_MARKER = "__CURSOR_SHELL_BACKGROUND__";
const EXIT_MARKER = "__CURSOR_SHELL_EXIT__";
const TIMEOUT_MARKER = "__CURSOR_SHELL_TIMEOUT__";
/** Private marker for Cursor `background_shell_spawn_args` detach wrappers. */
export const BACKGROUND_SHELL_MARKER = "__CURSOR_BACKGROUND_SHELL__";
// Native plugin and SDK entrypoints can live in separate module graphs.
const policies = processShared("shell-policies.v1", () => new Map());
const outcomes = processShared("shell-outcomes.v1", () => new Map());
const failures = processShared("shell-failures.v1", () => new Map());
/** callIDs that need shell.env injectors or a direct-command fallback. */
const pendingEnvWraps = processShared("shell-pending-env.v1", () => new Set());
const activeEnvWraps = processShared("shell-active-env.v1", () => new Map());
const createGate = processShared("shell-create-gate.v2", () => new Map());
/**
 * The `execute.before` event of each armed call. OpenCode creates the shell
 * from `event.input` after every hook ran, so its current command is the one
 * the call's create carries, even when a later hook rewrote it.
 */
const armedCalls = processShared("shell-create-calls.v1", () => new Map());
const shellConfiguration = processShared("shell-configuration.v1", () => ({
    defaultShell: undefined,
    directories: new Map(),
}));
const configuredShells = shellConfiguration.directories;
/**
 * Serialize OpenCode 2 shell creates onto their owning tool call. Call from
 * `execute.before` after `prepareCursorShellArgs`, passing the hook event the
 * host later executes. Every call arms, so an ordinary call cannot take a
 * wrapped call's adapter; `prepareCursorShellCreate` releases the holder at
 * its create. Only a create whose command a `create.before` hook rewrote
 * cannot be attributed; that call keeps its own command's lane until
 * `execute.after` or its failure.
 */
export async function armCursorShellCreate(toolCallId, call) {
    if (process.platform === "win32")
        return;
    const command = callCommand(call);
    if (command === undefined)
        return;
    armedCalls.set(toolCallId, call);
    const lane = createGate.get(command);
    if (!lane) {
        createGate.set(command, { lockedBy: toolCallId, waiters: [] });
        return;
    }
    try {
        await new Promise((resolve, reject) => {
            lane.waiters.push({ id: toolCallId, resolve, reject });
        });
    }
    catch {
        // resetCursorShellCalls cancelled this waiter.
    }
}
/** Release a create-before arm when the call is claimed, fails, or finishes. */
export function disarmCursorShellCreate(toolCallId) {
    armedCalls.delete(toolCallId);
    for (const [command, lane] of createGate) {
        lane.waiters = lane.waiters.filter((waiter) => waiter.id !== toolCallId);
        if (lane.lockedBy !== toolCallId)
            continue;
        const next = lane.waiters.shift();
        if (!next) {
            createGate.delete(command);
            continue;
        }
        // Hand over before the waiter resumes, so releasing it in between still
        // passes the lane on.
        lane.lockedBy = next.id;
        next.resolve();
    }
}
function callCommand(call) {
    const input = call?.input;
    if (typeof input !== "object" || input === null)
        return undefined;
    const command = input.command;
    return typeof command === "string" ? command : undefined;
}
/** Track OpenCode's configured shell from the classic config hook. */
export function setCursorShellPath(shell, directory) {
    const selected = shell?.trim() || undefined;
    if (!directory) {
        shellConfiguration.defaultShell = selected;
        return;
    }
    const root = canonicalDirectory(directory);
    configuredShells.delete(root);
    configuredShells.set(root, selected);
    while (configuredShells.size > 512)
        configuredShells.delete(configuredShells.keys().next().value);
}
function executableOnPath(name) {
    for (const dir of (process.env.PATH ?? "").split(delimiter)) {
        if (dir && existsSync(join(dir, name)))
            return true;
    }
    return false;
}
/** The executable selected by native OpenCode config, with its POSIX fallback. */
export function resolveCursorShellPath(shell, directory) {
    const root = directory && canonicalDirectory(directory);
    const configured = root && configuredShells.has(root) ? configuredShells.get(root) : shellConfiguration.defaultShell;
    shell ??= configured ?? process.env.SHELL;
    const name = shell ? basename(shell).toLowerCase() : "";
    if (shell && name !== "fish" && name !== "nu") {
        if (shell.includes("/")) {
            try {
                if (statSync(shell).isFile())
                    return shell;
            }
            catch { /* native fallback */ }
        }
        else {
            for (const dir of (process.env.PATH ?? "").split(delimiter)) {
                if (dir && existsSync(join(dir, shell)))
                    return join(dir, shell);
            }
        }
    }
    if (process.platform === "darwin")
        return "/bin/zsh";
    for (const dir of (process.env.PATH ?? "").split(delimiter)) {
        if (dir && existsSync(join(dir, "bash")))
            return join(dir, "bash");
    }
    return "/bin/sh";
}
/**
 * Mirror the relevant part of OpenCode Shell.acceptable(): fish/nu are denied,
 * then POSIX falls back to bash when installed and `/bin/sh` otherwise.
 */
export function resolveCursorShellKind(shell = shellConfiguration.defaultShell ?? process.env.SHELL) {
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
    const managed = {
        ...(typeof metadata.description === "string" ? { description: metadata.description } : {}),
        ...(typeof metadata.managed_command === "string" ? { managedCommand: metadata.managed_command } : {}),
        ...(typeof metadata.managed_job_directory === "string" ? { managedJobDirectory: metadata.managed_job_directory } : {}),
        ...(typeof metadata.managed_shell_path === "string" ? { shellPath: metadata.managed_shell_path } : {}),
    };
    const hardTimeoutMs = finiteNonNegative(metadata.hard_timeout_ms);
    if (metadata.background_shell_spawn === true) {
        return {
            command: typeof metadata.command === "string" ? metadata.command : "",
            workingDirectory: typeof metadata.working_directory === "string" ? metadata.working_directory : "",
            timeoutMs: 0,
            timeoutBehavior: 0,
            backgroundSpawn: true,
            ...(hardTimeoutMs !== undefined && hardTimeoutMs > 0 ? { hardTimeoutMs } : {}),
            ...managed,
        };
    }
    if (metadata.shell_stream !== true)
        return undefined;
    const timeoutMs = finiteNonNegative(metadata.timeout_ms) ?? 30_000;
    const timeoutBehavior = finiteNonNegative(metadata.timeout_behavior) ?? 0;
    return {
        command: typeof metadata.command === "string" ? metadata.command : "",
        workingDirectory: typeof metadata.working_directory === "string" ? metadata.working_directory : "",
        timeoutMs,
        timeoutBehavior,
        ...(hardTimeoutMs !== undefined && hardTimeoutMs > 0 ? { hardTimeoutMs } : {}),
        ...managed,
    };
}
/** Register a Cursor shell request before OpenCode executes its emitted tool call. */
export function registerCursorShellCall(toolCallId, metadata) {
    const policy = shellPolicyFromMetadata(metadata);
    if (!policy || !toolCallId.startsWith("cursor_"))
        return;
    // A call evicted before the host ran it must not keep its reserved record.
    remember(policies, toolCallId, policy, (evicted) => releaseUnstartedTerminal(evicted.managedJobDirectory));
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
        `cursor_payload_shell=${shellQuote(policy.shellPath ?? resolveCursorShellPath())}`,
        '[ -z "$CURSOR_SHELL_EXECUTABLE" ] || cursor_payload_shell="$CURSOR_SHELL_EXECUTABLE"',
        'cursor_shell_log="$(mktemp "${TMPDIR:-/tmp}/cursor-opencode-shell.XXXXXX")" || exit 1',
        `nohup "$cursor_payload_shell" -c ${shellQuote(policy.command)} >"$cursor_shell_log" 2>&1 </dev/null &`,
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
    "set +m 2>/dev/null || true", 
    // The payload stays a job so `wait` can return its status (bash discards
    // a disowned job's). From here this shell's stderr carries only job
    // notices; the payload and watchdog already write elsewhere.
    "exec 2>/dev/null", 'if [ -n "$cursor_shell_watchdog_pid" ]; then disown "$cursor_shell_watchdog_pid" 2>/dev/null || true; fi', 'cursor_shell_timed_out() { [ -n "$cursor_shell_status" ] && [ "$(cat "$cursor_shell_status" 2>/dev/null)" = timeout ]; }', "cursor_shell_poll=0", `while [ "$cursor_shell_poll" -lt ${polls} ] && kill -0 "$cursor_shell_pid" 2>/dev/null; do`, `  sleep ${POLL_INTERVAL_MS / 1000}`, "  cursor_shell_poll=$((cursor_shell_poll + 1))", "done", 'if kill -0 "$cursor_shell_pid" 2>/dev/null; then', "  if ! cursor_shell_timed_out; then", '    cat "$cursor_shell_log"', `    printf '\n${BACKGROUND_MARKER}%s:%s\n' "$cursor_shell_pid" "$cursor_shell_log"`, "    exit 0", "  fi", 
    // A hard-timed-out command is being stopped, not running on: never hand
    // it off. Give the watchdog's KILL a bounded time to land.
    "  cursor_shell_poll=0", `  while [ "$cursor_shell_poll" -lt ${Math.ceil(TIMEOUT_SETTLE_MS / POLL_INTERVAL_MS)} ] && kill -0 "$cursor_shell_pid" 2>/dev/null; do`, `    sleep ${POLL_INTERVAL_MS / 1000}`, "    cursor_shell_poll=$((cursor_shell_poll + 1))", "  done", "fi", 'cat "$cursor_shell_log"', "if cursor_shell_timed_out; then", 
    // Stop the watchdog once the payload has exited, so its delayed KILL cannot
    // reach a reused PID; while the payload lives, that KILL is still due.
    '  if [ -n "$cursor_shell_watchdog_pid" ] && ! kill -0 "$cursor_shell_pid" 2>/dev/null; then kill "$cursor_shell_watchdog_pid" 2>/dev/null || true; wait "$cursor_shell_watchdog_pid" 2>/dev/null || true; fi', `  printf '\n${TIMEOUT_MARKER}%s\n' ${policy.hardTimeoutMs ?? policy.timeoutMs}`, "else", 
    // Only an exited payload reaches here, so this wait cannot block.
    '  wait "$cursor_shell_pid" 2>/dev/null', "  cursor_shell_code=$?", '  if [ -n "$cursor_shell_watchdog_pid" ]; then kill "$cursor_shell_watchdog_pid" 2>/dev/null || true; wait "$cursor_shell_watchdog_pid" 2>/dev/null || true; fi', `  printf '\n${EXIT_MARKER}%s\n' "$cursor_shell_code"`, "fi", 'rm -f -- "$cursor_shell_log"', 'if [ -n "$cursor_shell_status" ]; then rm -f -- "$cursor_shell_status"; fi');
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
export function buildBackgroundShellCommand(command, shellPath) {
    return [
        `cursor_payload_shell=${shellQuote(shellPath ?? resolveCursorShellPath())}`,
        '[ -z "$CURSOR_SHELL_EXECUTABLE" ] || cursor_payload_shell="$CURSOR_SHELL_EXECUTABLE"',
        'bg_log="$(mktemp "${TMPDIR:-/tmp}/cursor-opencode-bg.XXXXXX")" || exit 1',
        `nohup "$cursor_payload_shell" -c ${shellQuote(command)} >"$bg_log" 2>&1 </dev/null &`,
        "bg_pid=$!",
        `printf '${BACKGROUND_SHELL_MARKER}%s:%s\\n' "$bg_pid" "$bg_log"`,
    ].join("\n");
}
function wrapperBodyForPolicy(policy) {
    if (policy.managedCommand)
        return policy.managedCommand;
    if (policy.backgroundSpawn)
        return buildBackgroundShellCommand(policy.command, policy.shellPath);
    if (policy.timeoutBehavior === CURSOR_TIMEOUT_BACKGROUND)
        return buildSoftBackgroundCommand(policy);
    return undefined;
}
function writeShellEnvInjector(wrapperBody, command, shellPath) {
    const dir = mkdtempSync(join(tmpdir(), "cursor-opencode-wrap-"));
    const wrapperPath = join(dir, "wrapper.sh");
    const bashEnvPath = join(dir, "bashenv.sh");
    const zshenvPath = join(dir, ".zshenv");
    writeFileSync(wrapperPath, `${wrapperBody}\n`, { mode: 0o700 });
    // Sourced by bash (BASH_ENV) or zsh (.zshenv via ZDOTDIR). `exec`
    // replaces the host shell before OpenCode's `-c <original>` body runs.
    const injector = [
        // The classic shell.env hook follows permission approval. If a later
        // plugin changed that command, never run the earlier policy snapshot.
        `if [ "\${BASH_EXECUTION_STRING:-\${ZSH_EXECUTION_STRING:-}}" != ${shellQuote(command)} ]; then`,
        "  unset BASH_ENV ZDOTDIR ENV CURSOR_OPENCODE_WRAP_ACTIVE",
        "  return 0",
        "fi",
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
            CURSOR_SHELL_EXECUTABLE: shellPath ?? resolveCursorShellPath(),
        },
    };
}
function cleanupShellEnvWrap(wrap) {
    try {
        rmSync(pathDirectory(wrap.wrapperPath), { recursive: true, force: true });
    }
    catch { /* best effort */ }
}
function ensureShellEnvWrap(toolCallId, policy) {
    const existing = activeEnvWraps.get(toolCallId);
    if (existing)
        return existing;
    const wrapperBody = wrapperBodyForPolicy(policy);
    if (!wrapperBody)
        return undefined;
    const wrap = writeShellEnvInjector(wrapperBody, policy.command, policy.shellPath);
    remember(activeEnvWraps, toolCallId, wrap, cleanupShellEnvWrap);
    return wrap;
}
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
export function prepareCursorShellArgs(toolCallId, args, options = {}) {
    const policy = policies.get(toolCallId);
    if (!policy)
        return;
    policy.shellPath = options.shellPath ?? policy.shellPath;
    if (!policy.backgroundSpawn && policy.timeoutBehavior !== CURSOR_TIMEOUT_BACKGROUND)
        return;
    pendingEnvWraps.add(toolCallId);
    if (!policy.backgroundSpawn) {
        // The wrapper returns just after Cursor's foreground window. OpenCode's own
        // timeout is only an outer safety net and must not win the race.
        args.timeout = Math.max(OPENCODE_TIMEOUT_GRACE_MS, policy.timeoutMs + OPENCODE_TIMEOUT_GRACE_MS);
    }
    if (options.deferToShellHook) {
        // OpenCode 2 selects the actual shell later. Keep the approved command
        // intact; its create hook installs an executable adapter, not a command.
        args.command = policy.command;
        return;
    }
    const shellKind = resolveCursorShellKind(policy.shellPath);
    // A host without the create hook cannot install an executable adapter.
    // Managed jobs then disclose their inline launcher for ordinary approval.
    const envInjectable = !options.preferWrapperCommand && (shellKind === "bash" || shellKind === "zsh");
    if (process.platform === "win32" || envInjectable) {
        // Native Windows PowerShell/cmd wrapping remains unsupported; do not emit
        // a POSIX /bin/sh command there. Git Bash still uses the env path above.
        args.command = policy.command;
        return;
    }
    const wrap = ensureShellEnvWrap(toolCallId, policy);
    if (wrap)
        args.command = policy.managedCommand ?? `exec /bin/sh ${shellQuote(wrap.wrapperPath)}`;
}
/** Restore the model-facing command in OpenCode's completed tool title. */
export function cursorShellOriginalCommand(toolCallId) {
    return policies.get(toolCallId)?.command || undefined;
}
/** Drop injector temp files for a finished/abandoned Cursor shell call. */
export function releaseCursorShellEnv(toolCallId) {
    disarmCursorShellCreate(toolCallId);
    pendingEnvWraps.delete(toolCallId);
    releaseUnstartedTerminal(policies.get(toolCallId)?.managedJobDirectory);
    const active = activeEnvWraps.get(toolCallId);
    if (!active)
        return;
    activeEnvWraps.delete(toolCallId);
    cleanupShellEnvWrap(active);
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
function canonicalDirectory(directory) {
    try {
        return realpathSync(directory);
    }
    catch {
        return resolve(directory);
    }
}
/**
 * OpenCode 2.0.27 calls create.before before its permission scanner, then
 * spawns the selected executable with [-c, command]. Preserve that command
 * and the shell basename the scanner uses. The adapter runs only after host
 * approval, and uses the host's selected executable for the actual payload.
 * Sources: upstream packages/core/src/shell.ts:274-305 and
 * packages/core/src/tool/plugin/shell.ts:125-145 at v2.0.27.
 */
export function prepareCursorShellCreate(event) {
    if (process.platform === "win32")
        return;
    // The lane holder whose call now carries this command owns the create.
    // Release it even when its adapter no longer matches (a later hook changed
    // the command or cwd): the create runs unwrapped and must not hold back
    // identical commands. Holders that hooks gave one command cannot be told
    // apart, so none of them is wrapped and each keeps its lane.
    const owners = [...createGate.values()].map((lane) => lane.lockedBy)
        .filter((id) => callCommand(armedCalls.get(id)) === event.command);
    if (owners.length > 1)
        return;
    const owner = owners[0];
    if (owner !== undefined)
        disarmCursorShellCreate(owner);
    if (owner !== undefined && !pendingEnvWraps.has(owner))
        return;
    for (const [id, policy] of policies) {
        if (!pendingEnvWraps.has(id) || policy.command !== event.command
            || (policy.workingDirectory && canonicalDirectory(policy.workingDirectory) !== canonicalDirectory(event.cwd)))
            continue;
        // Only its owner's create may take an armed call's wrap. Without an arm
        // (unit tests / non-plugin paths), keep single-match selection.
        if (owner !== undefined ? id !== owner : armedCalls.has(id))
            continue;
        const wrap = ensureShellEnvWrap(id, policy);
        if (!wrap)
            break;
        const directory = join(resolve(wrap.wrapperPath, ".."), "shell");
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const executable = join(directory, basename(event.shell));
        const script = [
            "#!/bin/sh",
            `if [ "$1" = -c ] && [ "$2" = ${shellQuote(event.command)} ]; then`,
            `  export CURSOR_SHELL_EXECUTABLE=${shellQuote(event.shell)}`,
            `  exec /bin/sh ${shellQuote(wrap.wrapperPath)}`,
            "fi",
            // A later host hook changed the command: execute exactly what the host
            // approved instead of the provider's earlier command snapshot.
            `exec ${shellQuote(event.shell)} "$@"`,
            "",
        ].join("\n");
        writeFileSync(executable, script, { mode: 0o700 });
        event.shell = executable;
        pendingEnvWraps.delete(id);
        break;
    }
    // The owner's create ran, wrapped or not; no later create may take its wrap.
    if (owner !== undefined)
        pendingEnvWraps.delete(owner);
}
function withoutMarker(output, index) {
    // OpenCode appends two LFs before its native timeout envelope. Preserve the
    // payload, including whitespace-only output, and strip only its placeholder.
    const clean = output.slice(0, index).replace(/\n\n$/, "");
    return clean === "(no output)" ? "" : clean;
}
/** Our launchers append exactly one LF before their sentinel, even after CR. */
function withoutPrivateMarker(output, index) {
    return output.slice(0, index).replace(/\n$/, "");
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
        // A managed terminal has its own shell id and an output file to poll.
        const identity = outcome.outputFile
            ? `shell ${outcome.shellId}, pid ${outcome.pid}`
            : `pid ${outcome.pid}`;
        const output = outcome.outputFile ? ` Output: ${outcome.outputFile}` : "";
        notice = outcome.msToWait > 0
            ? `Still running in the background (${identity}) after ${outcome.msToWait}ms.${output}`
            : `Started in the background (${identity}).${output}`;
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
/**
 * Turn a stored timeout display back into OpenCode's own timeout block, so a
 * replayed result parses as the timeout it was after its saved outcome is gone.
 */
export function restoreOpenCodeTimeout(display, timeoutMs) {
    const notice = `Timed out after ${timeoutMs}ms.\n`;
    const progress = display.endsWith(notice) ? display.slice(0, -notice.length).replace(/\n$/, "") : display;
    return `${progress || "(no output)"}\n\n<shell_metadata>\nshell tool terminated command after exceeding timeout ${timeoutMs} ms.\n</shell_metadata>`;
}
/** The timeout recorded for a call whose result has not been consumed yet. */
export function cursorShellTimeoutMs(toolCallId) {
    const outcome = outcomes.get(toolCallId);
    return outcome?.kind === "timeout" ? outcome.timeoutMs : undefined;
}
function parseOpenCodeTimeout(output) {
    const closeTag = "</shell_metadata>";
    const closeAt = output.lastIndexOf(closeTag);
    if (closeAt === -1 || output.slice(closeAt + closeTag.length).trim() !== "")
        return undefined;
    const openAt = output.lastIndexOf("<shell_metadata>", closeAt);
    if (openAt < 0)
        return undefined;
    const header = /^<shell_metadata>\r?\nshell tool terminated command after exceeding timeout (\d+) ms\./;
    const match = header.exec(output.slice(openAt, closeAt));
    if (!match || match.index === undefined)
        return undefined;
    return { output: withoutMarker(output, openAt), timeoutMs: Number(match[1]) };
}
function parseSoftBackgroundOutcome(output, policy) {
    const background = lastPrivateMarker(output, BACKGROUND_MARKER, "(\\d+):(?:(\\d+):)?([^\\r\\n]+)");
    const timeout = lastPrivateMarker(output, TIMEOUT_MARKER, "(\\d+)");
    const exit = lastPrivateMarker(output, EXIT_MARKER, "(-?\\d+)");
    // The launcher appends the authoritative outcome after the command's
    // stdout. An earlier printed sentinel must not override that final marker.
    const finalIndex = Math.max(background?.index ?? -1, timeout?.index ?? -1, exit?.index ?? -1);
    if (background && background.index === finalIndex) {
        const shellId = Number(background.values[0]);
        const pid = Number(background.values[1] || shellId);
        if (Number.isSafeInteger(pid) && pid > 0 && pid <= 0xffff_ffff) {
            return {
                output: withoutPrivateMarker(output, background.index),
                outcome: {
                    kind: "backgrounded",
                    shellId,
                    pid,
                    command: policy?.command ?? "",
                    workingDirectory: policy?.workingDirectory ?? "",
                    msToWait: policy?.timeoutMs ?? 0,
                    reason: 1,
                    ...(background.values[1] && background.values[2] ? { outputFile: background.values[2] } : {}),
                },
            };
        }
    }
    if (timeout && timeout.index === finalIndex) {
        return {
            output: withoutPrivateMarker(output, timeout.index),
            outcome: { kind: "timeout", timeoutMs: Number(timeout.values[0]) },
        };
    }
    if (exit && exit.index === finalIndex) {
        return {
            output: withoutPrivateMarker(output, exit.index),
            outcome: { kind: "exit", code: Number(exit.values[0]) },
        };
    }
    return undefined;
}
function parseBackgroundSpawnOutcome(output, policy) {
    const match = lastPrivateMarker(output, BACKGROUND_SHELL_MARKER, "(\\d+):(?:(\\d+):)?([^\\r\\n]+)");
    if (!match)
        return undefined;
    const finished = lastPrivateMarker(output, "__CURSOR_SHELL_(?:BACKGROUND|TIMEOUT|EXIT)__", "[^\\r\\n]*");
    if (finished && finished.index > match.index)
        return undefined;
    const shellId = Number(match.values[0]);
    const pid = Number(match.values[1] || shellId);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffff_ffff)
        return undefined;
    return {
        output: withoutPrivateMarker(output, match.index),
        outcome: {
            kind: "backgrounded",
            shellId,
            pid,
            command: policy?.command ?? "",
            workingDirectory: policy?.workingDirectory ?? "",
            msToWait: 0,
            reason: 1,
            ...(match.values[1] && match.values[2] ? { outputFile: match.values[2] } : {}),
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
export function sanitizeCursorShellDisplayOutput(output, policy, capturedOutcome) {
    if (typeof output !== "string")
        return output;
    if (policy?.backgroundSpawn) {
        const spawn = parseBackgroundSpawnOutcome(output, policy);
        if (spawn)
            return formatShellOutcomeDisplay(spawn.output, spawn.outcome);
        const failed = parseSoftBackgroundOutcome(output, policy);
        if (failed)
            return formatShellOutcomeDisplay(failed.output, failed.outcome);
    }
    if (policy?.timeoutBehavior === CURSOR_TIMEOUT_BACKGROUND) {
        const wrapper = parseSoftBackgroundOutcome(output, policy);
        if (wrapper)
            return formatShellOutcomeDisplay(wrapper.output, wrapper.outcome);
    }
    // Secondary display strings share the native outcome already captured from
    // the primary output. A successful command may print this exact envelope.
    const timeout = !capturedOutcome || capturedOutcome.kind === "timeout"
        ? parseOpenCodeTimeout(output) : undefined;
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
    return sanitizeCursorShellDisplayOutput(output, policies.get(toolCallId), outcomes.get(toolCallId));
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
    // Classic OpenCode returns exit:null only for its timeout/abort race. That
    // native outcome wins over any sentinel printed before the host killed it.
    // https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/tool/shell.ts#L542-L589
    if (metadata?.exit === null) {
        const timeout = parseOpenCodeTimeout(output);
        const outcome = timeout ? { kind: "timeout", timeoutMs: timeout.timeoutMs } : { kind: "aborted" };
        remember(outcomes, toolCallId, outcome);
        return timeout ? formatShellOutcomeDisplay(timeout.output, outcome) : output;
    }
    if (policy?.backgroundSpawn) {
        const spawn = parseBackgroundSpawnOutcome(output, policy);
        if (spawn) {
            remember(outcomes, toolCallId, spawn.outcome);
            return formatShellOutcomeDisplay(spawn.output, spawn.outcome);
        }
        const finished = parseSoftBackgroundOutcome(output, policy);
        if (finished) {
            remember(outcomes, toolCallId, finished.outcome);
            return formatShellOutcomeDisplay(finished.output, finished.outcome);
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
    // When the host supplied an exit code, successful stdout is not metadata.
    const timeout = metadata?.exit === undefined ? parseOpenCodeTimeout(output) : undefined;
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
/** Record the host's authoritative error status, even if its SDK drops that flag. */
export function captureCursorShellFailure(toolCallId, error) {
    if (!policies.has(toolCallId))
        return;
    const message = (error instanceof Error ? error.message : String(error ?? "")) || "Shell execution failed";
    remember(failures, toolCallId, message);
}
/** Consume the structured result, with an inline fallback when no plugin hook ran. */
export function consumeCursorShellResult(toolCallId, output) {
    if (typeof toolCallId !== "string" || !toolCallId) {
        return { output };
    }
    let clean = output;
    const saved = outcomes.get(toolCallId);
    if (!saved)
        clean = captureCursorShellResult(toolCallId, output);
    // A replayed timeout carries OpenCode's block; the saved outcome already says it.
    const restored = saved?.kind === "timeout" ? parseOpenCodeTimeout(output) : undefined;
    if (saved && restored)
        clean = formatShellOutcomeDisplay(restored.output, saved);
    const outcome = outcomes.get(toolCallId);
    const error = failures.get(toolCallId);
    failures.delete(toolCallId);
    outcomes.delete(toolCallId);
    releaseCursorShellEnv(toolCallId);
    policies.delete(toolCallId);
    return { output: clean, outcome, ...(error ? { error } : {}) };
}
/** Test/process cleanup. */
export function resetCursorShellCalls() {
    const waiters = [...createGate.values()].flatMap((lane) => lane.waiters);
    createGate.clear();
    armedCalls.clear();
    for (const waiter of waiters)
        waiter.reject(new Error("cursor shell create gate reset"));
    for (const wrap of activeEnvWraps.values())
        cleanupShellEnvWrap(wrap);
    for (const policy of policies.values())
        releaseUnstartedTerminal(policy.managedJobDirectory);
    activeEnvWraps.clear();
    pendingEnvWraps.clear();
    policies.clear();
    outcomes.clear();
    failures.clear();
    shellConfiguration.defaultShell = undefined;
    configuredShells.clear();
}
