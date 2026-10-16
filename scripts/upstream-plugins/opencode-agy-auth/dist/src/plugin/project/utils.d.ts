import type { OAuthAuthDetails } from "../types";
import { type CloudAiCompanionProject, type AgyIneligibleTier, type AgyUserTier } from "./types";
/**
 * Builds the metadata headers required for the Code Assist API.
 */
export declare function buildMetadata(projectId?: string, includeDuetProject?: boolean): Record<string, string>;
/**
 * Normalizes project identifiers from API payloads or configuration.
 */
export declare function normalizeProjectId(value?: string | CloudAiCompanionProject): string | undefined;
/**
 * Selects the default hierarchy ID from the allowed hierarchy list.
 */
export declare function pickOnboardTier(allowedTiers?: AgyUserTier[]): AgyUserTier;
/**
 * Builds a concise error message for non-compliant hierarchy payloads.
 */
export declare function buildIneligibleTierMessage(tiers?: AgyIneligibleTier[]): string | undefined;
export declare function throwIfValidationRequired(tiers?: AgyIneligibleTier[]): void;
/**
 * Detects VPC-SC errors from Cloud Code responses.
 */
export declare function isVpcScError(payload: unknown): boolean;
/**
 * Safely parses JSON, returning null on failure.
 */
export declare function parseJsonSafe(text: string): unknown;
/**
 * Promise-based delay utility.
 */
export declare function wait(ms: number): Promise<void>;
/**
 * Generates a cache key for the project context based on the refresh token.
 */
export declare function getCacheKey(auth: OAuthAuthDetails): string | undefined;
