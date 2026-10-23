export type LayoutNode = {
    abs_path: string;
    children_dirs: LayoutNode[];
    children_files: Array<{
        name: string;
    }>;
    children_were_processed: boolean;
    num_files: number;
};
/**
 * Shallow project layout for RequestContext.project_layouts.
 * Caps depth and entries to keep the payload small.
 */
export declare function collectProjectLayout(workspaceRoot: string, opts?: {
    maxDepth?: number;
    maxEntries?: number;
}): Promise<LayoutNode>;
