import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { MAX_RUNTIME_WRITE_BYTES, maintainRuntimeFiles, runtimeLayout } from "./runtime-files.js";
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
const MAX_LAUNCHER_OUTPUT_BYTES = 1024 * 1024;
/** Startup budget: the launcher must report well inside the host's timeout. */
const START_DEADLINE_SECONDS = 10;
/** Launcher check interval; deadlines come from their own timers, not counts. */
const LAUNCHER_POLL_SECONDS = 0.05;
/**
 * How long a hard-timed-out command may keep the launcher past its window:
 * the supervisor's three-second TERM grace plus its one-second cancellation
 * drain. With START_DEADLINE_SECONDS this stays inside the 15 s the host's
 * own timeout adds to the window.
 */
const TIMEOUT_SETTLE_SECONDS = 4;
/**
 * Soft-background launcher tail: wait out Cursor's foreground window, then
 * return the finished result, a hard timeout, or the output so far plus a
 * background handle.
 */
function softBackgroundWindow(policy, shellId) {
    return [
        'cursor_header=$(cat "$cursor_job/header-bytes")',
        `cursor_deadline ${Math.max(0, policy.timeoutMs) / 1000} window-expired`,
        'while [ ! -f "$cursor_job/done" ] && [ ! -f "$cursor_job/window-expired" ]; do',
        // A supervisor that exited after writing its record is a finished command.
        '  if ! kill -0 "$cursor_supervisor" 2>/dev/null; then',
        '    if [ -f "$cursor_job/done" ] || [ -f "$cursor_job/timedout" ]; then break; fi',
        '    cursor_cancel_deadline',
        '    printf "Terminal supervisor stopped without a final record\\n\\n__CURSOR_SHELL_EXIT__1\\n"; exit 1',
        "  fi",
        `  sleep ${LAUNCHER_POLL_SECONDS}`, "done",
        'cursor_cancel_deadline',
        // A hard-timed-out command is being stopped, not running on: never hand it
        // off. Wait a bounded time for the supervisor to finish its record.
        'if [ ! -f "$cursor_job/done" ] && [ -f "$cursor_job/timedout" ]; then',
        `  cursor_deadline ${TIMEOUT_SETTLE_SECONDS} settle-expired`,
        '  while [ ! -f "$cursor_job/done" ] && [ ! -f "$cursor_job/settle-expired" ] && kill -0 "$cursor_supervisor" 2>/dev/null; do',
        `    sleep ${LAUNCHER_POLL_SECONDS}`, "  done",
        '  cursor_cancel_deadline',
        "fi",
        'if [ -f "$cursor_job/done" ]; then',
        ...capturedOutput('$(cat "$cursor_job/output-bytes")'),
        '  if [ -f "$cursor_job/timedout" ]; then',
        `    printf '\\n__CURSOR_SHELL_TIMEOUT__%s\\n' ${policy.hardTimeoutMs ?? 0}`,
        '  else printf "\\n__CURSOR_SHELL_EXIT__%s\\n" "$(cat "$cursor_job/done")"; fi',
        'elif [ -f "$cursor_job/timedout" ]; then',
        ...capturedOutput('$(( $(wc -c <"$cursor_terminal") - cursor_header ))'),
        `  printf '\\n__CURSOR_SHELL_TIMEOUT__%s\\n' ${policy.hardTimeoutMs ?? 0}`,
        "else",
        '  if ! kill -0 "$cursor_supervisor" 2>/dev/null || [ -f "$cursor_job/error" ]; then cat "$cursor_job/error" 2>/dev/null; printf "\\n__CURSOR_SHELL_EXIT__1\\n"; exit 1; fi',
        // A soft handoff returns what the foreground window produced, as the
        // command would have shown before it moved to the background.
        ...capturedOutput('$(( $(wc -c <"$cursor_terminal") - cursor_header ))'),
        `  printf '\\n__CURSOR_SHELL_BACKGROUND__%s:%s:%s\\n' ${shellId} "$cursor_supervisor" "$cursor_terminal"`,
        "fi",
    ];
}
/**
 * Host results carry command output only; the terminal file keeps the
 * header/footer, and its reads are served by the runtime store.
 */
function capturedOutput(bytes) {
    return [
        `  cursor_output=${bytes}`,
        // BSD head rejects `-c 0` ("illegal byte count") and its stderr reaches the result.
        `  if [ "$cursor_output" -gt 0 ]; then tail -c +$((cursor_header + 1)) "$cursor_terminal" | head -c "$cursor_output" | head -c ${MAX_LAUNCHER_OUTPUT_BYTES}; fi`,
        `  if [ "$cursor_output" -gt ${MAX_LAUNCHER_OUTPUT_BYTES} ]; then printf "\\n[Partial output: terminal file contains more output]\\n"; fi`,
    ];
}
/** A heredoc delimiter that cannot terminate the embedded command early. */
function commandDelimiter(command) {
    for (;;) {
        const delimiter = `CURSOR_COMMAND_${randomBytes(16).toString("hex")}`;
        if (!command.split("\n").includes(delimiter))
            return delimiter;
    }
}
/**
 * True when `$1` is a live process whose command line contains `$2`. Linux
 * procfs is authoritative when present; `ps -p … -o command=` covers macOS;
 * a host with neither (e.g. a minimal BusyBox image) falls back to liveness.
 */
const IS_OURS = String.raw `is_ours() {
  if [ -r "/proc/$1/cmdline" ]; then
    case "$(tr '\000' ' ' <"/proc/$1/cmdline" 2>/dev/null)" in *"$2"*) return 0 ;; esac
    return 1
  fi
  [ -d /proc/self ] && return 1
  if identity=$(ps -p "$1" -o command= 2>/dev/null) && [ -n "$identity" ]; then
    case "$identity" in *"$2"*) return 0 ;; esac
    return 1
  fi
  kill -0 "$1" 2>/dev/null
}`;
/** A detached supervisor owns its command group and durable terminal record. */
export function createManagedTerminal(policy, root) {
    if (process.platform === "win32")
        throw new Error("Managed background terminals require a POSIX shell");
    const layout = runtimeLayout(root, true);
    maintainRuntimeFiles(layout);
    const jobs = path.join(layout.terminals, ".jobs");
    try {
        fs.mkdirSync(jobs, { mode: 0o700 });
    }
    catch (error) {
        if (error.code !== "EEXIST")
            throw error;
    }
    if (!fs.lstatSync(jobs).isDirectory() || fs.lstatSync(jobs).isSymbolicLink())
        throw new Error("Unsafe terminal job directory");
    let file = "";
    let shellId = 0;
    for (let attempt = 0; attempt < 16; attempt++) {
        shellId = randomInt(1000, 1_000_000);
        file = path.join(layout.terminals, `${shellId}.txt`);
        if (fs.existsSync(path.join(jobs, `${shellId}.json`))) {
            file = "";
            continue;
        }
        try {
            fs.closeSync(fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600));
            break;
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
            file = "";
        }
    }
    if (!file)
        throw new Error("Could not reserve a unique terminal id");
    const directory = path.join(jobs, randomUUID());
    let ownerCreated = false;
    try {
        fs.mkdirSync(directory, { mode: 0o700 });
        // Reuse the provider's JavaScript runtime for a byte-bounded pipe drain.
        // Polling a plain cat's file size permits arbitrarily large overshoots.
        fs.writeFileSync(path.join(directory, "collector.cjs"), COLLECTOR, { mode: 0o600 });
        fs.writeFileSync(path.join(directory, "group.sh"), [
            "#!/bin/sh", `job=${quote(directory)}`,
            // The supervisor naps between checks; USR1 wakes it when state changes.
            'supervisor="$1"',
            // Keep the leader alive until completion or cancellation so a reused
            // PID/PGID can never receive the supervisor's cancellation signal.
            "trap ':' TERM INT HUP",
            // The supervisor holds the lifeline's only write end. Its exit, however
            // abrupt (KILL, OOM, crash), is EOF here and stops an unfinished group.
            'exec 3<"$job/lifeline" || exit 1',
            '"$CURSOR_SHELL_EXECUTABLE" -c "$(cat "$job/command.sh")" 3<&- &', "payload=$!",
            "(",
            "  trap '' TERM INT HUP",
            '  while read -r state; do [ "$state" != completed ] || exit 0; done <&3',
            '  [ ! -f "$job/done" ] || exit 0',
            // Ubuntu's /bin/sh (dash) rejects `kill -TERM -- -PGID`; the negative
            // numeric operand works in dash and macOS sh without `--`.
            '  kill -TERM "-$$" 2>/dev/null',
            "  sleep 3",
            '  kill -KILL "-$$" 2>/dev/null',
            ") >/dev/null 2>&1 &",
            "watcher=$!",
            "exec 3<&-",
            // The payload holds its own copy of the pipe. This shell's stderr would
            // now carry only job notices: dash prints "Terminated" when `wait` reaps
            // a signalled payload, and that text is not command output.
            "exec 2>/dev/null",
            'printf ready >"$job/group-ready"',
            'kill -USR1 "$supervisor" 2>/dev/null',
            // A trapped TERM interrupts wait; keep the payload's real exit status.
            "while :; do",
            '  wait "$payload"; code=$?',
            '  kill -0 "$payload" 2>/dev/null || break',
            "done",
            'printf "%s\\n" "$code" >"$job/command-exit"',
            'kill -USR1 "$supervisor" 2>/dev/null',
            "exec >/dev/null 2>&1",
            'while kill -0 "$watcher" 2>/dev/null; do wait "$watcher"; done',
            'exit "$code"', "",
        ].join("\n"), { mode: 0o700 });
        fs.writeFileSync(path.join(directory, "owner.json"), JSON.stringify({ shellId, file, workspace: policy.workingDirectory }), { mode: 0o600 });
        fs.writeFileSync(path.join(jobs, `${shellId}.json`), JSON.stringify({ shellId, job: path.basename(directory) }), { mode: 0o600, flag: "wx" });
        ownerCreated = true;
        const setup = [
            "#!/bin/sh", "umask 077",
            `job=${quote(directory)}`, `terminal=${quote(file)}`,
            `root=${quote(root)}`, `terminals=${quote(layout.terminals)}`,
            `cwd_value=${quote(JSON.stringify(policy.workingDirectory))}`,
            `workdir=${quote(policy.workingDirectory)}`,
            `command_value=${quote(JSON.stringify(policy.command))}`,
            `title_value=${quote(JSON.stringify(policy.description ?? ""))}`,
            `hard_seconds=${quote(String((policy.hardTimeoutMs ?? 0) / 1000))}`,
            `max_output=${MAX_RUNTIME_WRITE_BYTES}`,
            `runtime=${quote(process.execPath)}`,
            `payload_shell=${quote(policy.shellPath ?? process.env.SHELL ?? "/bin/sh")}`,
            '[ -z "$CURSOR_SHELL_EXECUTABLE" ] || payload_shell="$CURSOR_SHELL_EXECUTABLE"',
            'export CURSOR_SHELL_EXECUTABLE="$payload_shell"',
        ].join("\n");
        fs.writeFileSync(path.join(directory, "runner.sh"), setup + "\n" + IS_OURS + "\n" + SUPERVISOR, { mode: 0o700 });
        const delimiter = commandDelimiter(policy.command);
        const body = policy.command.endsWith("\n") ? policy.command : policy.command + "\n";
        const command = [
            // The approved launcher writes the command itself: an approval prompt
            // that shows this launcher shows exactly what the supervisor will run.
            `cursor_job=${quote(directory)}`,
            // Claim the reservation before writing or starting anything: a release
            // either takes the claim first and removes it, or leaves it to this run.
            'mkdir "$cursor_job/claimed" 2>/dev/null || { printf "Background terminal was released before it started\\n\\n__CURSOR_SHELL_EXIT__1\\n"; exit 1; }',
            `cat >"$cursor_job/command.sh" <<'${delimiter}' || { rmdir "$cursor_job/claimed"; exit 1; }`,
            body + delimiter,
            `cursor_terminal=${quote(file)}`,
            IS_OURS,
            // Bash job control gives the command its own process group on macOS,
            // where setsid is not a standard executable. Else require setsid.
            'cursor_runner=$(command -v bash 2>/dev/null || true)',
            'if [ -z "$cursor_runner" ]; then cursor_runner=/bin/sh; fi',
            'nohup "$cursor_runner" "$cursor_job/runner.sh" >"$cursor_job/launcher.log" 2>&1 </dev/null &',
            "cursor_supervisor=$!",
            // Each deadline is one sleep that marks a file when it elapses. Counting
            // short polls instead drifts with process-start cost (over 50% on
            // macOS) and lets the host's own timeout kill this launcher, and with
            // it the supervisor in the same process group, before it can report.
            "cursor_deadline() {",
            '  ( cursor_nap=""; cursor_stopping=0',
            // Until it execs, the sleep still has this subshell's TERM trap, which
            // swallows a TERM. KILL cannot be caught.
            '    cursor_stop_sleep() { trap "" TERM INT HUP; kill -KILL "$cursor_nap" 2>/dev/null; wait "$cursor_nap" 2>/dev/null; }',
            // TERM can arrive after fork but before $! is assigned. Defer exit
            // until that assignment so the child remains owned and can be reaped.
            `    trap 'cursor_stopping=1; if [ -n "$cursor_nap" ]; then cursor_stop_sleep; exit 0; fi' TERM INT HUP`,
            '    sleep "$1" & cursor_nap=$!',
            '    if [ "$cursor_stopping" = 1 ]; then cursor_stop_sleep; exit 0; fi',
            '    wait "$cursor_nap" && : >"$cursor_job/$2" ) >/dev/null 2>&1 </dev/null &',
            "  cursor_timer=$!",
            "}",
            'cursor_cancel_deadline() { [ -n "$cursor_timer" ] || return 0; kill "$cursor_timer" 2>/dev/null; wait "$cursor_timer" 2>/dev/null; cursor_timer=""; }',
            'trap cursor_cancel_deadline 0',
            `cursor_deadline ${START_DEADLINE_SECONDS} start-expired`,
            'while [ ! -f "$cursor_job/ready" ] && [ ! -f "$cursor_job/error" ] && [ ! -f "$cursor_job/start-expired" ] && kill -0 "$cursor_supervisor" 2>/dev/null; do',
            `  sleep ${LAUNCHER_POLL_SECONDS}`, "done",
            'cursor_cancel_deadline',
            'if [ ! -f "$cursor_job/ready" ]; then',
            '  if is_ours "$cursor_supervisor" "$cursor_job/runner.sh"; then kill -TERM "$cursor_supervisor" 2>/dev/null || true; fi',
            '  cat "$cursor_job/error" 2>/dev/null || printf "Background terminal failed to initialize\\n"',
            // Hand the claim back so releasing the call removes the failed start.
            '  rmdir "$cursor_job/claimed" 2>/dev/null',
            '  printf "\\n__CURSOR_SHELL_EXIT__1\\n"; exit 1', "fi",
            ...(policy.backgroundSpawn
                // A spawn reports its handle as soon as the command is running. A
                // command that already finished is still a successful spawn; its
                // output and exit status are in the terminal record.
                ? [`printf '\\n__CURSOR_BACKGROUND_SHELL__%s:%s:%s\\n' ${shellId} "$cursor_supervisor" "$cursor_terminal"`]
                : softBackgroundWindow(policy, shellId)),
        ].join("\n");
        return { command, directory, file, shellId };
    }
    catch (error) {
        fs.rmSync(directory, { recursive: true, force: true });
        fs.rmSync(file, { force: true });
        if (ownerCreated)
            fs.rmSync(path.join(jobs, `${shellId}.json`), { force: true });
        throw error;
    }
}
/**
 * Denied/unstarted commands leave no reserved record; running jobs are durable.
 * A launcher claims its job before it starts anything and hands the claim back
 * when startup fails, so only a release that takes the claim removes files.
 */
export function releaseUnstartedTerminal(directory) {
    if (!directory || fs.existsSync(path.join(directory, "ready")))
        return;
    try {
        const owner = JSON.parse(fs.readFileSync(path.join(directory, "owner.json"), "utf8"));
        const jobs = path.dirname(directory);
        if (path.basename(jobs) !== ".jobs" || !/^[0-9a-f-]{36}$/.test(path.basename(directory)))
            return;
        const file = path.join(path.dirname(jobs), `${owner.shellId}.txt`);
        if (!Number.isSafeInteger(owner.shellId) || owner.shellId < 1000 || owner.shellId >= 1_000_000 || owner.file !== file)
            return;
        if (fs.lstatSync(jobs).isSymbolicLink() || fs.lstatSync(directory).isSymbolicLink())
            return;
        fs.mkdirSync(path.join(directory, "claimed"));
        // A supervisor still stopping after a failed start writes the record only
        // while its job directory exists, so remove that directory first.
        fs.rmSync(directory, { recursive: true, force: true });
        fs.rmSync(path.join(jobs, `${owner.shellId}.json`), { force: true });
        fs.rmSync(file, { force: true });
    }
    catch { /* a launcher holds the claim, or best effort */ }
}
/** Append at most the output budget, then continue draining until pipe EOF. */
const COLLECTOR = String.raw `
const fs = require("node:fs")
const [job, terminal, maxOutput, supervisor] = process.argv.slice(2)
const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW
let output
let stored = 0
let capped = false
function fail() {
  try { fs.writeFileSync(job + "/error", "Terminal output storage failed\n") } catch {}
  try { process.kill(Number(supervisor), "SIGUSR1") } catch {}
  if (output !== undefined) { try { fs.closeSync(output) } catch {}; output = undefined }
}
function append(bytes) {
  if (output === undefined) return
  try {
    let offset = 0
    while (offset < bytes.length) {
      const written = fs.writeSync(output, bytes, offset, bytes.length - offset)
      if (!written) throw new Error("Terminal write made no progress")
      offset += written
    }
  } catch { fail() }
}
try {
  output = fs.openSync(terminal, flags)
  const stat = fs.fstatSync(output)
  if (!stat.isFile() || stat.nlink !== 1) throw new Error("Unsafe terminal record")
} catch { fail() }
const input = fs.openSync(job + "/pipe", fs.constants.O_RDONLY)
const buffer = Buffer.alloc(64 * 1024)
try {
  for (;;) {
    const read = fs.readSync(input, buffer, 0, buffer.length)
    if (!read) break
    const count = Math.min(read, Math.max(0, Number(maxOutput) - stored))
    append(buffer.subarray(0, count))
    stored += count
    if (count < read && !capped) {
      capped = true
      append(Buffer.from("\n[Partial output: terminal output reached the 8 MiB storage limit]\n"))
    }
  }
  fs.writeFileSync(job + "/collected", "")
} catch { fail() }
finally {
  fs.closeSync(input)
  if (output !== undefined) fs.closeSync(output)
}
`;
const SUPERVISOR = String.raw `
started=$(date +%s)
started_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
supervisor=$$
command_pid=""
collector=""
updater=""
watchdog=""
aborted=0
group_stopped=0
group_mode=""
fail() { printf '%s\n' "$1" >"$job/error"; exit 1; }
safe_dirs() { [ ! -L "$root" ] && [ ! -L "$terminals" ] && [ ! -L "$job" ] && [ -d "$job" ]; }
# Every field has a fixed width, so the header is rewritten in place and
# command output is appended once instead of being copied on every update.
header() {
  printf '%s\n' '---' "pid: $supervisor" "cwd: $cwd_value" "command: $command_value"
  [ "$title_value" = '""' ] || printf 'title: %s\n' "$title_value"
  printf 'status: %-9s\nstarted_at: %s\nrunning_for_ms: %-15s\n---\n' "$1" "$started_at" "$(( ($(date +%s) - started) * 1000 ))"
}
write_header() { safe_dirs && header "$1" 1<>"$terminal"; }
owned_group() {
  [ -n "$command_pid" ] || return 1
  if [ "$group_mode" = bash ]; then
    for running in $(jobs -pr); do [ "$running" = "$command_pid" ] && return 0; done
    return 1
  fi
  is_ours "$command_pid" "$job/group.sh"
}
# TERM first; KILL once the payload has exited and nothing holds its output
# open any more, or after a three-second grace period. A group is stopped
# once: bash can still list a job it has just killed as running, and a killed
# group never writes command-exit, so a second pass would wait out the grace.
stop_group() {
  [ "$group_stopped" = 0 ] || return 0
  owned_group || return 0
  kill -TERM "-$command_pid" 2>/dev/null || true
  grace=0
  while [ "$grace" -lt 30 ] && { [ ! -f "$job/command-exit" ] || kill -0 "$collector" 2>/dev/null; }; do
    sleep 0.1; grace=$((grace + 1))
  done
  if owned_group; then kill -KILL "-$command_pid" 2>/dev/null || true; fi
  group_stopped=1
}
# A trapped signal that interrupts bash's wait can discard the status of a
# child that call reaped, and a later wait for that child then blocks while
# any other child lives. Wait only for a child that still exists.
reap() {
  while kill -0 "$1" 2>/dev/null; do
    wait "$1" 2>/dev/null
    if kill -0 "$1" 2>/dev/null; then sleep 0.1; fi
  done
}
stop_job() {
  [ -z "$1" ] || { kill -TERM "-$1" 2>/dev/null || kill -TERM "$1" 2>/dev/null || true; reap "$1"; }
}
on_signal() { aborted=1; stop_group; }
trap on_signal TERM INT HUP
# group.sh and the collector send USR1 when there is something to observe.
trap ':' USR1
# Sleep in a child so a trapped signal interrupts the wait at once, instead
# of forking a short sleep many times per second for the job's whole life.
nap() {
  sleep "$1" & napper=$!
  wait "$napper" 2>/dev/null || kill -KILL "$napper" 2>/dev/null
}
safe_dirs || fail 'Runtime terminal directory is unavailable'
cd -- "$workdir" || fail 'Background command working directory is unavailable'
[ -f "$job/command.sh" ] || fail 'Background command was not written'
mkfifo "$job/pipe" || fail 'Could not initialize terminal pipe'
mkfifo "$job/lifeline" || fail 'Could not initialize terminal supervision'
if [ -n "$BASH_VERSION" ]; then
  set -m
  group_mode=bash
elif command -v setsid >/dev/null 2>&1; then group_mode=setsid
else fail 'Background terminals require bash or setsid for command-group cancellation'; fi
safe_dirs && header running >"$terminal" || fail 'Could not initialize terminal record'
header_bytes=$(( $(wc -c <"$terminal") ))
printf '%s\n' "$header_bytes" >"$job/header-bytes" || fail 'Could not initialize terminal record'
[ "$aborted" = 0 ] || fail 'Background terminal was cancelled before launch'
# Held for the supervisor's whole life; every child closes its copy.
exec 4<>"$job/lifeline" || fail 'Could not initialize terminal supervision'
# A compiled Bun host re-enters the runtime instead of its bundled CLI.
BUN_BE_BUN=1 "$runtime" "$job/collector.cjs" "$job" "$terminal" "$max_output" "$supervisor" 2>/dev/null 4>&- &
collector=$!
if [ "$group_mode" = setsid ]; then
  setsid sh "$job/group.sh" "$supervisor" >"$job/pipe" 2>&1 </dev/null 4>&- &
else
  sh "$job/group.sh" "$supervisor" >"$job/pipe" 2>&1 </dev/null 4>&- &
fi
command_pid=$!
start_poll=0
while [ ! -f "$job/group-ready" ] && [ "$aborted" = 0 ] && kill -0 "$command_pid" 2>/dev/null && [ "$start_poll" -lt 100 ]; do
  nap 0.1; start_poll=$((start_poll + 1))
done
if [ ! -f "$job/group-ready" ] || [ "$aborted" = 1 ]; then
  stop_group; stop_job "$collector"; fail 'Background command group failed to initialize'
fi
printf '%s\n' "$supervisor" >"$job/ready"
# A TERM that reaches a helper before it has reset the supervisor's traps is
# discarded, so the helpers also stop on their own once job/finishing exists.
# They signal the supervisor only while it is still this job's: an abrupt
# death frees its PID for an unrelated process.
if [ "$hard_seconds" != 0 ]; then
  # Without bash job control this subshell shares the supervisor's group, so
  # stop_job can signal only the shell. The trap reaps the deadline sleep,
  # the same way the launcher's cursor_deadline does.
  (
    cursor_nap=""
    cursor_stopping=0
    cursor_stop_sleep() { trap "" TERM INT HUP; kill -KILL "$cursor_nap" 2>/dev/null; wait "$cursor_nap" 2>/dev/null; }
    trap 'cursor_stopping=1; if [ -n "$cursor_nap" ]; then cursor_stop_sleep; exit 0; fi' TERM INT HUP
    [ ! -f "$job/finishing" ] || exit 0
    sleep "$hard_seconds" & cursor_nap=$!
    if [ "$cursor_stopping" = 1 ]; then cursor_stop_sleep; exit 0; fi
    wait "$cursor_nap" && { : >"$job/timedout"; ! is_ours "$supervisor" "$job/runner.sh" || kill -TERM "$supervisor" 2>/dev/null; }
  ) 4>&- &
  watchdog=$!
fi
(
  while [ ! -f "$job/finishing" ] && kill -0 "$supervisor" 2>/dev/null; do
    sleep 1
    write_header running && continue
    printf 'Terminal output storage failed\n' >"$job/error"
    if is_ours "$supervisor" "$job/runner.sh"; then kill -TERM "$supervisor"; exit 1; fi
    break
  done
  [ ! -f "$job/finishing" ] || exit 0
  # A supervisor that died abruptly cannot stop the helpers that do not hold
  # the lifeline. The lifeline stops the command group within its grace, but a
  # descendant in its own process group can hold the output open indefinitely.
  [ -z "$watchdog" ] || ! is_ours "$watchdog" "$job/runner.sh" || kill -TERM "$watchdog" 2>/dev/null
  drain=0
  while [ "$drain" -lt 50 ] && kill -0 "$collector" 2>/dev/null; do sleep 0.1; drain=$((drain + 1)); done
  ! is_ours "$collector" "$job/collector.cjs" || kill -TERM "$collector" 2>/dev/null
) 4>&- &
updater=$!
# The nap is only a backstop: command exit, storage failure, timeouts and
# cancellation all signal this process and end it early.
while [ "$aborted" = 0 ] && [ ! -f "$job/command-exit" ] && kill -0 "$command_pid" 2>/dev/null; do
  if [ -f "$job/error" ]; then on_signal; break; fi
  nap 1
done
if [ "$aborted" = 1 ]; then stop_group; code=143
elif [ -f "$job/command-exit" ]; then code=$(cat "$job/command-exit")
# The leader ended without reporting. Its status is read once no other child
# is left, because bash may already have discarded it.
else code=lost; fi
if [ "$aborted" = 1 ]; then stop_group; code=143; fi
: >"$job/finishing"
stop_job "$updater"
stop_job "$watchdog"
# Descendants can still hold stdout after the command exits. Give them a
# bounded drain window. Normal completion must preserve deliberately detached
# daemons; only cancellation or an unexpected owner exit stops their group.
drain=0
drain_limit=50
[ "$aborted" = 0 ] || drain_limit=10
while kill -0 "$collector" 2>/dev/null && [ "$drain" -lt "$drain_limit" ]; do sleep 0.1; drain=$((drain + 1)); done
# A copier that ended on its own either reached EOF or could not write. It
# marks EOF itself, since bash can lose its exit status. During native
# cancellation an early end alone cannot establish an I/O failure. Real
# collector write/read failures already wrote job/error.
if ! kill -0 "$collector" 2>/dev/null && [ ! -f "$job/collected" ] && [ "$aborted" = 0 ]; then
  printf 'Terminal output storage failed\n' >"$job/error"
fi
if [ "$aborted" = 1 ] || [ "$code" != 0 ]; then stop_group; fi
stop_job "$collector"
if [ "$code" = lost ]; then wait "$command_pid" 2>/dev/null; code=$?; fi
if [ -f "$job/error" ]; then aborted=1; code=1; fi
if [ "$aborted" = 1 ]; then status=aborted
elif [ "$code" = 0 ]; then status=succeeded
else status=failed; fi
printf '%s\n' "$(( $(wc -c <"$terminal") - header_bytes ))" >"$job/output-bytes" || fail 'Could not finalize terminal record'
write_header "$status" || fail 'Could not finalize terminal record'
printf '\n---\nexit_code: %s\nelapsed_ms: %s\nended_at: %s\n' "$code" "$(( ($(date +%s) - started) * 1000 ))" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >>"$terminal" || fail 'Could not finalize terminal record'
if [ -f "$job/error" ]; then printf 'output_storage_failed: true\n' >>"$terminal"; fi
printf '%s\n' '---' >>"$terminal" || fail 'Could not finalize terminal record'
printf '%s\n' "$code" >"$job/done"
# Disarm the FIFO watcher before releasing the leader. The explicit message
# survives immediate cleanup of job/done by a result consumer.
printf 'completed\n' >&4
wait "$command_pid" 2>/dev/null || true
rm -f "$job/pipe" "$job/lifeline" "$job/command.sh" "$job/group.sh" "$job/collector.cjs" "$job/runner.sh" "$job/command-exit" "$job/group-ready" "$job/finishing" "$job/collected"
exit 0
`;
