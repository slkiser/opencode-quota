import type { OAuthAuthDetails, PluginClient, ProjectContextResult } from '../types';
/**
 * Clears cached project context results and pending Promises.
 */
export declare function invalidateProjectContextCache(refresh?: string): void;
/**
 * Resolves the project context corresponding to the access token, optionally persisting updated auth details.
 */
export declare function resolveProjectContextFromAccessToken(auth: OAuthAuthDetails, accessToken: string, configuredProjectId?: string, persistAuth?: (auth: OAuthAuthDetails) => Promise<void>, userAgentModel?: string): Promise<ProjectContextResult>;
/**
 * Resolves the effective project ID for the current auth state and caches the result by refresh token.
 */
export declare function ensureProjectContext(auth: OAuthAuthDetails, client: PluginClient, configuredProjectId?: string, userAgentModel?: string): Promise<ProjectContextResult>;
