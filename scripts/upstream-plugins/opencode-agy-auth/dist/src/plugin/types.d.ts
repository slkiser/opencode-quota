import type { OpencodeClient, Auth } from '@opencode-ai/sdk';
import type { Provider as ProviderV1 } from '@opencode-ai/sdk';
import type { Model as ModelV2 } from '@opencode-ai/sdk/v2';
import type { Hooks, Config as PluginConfig } from '@opencode-ai/plugin';
export type OAuthAuthDetails = Extract<Auth, {
    type: 'oauth';
}>;
export type AuthDetails = Auth;
export type GetAuth = () => Promise<AuthDetails>;
export type Provider = ProviderV1;
export type ProviderModel = ModelV2;
export type Config = PluginConfig;
export interface LoaderResult {
    apiKey: string;
    fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
}
export type PluginClient = OpencodeClient;
export interface PluginContext {
    client: PluginClient;
}
export type PluginResult = Hooks;
export interface RefreshParts {
    refreshToken: string;
    projectId?: string;
    managedProjectId?: string;
}
export interface ProjectContextResult {
    auth: OAuthAuthDetails;
    effectiveProjectId: string;
}
export type { Provider as ProviderV2, Model as ModelV2 } from '@opencode-ai/sdk/v2';
export interface OpenCodeV2TransformRegistry<T = any> {
    transform: (fn: (target: T) => Promise<void> | void) => void;
}
export interface OpenCodeV2SessionRegistry {
    hook: (name: string, handler: (...args: any[]) => any, options?: {
        providerID?: string;
    }) => void;
}
export interface OpenCodeV2PluginLocation {
    root?: string;
    workspace?: string;
}
export interface OpenCodeV2PluginContext {
    catalog?: OpenCodeV2TransformRegistry;
    provider?: OpenCodeV2TransformRegistry;
    model?: OpenCodeV2TransformRegistry;
    tool: OpenCodeV2TransformRegistry;
    command: OpenCodeV2TransformRegistry;
    session: OpenCodeV2SessionRegistry;
    aisdk?: {
        hook: (name: 'sdk' | 'language', handler: (event: any) => Promise<void> | void) => void;
    };
    integration?: OpenCodeV2TransformRegistry | {
        transform?: (transformer: (editor: any) => void) => void;
    };
    location: OpenCodeV2PluginLocation;
}
export interface OpenCodeV2PluginDefinition {
    id: string;
    setup: (ctx: OpenCodeV2PluginContext) => Promise<void> | void;
}
export interface DualOpenCodePlugin extends OpenCodeV2PluginDefinition {
    server: (options: any) => Promise<any>;
}
export declare function defineOpenCodeV2Plugin(def: OpenCodeV2PluginDefinition): OpenCodeV2PluginDefinition;
