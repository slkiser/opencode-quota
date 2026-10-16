import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// Wire-level diagnostics. Opt in with CURSOR_PROVIDER_DEBUG=1 (or "true").
// Default path mirrors Cursor CLI: $TMPDIR/cursor-provider-logs-<uid>/debug-<pid>.log
// with directory mode 0o700 and file mode 0o600. Override with CURSOR_PROVIDER_DEBUG_FILE.
// First init in a fresh file writes a header; later inits (module reload / second
// isolate sharing CURSOR_PROVIDER_DEBUG_FILE) append another header instead of
// wiping earlier EMITTED lines. Operators who want a clean run should truncate
// the override path before starting the host. Independently, when the file reaches
// DEBUG_LOG_MAX_BYTES it is size-capped (truncated + new header) so self-verify
// runs cannot grow without bound. Tokens / checksums: redact in callers.
const DEBUG_ENABLED = process.env.CURSOR_PROVIDER_DEBUG === "1" ||
    process.env.CURSOR_PROVIDER_DEBUG === "true";
/** Soft cap for the debug log file; exceeded size triggers truncate + new header. */
export const DEBUG_LOG_MAX_BYTES = 10 * 1024 * 1024;
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
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, "", { mode: 0o600 });
    }
    fs.chmodSync(filePath, 0o600);
}
function announceLogPath(filePath) {
    if (_announcedLogPath)
        return;
    _announcedLogPath = true;
    try {
        // Visible in the OpenCode / terminal session so operators know where to look.
        console.error(`[cursor-provider] CURSOR_PROVIDER_DEBUG logging to ${filePath}`);
    }
    catch {
        /* ignore */
    }
}
function debugBannerLine() {
    return `--- cursor-provider debug (pid ${process.pid}) ${new Date().toISOString()} ---\n`;
}
/**
 * If `filePath` is at least `maxBytes`, truncate it and write a size-cap header.
 * Returns true when a truncate happened. Exported for tests.
 */
export function truncateDebugLogIfOversized(filePath, maxBytes = DEBUG_LOG_MAX_BYTES) {
    if (!fs.existsSync(filePath))
        return false;
    const size = fs.statSync(filePath).size;
    if (size < maxBytes)
        return false;
    fs.writeFileSync(filePath, debugBannerLine() +
        `[${new Date().toISOString()}] debug: size-cap truncate file=${filePath} ` +
        `wasBytes=${size} maxBytes=${maxBytes}\n`, { mode: 0o600 });
    fs.chmodSync(filePath, 0o600);
    return true;
}
export function trace(msg) {
    if (!DEBUG_ENABLED)
        return;
    try {
        if (!_debugFile) {
            _debugFileUsesManagedDirectory = !process.env.CURSOR_PROVIDER_DEBUG_FILE;
            _debugFile = resolveDebugLogPath();
        }
        if (!_traceInitialized) {
            ensureSecureDebugLog(_debugFile, { secureParent: _debugFileUsesManagedDirectory });
            // Drop oversized leftovers from a prior run before appending a reinit banner.
            truncateDebugLogIfOversized(_debugFile);
            const banner = debugBannerLine();
            const preexisting = fs.existsSync(_debugFile) && fs.statSync(_debugFile).size > 0;
            if (preexisting) {
                fs.appendFileSync(_debugFile, banner);
            }
            else {
                fs.writeFileSync(_debugFile, banner, { mode: 0o600 });
            }
            _traceInitialized = true;
            announceLogPath(_debugFile);
            fs.appendFileSync(_debugFile, `[${new Date().toISOString()}] debug: enabled file=${_debugFile} ` +
                `xdg_cache_home=${process.env.XDG_CACHE_HOME ?? "(unset)"} ` +
                `cwd=${process.cwd()}` +
                (preexisting ? " reinit=append" : "") +
                `\n`);
        }
        truncateDebugLogIfOversized(_debugFile);
        fs.appendFileSync(_debugFile, `[${new Date().toISOString()}] ${msg}\n`);
    }
    catch {
        /* ignore */
    }
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
