export declare const FREE_TIER_ID = "free-tier";
export declare const LEGACY_TIER_ID = "legacy-tier";
export declare const CODE_ASSIST_METADATA: {
    readonly ideType: "ANTIGRAVITY";
};
export interface AgyUserTier {
    id?: string;
    isDefault?: boolean;
    userDefinedCloudaicompanionProject?: boolean;
    name?: string;
    description?: string;
}
export interface CloudAiCompanionProject {
    id?: string;
}
export interface AgyIneligibleTier {
    reasonCode?: string;
    reasonMessage?: string;
    validationUrl?: string;
    validationLearnMoreUrl?: string;
}
export interface LoadCodeAssistPayload {
    cloudaicompanionProject?: string | CloudAiCompanionProject;
    currentTier?: {
        id?: string;
        name?: string;
    };
    allowedTiers?: AgyUserTier[];
    ineligibleTiers?: AgyIneligibleTier[];
}
export interface OnboardUserPayload {
    name?: string;
    done?: boolean;
    response?: {
        cloudaicompanionProject?: {
            id?: string;
        };
    };
}
export interface RetrieveUserQuotaBucket {
    remainingAmount?: string;
    remainingFraction?: number;
    resetTime?: string;
    tokenType?: string;
    modelId?: string;
}
export interface RetrieveUserQuotaResponse {
    buckets?: RetrieveUserQuotaBucket[];
}
export interface QuotaSummaryBucket {
    bucketId?: string;
    displayName?: string;
    description?: string;
    window?: string;
    remaining?: string;
    remainingFraction?: number;
    remainingAmount?: string;
    disabled?: boolean;
    resetTime?: string;
}
export interface QuotaSummaryGroup {
    displayName?: string;
    description?: string;
    buckets?: QuotaSummaryBucket[];
}
export interface RetrieveUserQuotaSummaryResponse {
    groups?: QuotaSummaryGroup[];
    buckets?: QuotaSummaryBucket[];
    description?: string;
}
/**
 * Thrown during Gemini enablement if the required Google Cloud project is missing.
 */
export declare class ProjectIdRequiredError extends Error {
    constructor();
}
export declare class ProjectAccessDeniedError extends Error {
    constructor(projectId: string | undefined, backendMessage: string | undefined);
}
export declare class AccountValidationRequiredError extends Error {
    validationUrl?: string;
    validationLearnMoreUrl?: string;
    constructor(message: string, validationUrl?: string, validationLearnMoreUrl?: string);
}
