export type RepoInfo = {
    relative_workspace_path: string;
    remote_urls: string[];
    remote_names: string[];
    repo_name: string;
    repo_owner: string;
    is_tracked: boolean;
    is_local: boolean;
    workspace_uri: string;
};
export type GitRepoInfo = {
    path: string;
    status: string;
    branch_name: string;
    remote_url?: string;
};
export type GitFacts = {
    repositoryInfo: RepoInfo[];
    gitRepos: GitRepoInfo[];
    /** False when `git status` failed or timed out, so the status is not the real one. */
    statusComplete: boolean;
};
export declare function collectGit(workspaceRoot: string): Promise<GitFacts>;
