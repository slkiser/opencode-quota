import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
const execFileAsync = promisify(execFile);
async function git(cwd, args) {
    try {
        const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf-8", timeout: 5000 });
        return stdout.trim();
    }
    catch {
        return "";
    }
}
export async function collectGit(workspaceRoot) {
    const root = await git(workspaceRoot, ["rev-parse", "--show-toplevel"]);
    if (!root)
        return { repositoryInfo: [], gitRepos: [] };
    const remotesRaw = await git(root, ["remote", "-v"]);
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
    const status = await git(root, ["status", "--porcelain", "-b"]);
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
            status: status.slice(0, 4000),
            branch_name: branch,
            ...(primary ? { remote_url: primary } : {}),
        },
    ];
    return { repositoryInfo, gitRepos };
}
