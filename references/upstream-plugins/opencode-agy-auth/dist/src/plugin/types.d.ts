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
