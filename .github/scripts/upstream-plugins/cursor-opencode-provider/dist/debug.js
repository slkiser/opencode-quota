import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { processShared } from "./process-shared.js";
// Wire-level diagnostics. Opt in with CURSOR_PROVIDER_DEBUG=1 (or "true"); =2 (or
// "verbose") adds the per-frame lines (`pump frame`, `frame yield`, KV frames) and
// the advertised tool list on every request, which level 1 writes once per list.
// CURSOR_PROVIDER_RECOVERY_DEBUG=1 keeps only recovery metadata, without payload traces.
// Default path mirrors Cursor CLI: $TMPDIR/cursor-provider-logs-<uid>/debug-<pid>.log
// with directory mode 0o700 and file mode 0o600. Override with CURSOR_PROVIDER_DEBUG_FILE.
// First init in a fresh file writes a header; later inits (module reload / second
// isolate sharing CURSOR_PROVIDER_DEBUG_FILE) append another header instead of
// wiping earlier EMITTED lines. Operators who want a clean run should truncate
// the override path before starting the host. By default, periodically compact
// oversized logs in place like OpenCode. CURSOR_PROVIDER_DEBUG_LOG_MODE=rotate
// selects numbered archives instead. Tokens / checksums: redact in callers.
/** `CURSOR_PROVIDER_DEBUG` as a level: 0 off, 1 (`1`/`true`), 2 (`2`/`verbose`). */
export function resolveDebugLevel(value = process.env.CURSOR_PROVIDER_DEBUG) {
    if (value === "2" || value === "verbose")
        return 2;
    return value === "1" || value === "true" ? 1 : 0;
}
const DEBUG_LEVEL = resolveDebugLevel();
const DEBUG_ENABLED = DEBUG_LEVEL > 0;
const RECOVERY_DEBUG_ENABLED = ["1", "true"].includes(process.env.CURSOR_PROVIDER_RECOVERY_DEBUG ?? "");
// OpenCode v2.2.5 packages/util/src/observability/logging.ts retention policy.
export const DEBUG_LOG_MAX_BYTES = 50 * 1024 * 1024;
export const DEBUG_LOG_KEEP_BYTES = 25 * 1024 * 1024;
export const DEBUG_LOG_TRIM_INTERVAL_MS = 60 * 60 * 1000;
export const DEBUG_LOG_TRIM_LOCK_STALE_MS = 5 * 60 * 1000;
const DEBUG_LOG_TRIM_CHUNK_BYTES = 64 * 1024;
export const DEBUG_LOG_ROTATE_BACKUPS = 5;
const DEBUG_LOG_ROTATE_BACKUPS_LIMIT = 100;
export function resolveDebugLogOptions(env = process.env) {
    const warnings = [];
    const requested = env.CURSOR_PROVIDER_DEBUG_LOG_MODE;
    const mode = requested === "rotate" ? "rotate" : "trim";
    if (requested && requested !== "trim" && requested !== "rotate") {
        warnings.push("CURSOR_PROVIDER_DEBUG_LOG_MODE must be trim or rotate; using trim");
    }
    const positiveInteger = (name, fallback, max = Number.MAX_SAFE_INTEGER) => {
        const text = env[name];
        if (!text)
            return fallback;
        const value = Number(text);
        if (/^[1-9]\d*$/.test(text) && Number.isSafeInteger(value) && value <= max)
            return value;
        warnings.push(`${name} must be an integer from 1 to ${max}; using ${fallback}`);
        return fallback;
    };
    return {
        mode,
        maxBytes: mode === "rotate" ? positiveInteger("CURSOR_PROVIDER_DEBUG_ROTATE_MAX_BYTES", DEBUG_LOG_MAX_BYTES) : DEBUG_LOG_MAX_BYTES,
        backups: mode === "rotate" ? positiveInteger("CURSOR_PROVIDER_DEBUG_ROTATE_BACKUPS", DEBUG_LOG_ROTATE_BACKUPS, DEBUG_LOG_ROTATE_BACKUPS_LIMIT) : DEBUG_LOG_ROTATE_BACKUPS,
        warnings,
    };
}
const logOptions = resolveDebugLogOptions();
// A host can load this package more than once in one process (a plugin and an
// AI SDK package import, or one plugin import per location). Count the copies so
// each banner names its copy and, once there are several, every line says which.
const moduleCopies = processShared("debug.module-copies.v1", () => ({ count: 0 }));
const MODULE_COPY = ++moduleCopies.count;
const maintenance = processShared("debug.maintenance.v1", () => new Map());
// Where `traceOncePerLog` last wrote each key's full line (the file's size right after it, and
// its length) and when, shared by every copy since they append to the same file.
const writtenOnce = processShared("debug.once-per-log.v2", () => new Map());
const WRITTEN_ONCE_MAX_KEYS = 4096;
const WRITTEN_ONCE_MAX_AGE_MS = 10 * 60 * 1000;
const WRITTEN_ONCE_SEARCH_BYTES = 64 * 1024;
let _traceInitialized = false;
let _debugFile;
let _debugFileUsesManagedDirectory = false;
let _announcedLogPath = false;
/** Message of an unknown thrown value, for log lines and error text. */
export function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
/** Whether `CURSOR_PROVIDER_DEBUG` is enabled for this process. */
export function isDebugEnabled() {
    return DEBUG_ENABLED;
}
/** Resolve the debug log path (env override or per-uid tmpdir default). */
export function resolveDebugLogPath() {
    if (process.env.CURSOR_PROVIDER_DEBUG_FILE) {
        return process.env.CURSOR_PROVIDER_DEBUG_FILE;
    }
    const uid = typeof process.getuid === "function" ? process.getuid() : process.pid;
    return path.join(os.tmpdir(), `cursor-provider-logs-${uid}`, `debug-${process.pid}.log`);
}
/**
 * Ensure the log directory is 0o700 and the log file exists as 0o600.
 * Does **not** truncate an existing file — mid-run re-init must keep prior lines.
 * Returns whether the opened file already held bytes.
 * Exported for tests; callers normally go through `trace`.
 */
export function ensureSecureDebugLog(filePath, options = {}) {
    const dir = path.dirname(filePath);
    const secureParent = options.secureParent ?? true;
    fs.mkdirSync(dir, secureParent
        ? { recursive: true, mode: 0o700 }
        : { recursive: true });
    if (secureParent) {
        const stat = fs.lstatSync(dir);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new Error(`Debug log directory is not a real directory: ${dir}`);
        }
        if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
            throw new Error(`Debug log directory is not owned by the current user: ${dir}`);
        }
        fs.chmodSync(dir, 0o700);
    }
    // Opening in append mode also avoids erasing a file another process just created.
    const fd = fs.openSync(filePath, "a", 0o600);
    try {
        fs.fchmodSync(fd, 0o600);
        return fs.fstatSync(fd).size > 0;
    }
    finally {
        fs.closeSync(fd);
    }
}
function announceLogPath(filePath) {
    if (_announcedLogPath)
        return;
    _announcedLogPath = true;
    try {
        for (const warning of logOptions.warnings)
            console.error(`[cursor-provider] ${warning}`);
        // Visible in the OpenCode / terminal session so operators know where to look.
        console.error(`[cursor-provider] CURSOR_PROVIDER_DEBUG logging to ${filePath}`);
    }
    catch {
        /* ignore */
    }
}
function debugBannerLine() {
    return `--- cursor-provider debug (pid ${process.pid}) ${new Date().toISOString()} ` +
        `copy=#${MODULE_COPY} module=${import.meta.url} ---\n`;
}
/** `#N` on each line once a second copy of this module exists in the process. */
function copyTag() {
    return moduleCopies.count > 1 ? `#${MODULE_COPY} ` : "";
}
function reapDebugLogLock(lock) {
    try {
        const before = fs.lstatSync(lock);
        if (!before.isDirectory() || Date.now() - before.mtimeMs <= DEBUG_LOG_TRIM_LOCK_STALE_MS)
            return;
        const entries = fs.readdirSync(lock);
        const after = fs.lstatSync(lock);
        if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs)
            return;
        // Remove only the observed owner's unique marker. A replacement lock is
        // published nonempty, so even a replacement after this check resists rmdir.
        if (entries.length === 1 && /^owner-[\da-f-]{36}$/.test(entries[0])) {
            fs.unlinkSync(path.join(lock, entries[0]));
        }
        else if (entries.length !== 0)
            return;
        fs.rmdirSync(lock);
    }
    catch {
        // Another owner/reaper won, or the lock contains retained rotation data.
    }
}
function withDebugLogLock(filePath, run) {
    const lock = `${filePath}.trim`;
    if (fs.existsSync(lock)) {
        reapDebugLogLock(lock);
        return false;
    }
    const candidate = fs.mkdtempSync(`${lock}-`);
    const owner = `owner-${randomUUID()}`;
    let acquired = false;
    try {
        fs.writeFileSync(path.join(candidate, owner), "", { mode: 0o600, flag: "wx" });
        try {
            fs.renameSync(candidate, lock);
        }
        catch (error) {
            if (fs.existsSync(lock))
                return false;
            throw error;
        }
        acquired = true;
        return run(lock);
    }
    finally {
        if (!acquired)
            fs.rmSync(candidate, { recursive: true, force: true });
        else {
            try {
                fs.unlinkSync(path.join(lock, owner));
                fs.rmdirSync(lock);
            }
            catch (error) {
                // A new owner may have replaced the empty lock; a failed rotation may
                // have left its active file here. Never remove either recursively.
                if (!(error instanceof Error && "code" in error &&
                    ["ENOENT", "ENOTEMPTY", "EEXIST"].includes(String(error.code))))
                    throw error;
            }
        }
    }
}
/**
 * Compact an oversized log in place, keeping its recent line-aligned tail.
 * Like OpenCode's logger, lock only trimmers: a concurrent append between the
 * final read and truncate can be lost. Never replace the inode or erase the log
 * as a fallback. Exported for tests; trace schedules maintenance hourly.
 */
export function trimDebugLogIfOversized(filePath, options = {}) {
    const maxBytes = options.maxBytes ?? DEBUG_LOG_MAX_BYTES;
    const keepBytes = options.keepBytes ?? DEBUG_LOG_KEEP_BYTES;
    if (!Number.isSafeInteger(maxBytes) || !Number.isSafeInteger(keepBytes) ||
        keepBytes <= 0 || maxBytes <= keepBytes) {
        throw new Error("Debug log retention requires 0 < keepBytes < maxBytes");
    }
    if (!fs.existsSync(filePath))
        return false;
    return withDebugLogLock(filePath, () => {
        const fd = fs.openSync(filePath, "r+");
        try {
            const size = fs.fstatSync(fd).size;
            if (size <= maxBytes)
                return false;
            const chunk = Buffer.allocUnsafe(DEBUG_LOG_TRIM_CHUNK_BYTES);
            // Drop the partial line at the cut, including any partial UTF-8 sequence.
            let start = size - keepBytes;
            for (;;) {
                const count = fs.readSync(fd, chunk, 0, chunk.length, start);
                if (count === 0)
                    break;
                const newline = chunk.subarray(0, count).indexOf(10);
                start += newline < 0 ? count : newline + 1;
                if (newline >= 0)
                    break;
            }
            let read = start;
            let written = 0;
            for (;;) {
                // Read to the current EOF, preserving appends made since the size check.
                const count = fs.readSync(fd, chunk, 0, chunk.length, read);
                if (count === 0)
                    break;
                let offset = 0;
                while (offset < count) {
                    offset += fs.writeSync(fd, chunk, offset, count - offset, written + offset);
                }
                read += count;
                written += count;
            }
            fs.ftruncateSync(fd, written);
            fs.appendFileSync(filePath, `[${new Date().toISOString()}] debug: size-cap trim wasBytes=${size} ` +
                `keptBytes=${written} maxBytes=${maxBytes} keepBytes=${keepBytes}\n`);
            return true;
        }
        finally {
            fs.closeSync(fd);
        }
    });
}
/** Numbered archives, newest in .1. Rotation never falls back to truncation. */
export function rotateDebugLogIfOversized(filePath, options = {}) {
    const maxBytes = options.maxBytes ?? DEBUG_LOG_MAX_BYTES;
    const backups = options.backups ?? DEBUG_LOG_ROTATE_BACKUPS;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !Number.isSafeInteger(backups) ||
        backups < 1 || backups > DEBUG_LOG_ROTATE_BACKUPS_LIMIT) {
        throw new Error("Invalid debug log rotation size or backup count");
    }
    if (!fs.existsSync(filePath))
        return false;
    const current = fs.lstatSync(filePath);
    if (!current.isFile())
        throw new Error("Debug log rotation requires a regular file");
    if (current.size < maxBytes)
        return false;
    return withDebugLogLock(filePath, (lock) => {
        const stat = fs.lstatSync(filePath);
        if (!stat.isFile())
            throw new Error("Debug log rotation requires a regular file");
        if (stat.size < maxBytes)
            return false;
        // Refuse directories/devices before moving any archives. Symlinks are
        // unlinked or replaced, never opened or chmod'd through their targets.
        const archives = [];
        for (let index = 1; index <= backups; index++) {
            const file = `${filePath}.${index}`;
            try {
                const info = fs.lstatSync(file);
                if (!info.isFile() && !info.isSymbolicLink())
                    throw new Error("Debug log archive is not a regular file");
                archives.push({ file, symlink: info.isSymbolicLink() });
            }
            catch (error) {
                if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
                    throw error;
                archives.push(undefined);
            }
        }
        // Detach the active file before retiring anything. A refused rename must
        // leave every archive intact, even when the next message retries rotation.
        const staged = path.join(lock, "active");
        fs.renameSync(filePath, staged);
        try {
            // A smaller configured count also retires archives made by an earlier run.
            const prefix = `${path.basename(filePath)}.`;
            for (const entry of fs.readdirSync(path.dirname(filePath), { withFileTypes: true })) {
                if (!entry.name.startsWith(prefix))
                    continue;
                const suffix = entry.name.slice(prefix.length);
                if (!/^[1-9]\d*$/.test(suffix))
                    continue;
                const number = Number(suffix);
                if (Number.isSafeInteger(number) && number > backups && (entry.isFile() || entry.isSymbolicLink())) {
                    fs.unlinkSync(path.join(path.dirname(filePath), entry.name));
                }
            }
            const oldest = archives[backups - 1];
            if (oldest)
                fs.unlinkSync(oldest.file);
            for (let index = backups - 1; index >= 1; index--) {
                const archive = archives[index - 1];
                if (!archive)
                    continue;
                if (archive.symlink)
                    fs.unlinkSync(archive.file);
                else
                    fs.renameSync(archive.file, `${filePath}.${index + 1}`);
            }
            fs.renameSync(staged, `${filePath}.1`);
            // A sibling may already have created the new active path; always append.
            fs.appendFileSync(filePath, debugBannerLine() +
                `[${new Date().toISOString()}] debug: size-cap rotate wasBytes=${stat.size} ` +
                `maxBytes=${maxBytes} backups=${backups}\n`, { mode: 0o600 });
            return true;
        }
        catch (error) {
            try {
                // Restore without replacing a new active file a sibling has opened.
                fs.linkSync(staged, filePath);
                fs.unlinkSync(staged);
            }
            catch {
                // Preserve staged data under the lock if restoration is unavailable.
                // Its nonempty directory prevents further destructive maintenance.
            }
            throw error;
        }
    });
}
function maintainDebugLog(filePath) {
    if (logOptions.mode === "rotate") {
        try {
            rotateDebugLogIfOversized(filePath, logOptions);
        }
        catch {
            // Keep appending if rotation is unavailable; never erase the current log.
        }
        return;
    }
    const key = path.resolve(filePath);
    const now = Date.now();
    const next = maintenance.get(key);
    if (next !== undefined && now < next)
        return;
    maintenance.set(key, now + DEBUG_LOG_TRIM_INTERVAL_MS);
    try {
        trimDebugLogIfOversized(filePath);
    }
    catch {
        // Maintenance is best-effort; still append the diagnostic that triggered it.
    }
}
export function trace(msg) {
    if (!DEBUG_ENABLED && !(RECOVERY_DEBUG_ENABLED && msg.startsWith("recovery:")))
        return;
    appendTrace(() => msg);
}
/**
 * `message` and `written` get the descriptor the line goes through, opened after maintenance, so
 * they see the very file that holds it even if another process renames it away meanwhile.
 */
function appendTrace(message, written) {
    try {
        if (!_debugFile) {
            _debugFileUsesManagedDirectory = !process.env.CURSOR_PROVIDER_DEBUG_FILE;
            _debugFile = resolveDebugLogPath();
        }
        if (!_traceInitialized) {
            const preexisting = ensureSecureDebugLog(_debugFile, { secureParent: _debugFileUsesManagedDirectory });
            const banner = debugBannerLine();
            fs.appendFileSync(_debugFile, banner, { mode: 0o600 });
            _traceInitialized = true;
            announceLogPath(_debugFile);
            fs.appendFileSync(_debugFile, `[${new Date().toISOString()}] debug: enabled file=${_debugFile} ` +
                `xdg_cache_home=${process.env.XDG_CACHE_HOME ?? "(unset)"} ` +
                `cwd=${process.cwd()}` +
                (preexisting ? " reinit=append" : "") +
                `\n`, { mode: 0o600 });
        }
        maintainDebugLog(_debugFile);
        const fd = fs.openSync(_debugFile, "a+", 0o600);
        try {
            const line = debugLine(message(fd));
            writeAll(fd, line);
            written?.(fd, line);
        }
        finally {
            fs.closeSync(fd);
        }
        return true;
    }
    catch {
        return false;
    }
}
function debugLine(message) {
    return `[${new Date().toISOString()}] ${copyTag()}${message}\n`;
}
function writeAll(fd, text) {
    const bytes = Buffer.from(text);
    for (let offset = 0; offset < bytes.length;)
        offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
}
/** `trace` only at `CURSOR_PROVIDER_DEBUG=2`: per-frame wire detail. */
export function traceVerbose(msg) {
    if (DEBUG_LEVEL >= 2)
        trace(msg);
}
/**
 * Write `brief` only while the file this line goes to still holds `proof` (part of `full`) near
 * where `key`'s full line was last written, at most 10 minutes ago; otherwise write `full`.
 * Checked through the descriptor the line goes through, before and after it, so a rotation,
 * truncation or replacement by this process or another leads to `full`. Only in rotate mode:
 * a trim drops a file's oldest lines, which can hold the full line of a hash it keeps.
 */
export function traceOncePerLog(key, full, brief, proof = full) {
    if (!DEBUG_ENABLED)
        return;
    const last = writtenOnce.get(key);
    const fresh = last !== undefined && Date.now() - last.at < WRITTEN_ONCE_MAX_AGE_MS;
    let wroteBrief = false;
    appendTrace((fd) => {
        wroteBrief = DEBUG_LEVEL < 2 && logOptions.mode === "rotate" && fresh && fileHolds(fd, last, proof);
        return wroteBrief ? brief : full;
    }, (fd, line) => {
        // The file was cut between the check and the write: this line is the brief one, so write the full one too.
        if (wroteBrief && !fileHolds(fd, last, proof)) {
            line = debugLine(full);
            writeAll(fd, line);
            wroteBrief = false;
        }
        // Re-inserted on every use, so eviction drops the least recently used key.
        writtenOnce.delete(key);
        writtenOnce.set(key, wroteBrief ? last : { end: fs.fstatSync(fd).size, length: Buffer.byteLength(line), at: Date.now() });
        if (writtenOnce.size > WRITTEN_ONCE_MAX_KEYS)
            writtenOnce.delete(writtenOnce.keys().next().value);
    });
}
/**
 * Whether the file holds `text` inside the full line that ended at `end`, give or take what other
 * processes appended between that write and its size check.
 */
function fileHolds(fd, written, text) {
    const start = Math.max(0, written.end - written.length - WRITTEN_ONCE_SEARCH_BYTES);
    const window = Buffer.alloc(written.end - start);
    return window.subarray(0, fs.readSync(fd, window, 0, window.length, start)).includes(text);
}
/** The tools a request advertised, by name once per log file and by hash after that. */
export function traceToolList(incoming, advertised) {
    if (!DEBUG_ENABLED)
        return;
    const names = advertised.map((tool) => tool.name).join(",");
    const hash = createHash("sha256").update(names).digest("hex").slice(0, 12);
    const counts = `extractTools: ${incoming} incoming → ${advertised.length} advertised tools=${hash}`;
    traceOncePerLog(`extractTools:${hash}`, `${counts} [${names}]`, counts, `tools=${hash} [${names}]`);
}
/**
 * Compact path-advertising summary for RequestContext troubleshooting.
 * Safe: no tokens / file contents — only workspace vs metadata roots.
 */
export function traceRequestContextPaths(label, requestContext) {
    if (!DEBUG_ENABLED)
        return;
    const env = requestContext?.env && typeof requestContext.env === "object"
        ? requestContext.env
        : undefined;
    const mcp = requestContext?.mcp_file_system_options &&
        typeof requestContext.mcp_file_system_options === "object"
        ? requestContext.mcp_file_system_options
        : undefined;
    trace(`${label}: workspace_paths=${JSON.stringify(env?.workspace_paths ?? null)} ` +
        `process_working_directory=${JSON.stringify(env?.process_working_directory ?? null)} ` +
        `project_folder=${JSON.stringify(env?.project_folder ?? null)} ` +
        `terminals_folder=${JSON.stringify(env?.terminals_folder ?? null)} ` +
        `agent_transcripts_folder=${JSON.stringify(env?.agent_transcripts_folder ?? null)} ` +
        `workspace_project_dir=${JSON.stringify(mcp?.workspace_project_dir ?? null)}`);
}
