import type { OAuthAuthDetails, PluginClient } from './types';
export declare function refreshAccessToken(auth: OAuthAuthDetails, client: PluginClient): Promise<OAuthAuthDetails | undefined>;
