/**
 * Simulates the experimental fetch and metric telemetry traffic sent periodically by the official Agy client in the background to prevent API bans or anomaly detection.
 */
export declare function simulateClientBackgroundTraffic(accessToken: string, projectId: string, userAgentModel?: string): void;
export declare function buildTrajectoryAnalyticsBody(cascadeId?: `${string}-${string}-${string}-${string}-${string}`, platform?: string): {
    trajectory: {
        cascadeId: `${string}-${string}-${string}-${string}-${string}`;
        executorMetadatas: {
            cascadeConfig: {
                agentApiConfig: {
                    enabled: boolean;
                };
                checkpointConfig: {
                    checkpointModel: string;
                    strategy: string;
                    maxTokenLimit: string;
                    tokenThreshold: string;
                    maxOverheadRatio: string;
                    movingWindowSize: string;
                    enabled: boolean;
                    maxOutputTokens: string;
                    useLastPlannerModel: boolean;
                    isSync: boolean;
                    maxUserRequests: number;
                    includeLastUserMessage: boolean;
                    includeConversationLog: boolean;
                    includeRunningTaskSnapshots: boolean;
                    includeSubagentSnapshots: boolean;
                    includeArtifactSnapshots: boolean;
                    retryConfig: {
                        maxRetries: number;
                        initialSleepDurationMs: number;
                        exponentialMultiplier: number;
                        includeErrorFeedback: boolean;
                    };
                };
            };
        }[];
    };
    mendelExperimentIds: never[];
    metadata: {
        ideType: string;
        ideVersion: string;
        platform: string;
    };
    startStepIndex: string;
};
