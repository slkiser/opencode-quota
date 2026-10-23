import type { OpencodeJson } from "./rules.js";
export type CollectedPlugin = {
    id: string;
    source: "npm" | "local";
    path?: string;
};
/** OpenCode plugins from config + local plugin directories (metadata only). */
export declare function collectPlugins(workspaceRoot: string, config: OpencodeJson): Promise<CollectedPlugin[]>;
