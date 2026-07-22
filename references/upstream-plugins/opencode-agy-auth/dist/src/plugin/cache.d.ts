import type { OAuthAuthDetails } from "./types";
import { SignatureCache, type SignatureCacheConfig } from "../sdk/cache/signature-cache";
/**
 * Extracts valid OAuthAuthDetails from cache. Reuses an available and unexpired Token if present, otherwise prioritizes the latest provided value.
 */
export declare function resolveCachedAuth(auth: OAuthAuthDetails): OAuthAuthDetails;
/**
 * Explicitly updates or saves authorized token details to the cache.
 */
export declare function storeCachedAuth(auth: OAuthAuthDetails): void;
/**
 * Clears cached login authorization details. If no refresh token is provided, clears the global cache.
 */
export declare function clearCachedAuth(refresh?: string): void;
/**
 * Initializes the disk-level signature storage manager.
 */
export declare function initDiskSignatureCache(config: SignatureCacheConfig | undefined): SignatureCache | null;
/**
 * Caches a thought chain fragment and its corresponding service signature, synchronously saving it to disk.
 */
export declare function cacheSignature(sessionId: string, text: string, signature: string): void;
/**
 * Recovers and retrieves the most recently cached signature for a session (supports signature recovery).
 */
export declare function getLatestSignature(sessionId: string): string | undefined;
export type { SignatureCache } from "../sdk/cache/signature-cache";
export type { SignatureCacheConfig } from "../sdk/cache/signature-cache";
