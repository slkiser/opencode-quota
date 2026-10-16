import type { RetrieveUserQuotaResponse, RetrieveUserQuotaSummaryResponse } from '../plugin/project/types';
/**
 * Fetches the Code Assist quota bucket information, which contains the model IDs visible to the current account/project.
 */
export declare function retrieveUserQuota(accessToken: string, projectId: string, userAgentModel?: string): Promise<RetrieveUserQuotaResponse | null>;
/**
 * Fetches the Code Assist quota summary, grouped by model family with window-based buckets.
 */
export declare function retrieveUserQuotaSummary(accessToken: string, projectId: string, userAgentModel?: string): Promise<RetrieveUserQuotaSummaryResponse | null>;
