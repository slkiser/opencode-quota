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
export declare function collectGit(workspaceRoot: string): Promise<{
    repositoryInfo: RepoInfo[];
    gitRepos: GitRepoInfo[];
}>;
