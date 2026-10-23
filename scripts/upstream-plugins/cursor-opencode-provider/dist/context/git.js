import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { errorMessage, trace } from "../debug.js";
const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 5_000;
/** Trimmed stdout, or `undefined` when git failed or timed out. */
async function git(cwd, args) {
    const started = Date.now();
    try {
        const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf-8", timeout: GIT_TIMEOUT_MS });
        return stdout.trim();
    }
    catch (error) {
        const killed = error.killed === true;
        trace(`git: \`${args.join(" ")}\` ${killed ? `timed out after ${GIT_TIMEOUT_MS}ms` : "failed"} ` +
            `elapsedMs=${Date.now() - started}${killed ? "" : `: ${errorMessage(error).split("\n")[0]}`}`);
        return undefined;
    }
}
export async function collectGit(workspaceRoot) {
    const started = Date.now();
    const root = await git(workspaceRoot, ["rev-parse", "--show-toplevel"]);
    if (!root)
        return { repositoryInfo: [], gitRepos: [], statusComplete: true };
    const remotesRaw = (await git(root, ["remote", "-v"])) ?? "";
    const remote_urls = [];
    const remote_names = [];
    for (const line of remotesRaw.split("\n")) {
        const m = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)/);
        if (!m)
            continue;
        remote_names.push(m[1]);
        remote_urls.push(m[2]);
    }
    const primary = remote_urls[0] ?? "";
    let repo_owner = "";
    let repo_name = path.basename(root);
    const gh = primary.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (gh) {
        repo_owner = gh[1];
        repo_name = gh[2];
    }
    const branch = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])) || "HEAD";
    const statusStarted = Date.now();
    const status = await git(root, ["status", "--porcelain", "-b"]);
    trace(`git: discovery elapsedMs=${Date.now() - started} statusMs=${Date.now() - statusStarted} statusComplete=${status !== undefined}`);
    const repositoryInfo = [
        {
            relative_workspace_path: ".",
            remote_urls,
            remote_names,
            repo_name,
            repo_owner,
            is_tracked: remote_urls.length > 0,
            is_local: remote_urls.length === 0,
            workspace_uri: `file://${root}`,
        },
    ];
    const gitRepos = [
        {
            path: root,
            status: (status ?? "").slice(0, 4000),
            branch_name: branch,
            ...(primary ? { remote_url: primary } : {}),
        },
    ];
    return { repositoryInfo, gitRepos, statusComplete: status !== undefined };
}
