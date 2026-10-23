import fs from "node:fs";
import { open, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { encodeMessage } from "./protocol/messages.js";
import { trace } from "./debug.js";
import { processShared } from "./process-shared.js";
export const MAX_RUNTIME_WRITE_BYTES = 8 * 1024 * 1024;
export const MAX_RUNTIME_READ_BYTES = 1024 * 1024;
export const RUNTIME_FILE_TTL_MS = 7 * 24 * 60 * 60_000;
export const MAX_RUNTIME_SPILL_BYTES = 64 * 1024 * 1024;
export const MAX_RUNTIME_SPILL_FILES = 128;
const COMPLETED_JOB_TTL_MS = 60_000;
const maintenance = processShared("runtime-maintenance.v1", () => new Map());
const spillWrites = processShared("runtime-spill-writes.v1", () => new Map());
/** Thirty missed one-second header refreshes. */
const LOST_SUPERVISOR_MS = 30_000;
/** Deletions per sweep; examining entries is cheap, unlinking is the budgeted work. */
const SWEEP_DELETE_BUDGET = 64;
const SPILL_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.txt$/i;
const TERMINAL_NAME = /^[1-9]\d{0,9}\.txt$/;
const PARTIAL_READ_NOTICE = "\n[Partial read: runtime output was capped. It is NOT the complete file.]\n";
const STORAGE_NOTICE = "\n[Partial read: terminal output storage failed; captured output may be incomplete. It is NOT the complete file.]\n";
/** Prefix budget beyond the 8 MiB write cap (covers an oversized YAML header). */
const RUNTIME_SCAN_HEAD_EXTRA = 64 * 1024;
/** Enough for the completion footer (`exit_code`, `ended_at`, storage flag). */
const RUNTIME_SCAN_TAIL_BYTES = 16 * 1024;
/** Slice encoded text only between code points, including a tail slice. */
function utf8Slice(bytes, start, end) {
    while (start < end && (bytes[start] & 0xc0) === 0x80)
        start++;
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80)
        end--;
    return bytes.subarray(start, end).toString("utf8");
}
function directory(dir, create = false) {
    if (create) {
        try {
            fs.mkdirSync(dir, { mode: 0o700 });
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
        }
    }
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("Runtime directory is not a real directory");
    if (create && (stat.mode & 0o777) !== 0o700)
        fs.chmodSync(dir, 0o700);
}
/** The one provider-owned layout, pinned by the RequestContext's project root. */
export function runtimeLayout(root, create = false) {
    root = path.resolve(root);
    // A conversation's frozen context outlives the cache folder it names.
    if (create)
        fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    directory(root);
    const layout = { root, agentTools: path.join(root, "agent-tools"), terminals: path.join(root, "terminals") };
    directory(layout.agentTools, create);
    directory(layout.terminals, create);
    return layout;
}
export function runtimeRootFromContext(context) {
    const env = context?.env;
    return typeof env?.project_folder === "string" && path.isAbsolute(env.project_folder)
        ? env.project_folder : undefined;
}
function errorText(error) {
    return error instanceof Error ? error.message : String(error);
}
/** True when `candidate` is the real (non-symlink) directory `expected`. */
function sameDirectory(candidate, expected) {
    try {
        const actual = fs.lstatSync(candidate);
        const wanted = fs.lstatSync(expected);
        return actual.isDirectory() && !actual.isSymbolicLink() && actual.ino === wanted.ino && actual.dev === wanted.dev;
    }
    catch {
        return false;
    }
}
/**
 * Recognize only the exact reserved metadata files. Every other path,
 * including the runtime folders themselves, other names inside them, and
 * paths that resolve elsewhere, belongs to the host's own tools.
 */
function metadataTarget(root, requested) {
    if (!path.isAbsolute(requested))
        return undefined;
    const target = path.resolve(requested);
    const parent = path.dirname(target);
    const name = path.basename(target);
    for (const [folder, kind] of [["agent-tools", "spill"], ["terminals", "terminal"]]) {
        const dir = path.join(root, folder);
        let insensitive;
        if (parent === dir) {
            insensitive = sameDirectory(path.join(root, folder.toUpperCase()), dir);
        }
        else {
            // Only fold spelling when the filesystem proves both directory names
            // are the same real directory. Linux case-sensitive paths stay distinct.
            if (parent.toLowerCase() !== dir.toLowerCase() || !sameDirectory(parent, dir))
                continue;
            insensitive = true;
        }
        const normalizedName = insensitive ? name.toLowerCase() : name;
        if (!(kind === "spill" ? SPILL_NAME : TERMINAL_NAME).test(normalizedName))
            return undefined;
        return { target: path.join(dir, normalizedName), kind };
    }
    return undefined;
}
async function readMetadata(target, args, terminal, storageFailed = false) {
    const parent = fs.lstatSync(path.dirname(target));
    const expectedFile = fs.lstatSync(target);
    const handle = await open(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const stat = await handle.stat();
        const currentParent = fs.lstatSync(path.dirname(target));
        if (!currentParent.isDirectory() || currentParent.isSymbolicLink() || currentParent.ino !== parent.ino || currentParent.dev !== parent.dev) {
            throw new Error("Runtime directory changed during read");
        }
        if (!stat.isFile() || stat.nlink > 1 || expectedFile.isSymbolicLink() || stat.ino !== expectedFile.ino || stat.dev !== expectedFile.dev) {
            throw new Error("Runtime metadata must be the expected regular file without hard links");
        }
        const size = stat.size;
        // The completion footer outlives the temporary job/error marker. The
        // command and title precede status and have no length limit.
        if (terminal && !storageFailed) {
            const headerLength = await terminalHeaderLength(handle, size);
            const status = await readRange(handle, Math.max(0, headerLength - 512), Math.min(headerLength, 512));
            const footer = await readRange(handle, Math.max(0, size - RUNTIME_SCAN_TAIL_BYTES), RUNTIME_SCAN_TAIL_BYTES);
            storageFailed = /\nstatus: (?:aborted|failed) *\n/.test(status.toString("latin1"))
                && /\noutput_storage_failed: true\n---\n$/.test(footer.toString("latin1"));
        }
        const offset = typeof args.offset === "number" && args.offset > 0 ? Math.floor(args.offset) : 1;
        const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : undefined;
        const ranged = offset > 1 || limit !== undefined;
        const contentBudget = MAX_RUNTIME_READ_BYTES - Buffer.byteLength(PARTIAL_READ_NOTICE) - (storageFailed ? Buffer.byteLength(STORAGE_NOTICE) : 0);
        const allowed = storageFailed ? contentBudget : MAX_RUNTIME_READ_BYTES;
        // Two bytes past the budget tell a complete range's own terminator apart
        // from more output.
        const scan = await scanLines(handle, size, offset, limit === undefined ? Infinity : offset + limit, allowed + 2);
        // A complete range is its lines joined, without the last line's terminator.
        const page = ranged && scan.page.length <= allowed + 1 && scan.page.at(-1) === 0x0a ? scan.page.subarray(0, -1) : scan.page;
        const capped = page.length > allowed;
        let content = page.toString("utf8");
        if (capped && terminal && !ranged) {
            const omit = "\n[Earlier output omitted]\n";
            const headKeep = 2048;
            const tailBudget = Math.max(0, contentBudget - headKeep - Buffer.byteLength(omit));
            const tail = await readRange(handle, Math.max(0, size - tailBudget), tailBudget);
            content = utf8Slice(page, 0, headKeep) + omit + utf8Slice(tail, 0, tail.length);
        }
        else if (capped) {
            content = utf8Slice(page, 0, contentBudget);
        }
        if (storageFailed)
            content += STORAGE_NOTICE;
        if (capped)
            content += PARTIAL_READ_NOTICE;
        return { success: { path: target, content, total_lines: scan.lines, file_size: size, truncated: capped || storageFailed, range_applied: ranged } };
    }
    finally {
        await handle.close();
    }
}
/**
 * The first `cap` bytes of lines `first` up to `end`, and the file's line
 * count, read in fixed chunks so a small page of a large record never holds
 * the whole record in memory.
 */
async function scanLines(handle, size, first, end, cap) {
    const chunk = Buffer.alloc(64 * 1024);
    const page = [];
    let kept = 0;
    let line = 1;
    let last = 0x0a;
    for (let position = 0; position < size;) {
        const read = await handle.read(chunk, 0, Math.min(chunk.length, size - position), position);
        if (!read.bytesRead)
            break;
        const bytes = chunk.subarray(0, read.bytesRead);
        for (let from = 0; from < bytes.length;) {
            const newline = bytes.indexOf(0x0a, from);
            const stop = newline < 0 ? bytes.length : newline + 1;
            if (line >= first && line < end && kept < cap) {
                const piece = Buffer.from(bytes.subarray(from, Math.min(stop, from + cap - kept)));
                page.push(piece);
                kept += piece.length;
            }
            if (newline >= 0)
                line++;
            from = stop;
        }
        last = bytes[bytes.length - 1];
        position += bytes.length;
    }
    return { page: Buffer.concat(page), lines: last === 0x0a ? line - 1 : line };
}
async function readRange(handle, position, length) {
    const bytes = Buffer.alloc(length);
    let used = 0;
    while (used < length) {
        const read = await handle.read(bytes, used, length - used, position + used);
        if (!read.bytesRead)
            break;
        used += read.bytesRead;
    }
    return bytes.subarray(0, used);
}
/** Bytes through the header's closing `---` line, or 0 when it has none. */
async function terminalHeaderLength(handle, size) {
    const chunk = Buffer.alloc(64 * 1024);
    let window = Buffer.alloc(0);
    let start = 0;
    let end = -1;
    while (end < 0 && start + window.length < size) {
        const read = await handle.read(chunk, 0, chunk.length, start + window.length);
        if (!read.bytesRead)
            break;
        const from = Math.max(start ? 0 : 3, window.length - 4);
        window = Buffer.concat([window, chunk.subarray(0, read.bytesRead)]);
        end = window.indexOf("\n---\n", from);
        if (end < 0 && window.length > 4) {
            start += window.length - 4;
            window = window.subarray(window.length - 4);
        }
    }
    return end < 0 ? 0 : start + end + 5;
}
function processAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code === "EPERM";
    }
}
/**
 * A live supervisor rewrites its header every second. A running record that
 * has gone quiet and whose supervisor no longer exists (killed, crashed, or
 * lost to a reboot) is finalized as aborted; its group leader has already
 * stopped the command through the supervisor's lifeline.
 */
function finalizeLostTerminal(target, now) {
    let fd;
    try {
        fd = fs.openSync(target, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    }
    catch {
        return;
    }
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || now - stat.mtimeMs < LOST_SUPERVISOR_MS)
            return;
        // The command and title precede status and have no length limit, so read
        // until the header ends instead of a fixed prefix.
        const limit = Math.min(stat.size, MAX_RUNTIME_WRITE_BYTES + RUNTIME_SCAN_HEAD_EXTRA);
        let head = Buffer.alloc(0);
        let end = -1;
        while (end < 0 && head.length < limit) {
            const chunk = Buffer.alloc(Math.min(Math.max(64 * 1024, head.length), limit - head.length));
            const read = fs.readSync(fd, chunk, 0, chunk.length, head.length);
            if (!read)
                break;
            const from = Math.max(3, head.length - 4);
            head = Buffer.concat([head, chunk.subarray(0, read)]);
            end = head.indexOf("\n---\n", from);
        }
        // latin1 keeps string indexes equal to byte offsets for the in-place patch.
        const text = head.toString("latin1");
        if (!text.startsWith("---\n") || end < 0)
            return;
        const header = text.slice(0, end + 1);
        const status = header.indexOf("\nstatus: running  ");
        const pid = Number(/\npid: (\d+)\n/.exec(header)?.[1]);
        if (status < 0 || !Number.isSafeInteger(pid) || pid <= 1 || processAlive(pid))
            return;
        fs.writeSync(fd, "\nstatus: aborted  ", status);
        const endedAt = new Date(stat.mtimeMs).toISOString().replace(/\.\d{3}Z$/, "Z");
        fs.writeSync(fd, "\n[Terminal supervisor stopped before the command finished; its exit status is unknown.]\n"
            + `\n---\nexit_code: unknown\nended_at: ${endedAt}\n---\n`, stat.size);
        trace(`runtime metadata: finalized terminal with a lost supervisor ${path.basename(target)}`);
    }
    catch (error) {
        trace(`runtime metadata: lost-terminal check failed: ${errorText(error)}`);
    }
    finally {
        fs.closeSync(fd);
    }
}
function terminalStorageFailed(layout, target) {
    const jobs = path.join(layout.terminals, ".jobs");
    const id = path.basename(target, ".txt");
    let fd;
    try {
        fd = fs.openSync(path.join(jobs, `${id}.json`), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return false;
        throw error;
    }
    let owner;
    try {
        const bytes = Buffer.alloc(4096);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > bytes.length)
            throw new Error("Invalid terminal owner record");
        owner = JSON.parse(bytes.subarray(0, fs.readSync(fd, bytes, 0, bytes.length, 0)).toString());
    }
    finally {
        fs.closeSync(fd);
    }
    if (owner.shellId !== Number(id) || !SPILL_NAME.test(owner.job + ".txt"))
        throw new Error("Invalid terminal owner identity");
    directory(jobs);
    const job = path.join(jobs, owner.job);
    // A swept job leaves its index briefly (or, with an unreadable owner, until
    // the TTL); the finished record's footer carries any storage failure.
    const stat = fs.lstatSync(job, { throwIfNoEntry: false });
    if (!stat)
        return false;
    if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("Runtime directory is not a real directory");
    return fs.existsSync(path.join(job, "error"));
}
async function writeSpillLocked(layout, target, content) {
    const bytes = Buffer.from(content);
    if (bytes.length > MAX_RUNTIME_WRITE_BYTES)
        throw new Error("Runtime metadata exceeds the 8 MiB write limit");
    const lock = path.join(layout.agentTools, ".write-lock");
    let lockFd;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            lockFd = fs.openSync(lock, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
            fs.writeSync(lockFd, String(process.pid));
            break;
        }
        catch (error) {
            if (lockFd !== undefined) {
                fs.closeSync(lockFd);
                fs.unlinkSync(lock);
                throw error;
            }
            if (error.code !== "EEXIST")
                throw error;
            const stat = fs.lstatSync(lock);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 32)
                throw new Error("Unsafe runtime write lock");
            const pid = Number(fs.readFileSync(lock, "utf8"));
            if ((Number.isSafeInteger(pid) && pid > 0 && processAlive(pid))
                || (!(Number.isSafeInteger(pid) && pid > 0) && Date.now() - stat.mtimeMs < LOST_SUPERVISOR_MS)) {
                throw new Error("Runtime spill store is busy; retry the write");
            }
            const current = fs.lstatSync(lock);
            if (current.ino !== stat.ino || current.dev !== stat.dev)
                throw new Error("Runtime write lock changed");
            fs.unlinkSync(lock);
        }
    }
    if (lockFd === undefined)
        throw new Error("Runtime spill store is busy; retry the write");
    try {
        let totalBytes = bytes.length;
        let totalFiles = 1;
        for (const entry of fs.readdirSync(layout.agentTools, { withFileTypes: true })) {
            // The exclusive writer lock proves these are abandoned atomic writes,
            // rather than another process's in-progress temporary file.
            if (entry.isFile() && /^\.spill-[0-9a-f-]{36}$/.test(entry.name)) {
                const file = path.join(layout.agentTools, entry.name);
                const stat = fs.lstatSync(file);
                if (!stat.isSymbolicLink() && stat.nlink === 1)
                    fs.unlinkSync(file);
                continue;
            }
            if (!entry.isFile() || !SPILL_NAME.test(entry.name))
                continue;
            const file = path.join(layout.agentTools, entry.name);
            if (file === target)
                continue;
            const stat = fs.lstatSync(file);
            totalBytes += stat.size;
            totalFiles++;
        }
        if (totalBytes > MAX_RUNTIME_SPILL_BYTES || totalFiles > MAX_RUNTIME_SPILL_FILES) {
            throw new Error("Runtime spill store reached its 64 MiB / 128-file limit; reuse a spill path or wait for expiry");
        }
        try {
            const stat = fs.lstatSync(target);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
                throw new Error("Unsafe existing runtime metadata file");
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
        const temporary = path.join(layout.agentTools, `.spill-${randomUUID()}`);
        const parent = fs.lstatSync(layout.agentTools);
        const handle = await open(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        try {
            await handle.writeFile(bytes);
            await handle.close();
            runtimeLayout(layout.root);
            const currentParent = fs.lstatSync(layout.agentTools);
            if (currentParent.ino !== parent.ino || currentParent.dev !== parent.dev)
                throw new Error("Runtime directory changed during write");
            fs.renameSync(temporary, target);
        }
        finally {
            await handle.close().catch(() => { });
            await unlink(temporary).catch(() => { });
        }
        return { success: { path: target, lines_created: content ? content.split("\n").length : 0, file_size: bytes.length } };
    }
    finally {
        fs.closeSync(lockFd);
        fs.unlinkSync(lock);
    }
}
async function writeSpill(layout, target, content) {
    const prior = spillWrites.get(layout.root) ?? Promise.resolve();
    const current = prior.catch(() => { }).then(() => writeSpillLocked(layout, target, content));
    spillWrites.set(layout.root, current);
    try {
        return await current;
    }
    finally {
        if (spillWrites.get(layout.root) === current)
            spillWrites.delete(layout.root);
    }
}
export function maintainRuntimeFiles(layout, now = Date.now()) {
    if (now - (maintenance.get(layout.root) ?? 0) < 60_000)
        return;
    maintenance.delete(layout.root);
    maintenance.set(layout.root, now);
    while (maintenance.size > 512)
        maintenance.delete(maintenance.keys().next().value);
    sweepRuntimeFiles(layout, now);
}
/** Native internal filesystem requests never enter the host's workspace tools. */
export async function runtimeExecMessages(message, context, allowTools) {
    const root = runtimeRootFromContext(context);
    const variant = message.write_args ? "write_args" : message.read_args ? "read_args" : undefined;
    if (!root || !variant)
        return undefined;
    const args = message[variant];
    const requested = typeof args.path === "string" ? args.path : "";
    let target;
    let result;
    const resultField = variant === "write_args" ? "write_result" : "read_result";
    try {
        target = metadataTarget(root, requested);
        if (!target)
            return undefined;
        if (!allowTools)
            throw new Error("Runtime metadata operations are unavailable on a text-only request");
        const layout = runtimeLayout(root, variant === "write_args");
        maintainRuntimeFiles(layout);
        if (variant === "write_args") {
            if (target.kind !== "spill")
                throw new Error("Terminal records are writable only by their owning runner");
            const data = args.file_bytes;
            let content = typeof args.file_text === "string" ? args.file_text : undefined;
            if (data instanceof Uint8Array && data.length) {
                content = new TextDecoder("utf-8", { fatal: true }).decode(data);
            }
            else if (typeof data === "string" && data) {
                content = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(data, "base64"));
            }
            if (content === undefined || content.includes("\0"))
                throw new Error("Catalog spill must contain UTF-8 text");
            result = await writeSpill(layout, target.target, content);
        }
        else {
            if (target.kind === "terminal") {
                finalizeLostTerminal(target.target, Date.now());
            }
            const storageFailed = target.kind === "terminal" && terminalStorageFailed(layout, target.target);
            result = await readMetadata(target.target, args, target.kind === "terminal", storageFailed);
        }
    }
    catch (error) {
        const code = error.code;
        result = variant === "read_args" && (code === "ENOENT" || code === "ENOTDIR")
            ? { file_not_found: { path: requested } }
            : { error: { path: requested, error: errorText(error) } };
    }
    trace(`runtime metadata: ${variant} id=${message.id} ${"success" in result ? "success" : "error"}`);
    return [
        encodeMessage("AgentClientMessage", { exec_client_message: { id: message.id, [resultField]: result } }),
        encodeMessage("AgentClientMessage", { exec_client_control_message: { stream_close: { id: message.id } } }),
    ];
}
/**
 * Age-based cleanup. A live supervisor rewrites its record every second, so a
 * terminal record or job untouched for the TTL is finished, was never
 * started, or was orphaned by a crash or reboot. Only deletions are budgeted:
 * young entries early in directory order cannot stall later cleanup.
 */
export function sweepRuntimeFiles(layout, now = Date.now()) {
    let budget = SWEEP_DELETE_BUDGET;
    const mtime = (file) => {
        try {
            return fs.lstatSync(file).mtimeMs;
        }
        catch {
            return 0;
        }
    };
    for (const [dir, pattern] of [[layout.agentTools, SPILL_NAME], [layout.terminals, TERMINAL_NAME]]) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (budget <= 0)
                return;
            if (!entry.isFile() || !pattern.test(entry.name))
                continue;
            const target = path.join(dir, entry.name);
            try {
                const stat = fs.lstatSync(target);
                if (stat.isSymbolicLink() || stat.nlink !== 1 || now - stat.mtimeMs < RUNTIME_FILE_TTL_MS)
                    continue;
                fs.unlinkSync(target);
                budget--;
            }
            catch { /* another runner or cleanup may have replaced the entry */ }
        }
    }
    const jobs = path.join(layout.terminals, ".jobs");
    try {
        directory(jobs);
    }
    catch {
        return; /* no supervised job has been launched yet */
    }
    for (const entry of fs.readdirSync(jobs, { withFileTypes: true })) {
        if (budget <= 0)
            return;
        const target = path.join(jobs, entry.name);
        try {
            if (entry.isDirectory() && SPILL_NAME.test(entry.name + ".txt")) {
                let shellId;
                try {
                    const owner = JSON.parse(fs.readFileSync(path.join(target, "owner.json"), "utf8"));
                    if (Number.isSafeInteger(owner.shellId) && owner.shellId >= 1000 && owner.shellId < 1_000_000)
                        shellId = owner.shellId;
                }
                catch { /* a job whose owner record is unreadable still ages out */ }
                const record = shellId === undefined ? undefined : path.join(layout.terminals, `${shellId}.txt`);
                const newest = Math.max(mtime(target), mtime(path.join(target, "done")), record ? mtime(record) : 0);
                const completedAt = mtime(path.join(target, "done"));
                const completed = completedAt > 0 && now - completedAt >= COMPLETED_JOB_TTL_MS;
                if (!completed && now - newest < RUNTIME_FILE_TTL_MS)
                    continue;
                fs.rmSync(target, { recursive: true, force: true });
                budget--;
                if (shellId === undefined)
                    continue;
                const index = path.join(jobs, `${shellId}.json`);
                try {
                    if (JSON.parse(fs.readFileSync(index, "utf8")).job === entry.name)
                        fs.rmSync(index, { force: true });
                }
                catch { /* the index belongs to another job or is already gone */ }
            }
            else if (entry.isFile() && /^[1-9]\d{3,5}\.json$/.test(entry.name)) {
                // An index whose job is gone would otherwise keep its shell id reserved.
                const job = JSON.parse(fs.readFileSync(target, "utf8")).job;
                if (now - mtime(target) < RUNTIME_FILE_TTL_MS || (typeof job === "string" && fs.existsSync(path.join(jobs, job))))
                    continue;
                fs.unlinkSync(target);
                budget--;
            }
        }
        catch { /* another runner or cleanup may have replaced the entry */ }
    }
}
