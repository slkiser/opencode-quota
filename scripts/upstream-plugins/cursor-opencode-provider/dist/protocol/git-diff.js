import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { encodeMessage } from "./messages.js";
const execFileAsync = promisify(execFile);
/** aiserver.v1.GetDiffRequest.OutputFormat */
export const GIT_DIFF_FORMAT_UNSPECIFIED = 0;
export const GIT_DIFF_FORMAT_NAME_STATUS = 1;
export const GIT_DIFF_FORMAT_NAME_STATUS_AND_NUMSTAT = 2;
export const GIT_DIFF_FORMAT_FILE_DIFFS = 3;
export const GIT_DIFF_FORMAT_DIFFS_WITH_BEFORE_AND_AFTER = 4;
const DEFAULT_REMOTE_BRANCHES = ["main", "master", "develop"];
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;
const GIT_ENV = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
};
function gitErrorMessage(error, fallback) {
    if (!error || typeof error !== "object")
        return fallback;
    const err = error;
    const stderr = typeof err.stderr === "string" ? err.stderr.trim() : "";
    if (stderr)
        return stderr.split("\n")[0] ?? stderr;
    if (typeof err.message === "string" && err.message)
        return err.message;
    return fallback;
}
async function git(cwd, args, options) {
    try {
        const { stdout, stderr } = await execFileAsync("git", args, {
            cwd,
            encoding: "utf8",
            timeout: GIT_TIMEOUT_MS,
            maxBuffer: GIT_MAX_BUFFER,
            env: GIT_ENV,
        });
        return {
            stdout: options?.trim === false ? stdout : stdout.trimEnd(),
            stderr: stderr ?? "",
            code: 0,
        };
    }
    catch (error) {
        const err = error;
        const code = typeof err.code === "number" ? err.code : 1;
        if (options?.ignoreExit) {
            return {
                stdout: options.trim === false ? (err.stdout ?? "") : (err.stdout ?? "").trimEnd(),
                stderr: err.stderr ?? "",
                code,
            };
        }
        throw new Error(gitErrorMessage(error, `git ${args.join(" ")} failed`));
    }
}
function str(value) {
    return typeof value === "string" ? value : "";
}
function num(value) {
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
        return Number(value);
    }
    return undefined;
}
function resolveGitCwd(requestCwd, workspaceRoot) {
    const root = path.resolve(workspaceRoot || process.cwd());
    const requested = requestCwd.trim();
    if (!requested)
        return root;
    return path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(root, requested);
}
async function resolveDefaultBase(cwd) {
    try {
        const head = (await git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).stdout.trim();
        if (head)
            return head;
    }
    catch {
        /* try origin/<main|master|develop> */
    }
    for (const name of DEFAULT_REMOTE_BRANCHES) {
        const ref = `origin/${name}`;
        try {
            await git(cwd, ["rev-parse", "--verify", ref]);
            return ref;
        }
        catch {
            /* next candidate */
        }
    }
    try {
        const remotes = (await git(cwd, ["branch", "-r"])).stdout.split("\n")
            .map((line) => line.trim())
            .find((line) => line.startsWith("origin/"));
        if (remotes)
            return remotes;
    }
    catch {
        /* try init.defaultBranch */
    }
    try {
        const configured = (await git(cwd, ["config", "--get", "init.defaultBranch"])).stdout.trim();
        if (configured)
            return configured;
    }
    catch {
        /* no default */
    }
    throw new Error("Could not determine default branch");
}
function stripDiffPrefix(value) {
    return value.replace(/^[abiwco12]\//, "");
}
function parseDiffGitPaths(line) {
    if (!line.startsWith("diff --git "))
        return undefined;
    const rest = line.slice("diff --git ".length).trim();
    const match = rest.match(/^(?:[abiwco12]\/)?(.+?) (?:[abiwco12]\/)?(.+)$/);
    if (!match)
        return undefined;
    return { from: stripDiffPrefix(match[1]), to: stripDiffPrefix(match[2]) };
}
function parsePathHeader(line) {
    const body = line.replace(/^(---|\+\+\+)\s+/, "");
    const tab = body.indexOf("\t");
    const raw = (tab >= 0 ? body.slice(0, tab) : body).trim().replace(/^["']|["']$/g, "");
    if (raw === "/dev/null")
        return "/dev/null";
    return stripDiffPrefix(raw);
}
/** Parse `git diff --no-color` into aiserver.v1.FileDiff rows (CLI `Oc` / `FR`). */
export function parseUnifiedDiff(text) {
    if (!text || /^\s+$/.test(text))
        return [];
    const diffs = [];
    let current;
    let chunk;
    let remainingOld = 0;
    let remainingNew = 0;
    let oldLine = 0;
    let newLine = 0;
    let inHunk = false;
    const startFile = (from = "", to = "") => {
        current = { from, to, chunks: [], added: 0, removed: 0 };
        diffs.push(current);
        chunk = undefined;
        inHunk = false;
    };
    const ensureFile = () => {
        if (!current)
            startFile();
    };
    const appendNoNewline = (line) => {
        if (!chunk || chunk.lines.length === 0)
            return;
        chunk.lines.push(line);
    };
    for (const line of text.split("\n")) {
        if (inHunk && chunk && current) {
            if (line === "\\ No newline at end of file") {
                appendNoNewline(line);
                continue;
            }
            if (line.startsWith("-")) {
                chunk.lines.push(line);
                current.removed++;
                oldLine++;
                remainingOld--;
            }
            else if (line.startsWith("+")) {
                chunk.lines.push(line);
                current.added++;
                newLine++;
                remainingNew--;
            }
            else if (line.startsWith(" ") || line === "") {
                chunk.lines.push(line.length === 0 ? " " : line);
                oldLine++;
                newLine++;
                remainingOld--;
                remainingNew--;
            }
            else {
                inHunk = false;
            }
            if (inHunk && remainingOld <= 0 && remainingNew <= 0)
                inHunk = false;
            if (inHunk)
                continue;
        }
        if (line.startsWith("diff --git ")) {
            const paths = parseDiffGitPaths(line);
            startFile(paths?.from ?? "", paths?.to ?? "");
            continue;
        }
        if (line.startsWith("new file mode ")) {
            ensureFile();
            current.from = "/dev/null";
            continue;
        }
        if (line.startsWith("deleted file mode ")) {
            ensureFile();
            current.to = "/dev/null";
            continue;
        }
        if (line.startsWith("--- ")) {
            ensureFile();
            current.from = parsePathHeader(line);
            continue;
        }
        if (line.startsWith("+++ ")) {
            ensureFile();
            current.to = parsePathHeader(line);
            continue;
        }
        const hunk = /^@@\s+-(\d+),?(\d+)?\s+\+(\d+),?(\d+)?\s@@/.exec(line);
        if (hunk) {
            ensureFile();
            oldLine = Number(hunk[1]);
            newLine = Number(hunk[3]);
            remainingOld = hunk[2] !== undefined ? Number(hunk[2]) : 1;
            remainingNew = hunk[4] !== undefined ? Number(hunk[4]) : 1;
            chunk = {
                content: line,
                lines: [],
                old_start: Number(hunk[1]),
                old_lines: remainingOld,
                new_start: Number(hunk[3]),
                new_lines: remainingNew,
            };
            current.chunks.push(chunk);
            inHunk = true;
        }
    }
    return diffs;
}
function effectiveFormat(raw) {
    switch (raw) {
        case GIT_DIFF_FORMAT_NAME_STATUS:
        case GIT_DIFF_FORMAT_NAME_STATUS_AND_NUMSTAT:
        case GIT_DIFF_FORMAT_FILE_DIFFS:
        case GIT_DIFF_FORMAT_DIFFS_WITH_BEFORE_AND_AFTER:
            return raw;
        default:
            return GIT_DIFF_FORMAT_FILE_DIFFS;
    }
}
async function collectUntrackedDiffs(cwd, maxFiles) {
    if (maxFiles <= 0)
        return [];
    const listed = (await git(cwd, ["ls-files", "--others", "--exclude-standard"])).stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, maxFiles);
    const extra = [];
    for (const file of listed) {
        const raw = await git(cwd, ["diff", "--no-color", "--no-index", "/dev/null", file], {
            ignoreExit: true,
            trim: false,
        });
        extra.push(...parseUnifiedDiff(raw.stdout));
    }
    return extra;
}
export async function executeGitDiff(request, workspaceRoot) {
    const cwd = resolveGitCwd(str(request.cwd), workspaceRoot);
    if (!fs.existsSync(cwd)) {
        throw new Error(`git_diff cwd does not exist: ${cwd}`);
    }
    const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]).catch((error) => {
        throw new Error(gitErrorMessage(error, "not a git repository"));
    });
    if (inside.stdout.trim() !== "true") {
        throw new Error("not a git repository");
    }
    const ref = str(request.ref);
    let base = str(request.base_ref);
    if (!base)
        base = await resolveDefaultBase(cwd);
    if (request.merge_base === true) {
        base = (await git(cwd, ["merge-base", base, ref || "HEAD"])).stdout.trim();
    }
    const args = ["diff", "--no-color"];
    if (request.include_space_changes !== true)
        args.push("--ignore-space-change");
    const contextLines = num(request.unified_context_lines);
    if (contextLines !== undefined && contextLines > 0)
        args.push(`-U${contextLines}`);
    args.push(base);
    if (ref)
        args.push(ref);
    const targetPaths = Array.isArray(request.target_paths)
        ? request.target_paths.filter((item) => typeof item === "string" && item.length > 0)
        : [];
    if (targetPaths.length > 0) {
        args.push("--");
        args.push(...targetPaths);
    }
    const diffText = (await git(cwd, args, { trim: false })).stdout;
    const diffs = parseUnifiedDiff(diffText);
    diffs.push(...await collectUntrackedDiffs(cwd, num(request.max_untracked_files) ?? 0));
    const format = effectiveFormat(num(request.output_format));
    if (format !== GIT_DIFF_FORMAT_FILE_DIFFS && format !== GIT_DIFF_FORMAT_DIFFS_WITH_BEFORE_AND_AFTER) {
        for (const diff of diffs)
            diff.chunks = [];
    }
    const response = {
        diff: {
            diffs,
            diff_type: 0,
        },
    };
    if (request.return_head_sha === true) {
        response.head_sha = (await git(cwd, ["rev-parse", "HEAD"])).stdout.trim();
        const status = (await git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"])).stdout.trim();
        response.has_uncommitted_changes = status.length > 0;
    }
    return response;
}
function throwAndClose(execId, error) {
    return [
        encodeMessage("AgentClientMessage", {
            exec_client_control_message: {
                throw: { id: execId, error },
            },
        }),
        encodeMessage("AgentClientMessage", {
            exec_client_control_message: {
                stream_close: { id: execId },
            },
        }),
    ];
}
/**
 * Answer exec #44. GetDiffResponse has no error oneof — failures use
 * exec_client_control_message.throw, matching Cursor CLI `class Dc`.
 */
export async function buildGitDiffExecMessages(input) {
    let response;
    try {
        response = await executeGitDiff(input.request, input.workspaceRoot);
    }
    catch (error) {
        return throwAndClose(input.execId, error.message || "git_diff failed");
    }
    const responseBytes = encodeMessage("GetDiffResponse", response);
    const maxBytes = num(input.request.max_response_bytes) ?? 0;
    if (maxBytes > 0 && responseBytes.byteLength > maxBytes) {
        return throwAndClose(input.execId, `GetDiffResponseTooLarge: ${responseBytes.byteLength} bytes exceeds the ${maxBytes} byte limit`);
    }
    return [
        encodeMessage("AgentClientMessage", {
            exec_client_message: {
                id: input.execId,
                local_execution_time_ms: 0,
                git_diff_response: response,
            },
        }),
        encodeMessage("AgentClientMessage", {
            exec_client_control_message: {
                stream_close: { id: input.execId },
            },
        }),
    ];
}
