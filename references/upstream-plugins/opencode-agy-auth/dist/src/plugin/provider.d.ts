import type { Config } from "./types";
import type { PluginClient, Provider } from "./types";
interface ResolveConfiguredProjectIdInput {
    provider?: Provider | null;
    config?: Config | null;
    configProjectId?: string;
    env?: NodeJS.ProcessEnv;
}
export declare function resolveConfiguredProjectId(input?: ResolveConfiguredProjectIdInput): string | undefined;
export declare function resolveConfiguredProjectIdFromConfig(config: Config | null | undefined): string | undefined;
export declare function resolveConfiguredProjectIdFromClient(client: PluginClient | null | undefined): Promise<string | undefined>;
export {};
