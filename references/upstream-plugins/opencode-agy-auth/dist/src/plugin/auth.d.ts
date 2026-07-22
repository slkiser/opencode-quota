import type { AuthDetails, OAuthAuthDetails, RefreshParts } from './types';
export declare function isOAuthAuth(auth: AuthDetails): auth is OAuthAuthDetails;
/**
 * Splits the packed refresh string into the corresponding refresh token and project ID.
 */
export declare function parseRefreshParts(refresh: string): RefreshParts;
/**
 * Serializes the parts of a refresh token into the stored string format.
 */
export declare function formatRefreshParts(parts: RefreshParts): string;
/**
 * Determines whether the access token has expired or is missing, with a buffer for clock skew.
 */
export declare function accessTokenExpired(auth: OAuthAuthDetails): boolean;
