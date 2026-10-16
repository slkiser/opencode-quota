export interface AvailableModelDetails {
    displayName: string;
    supportsImages?: boolean;
    supportsThinking?: boolean;
    thinkingBudget?: number;
    minThinkingBudget?: number;
    recommended?: boolean;
    maxTokens?: number;
    maxOutputTokens?: number;
    tokenizerType?: string;
    quotaInfo?: {
        remainingFraction?: number;
        resetTime?: string;
    };
    model?: string;
    apiProvider?: string;
    modelProvider?: string;
    supportsVideo?: boolean;
    supportedMimeTypes?: Record<string, boolean>;
    modelExperiments?: Record<string, unknown>;
    [key: string]: unknown;
}
export interface FetchAvailableModelsResponse {
    models?: Record<string, AvailableModelDetails>;
    defaultAgentModelId?: string;
    agentModelSorts?: Array<{
        displayName: string;
        groups: Array<{
            modelIds: string[];
        }>;
    }>;
    commandModelIds?: string[];
    tabModelIds?: string[];
    imageGenerationModelIds?: string[];
    mqueryModelIds?: string[];
    webSearchModelIds?: string[];
    deprecatedModelIds?: Record<string, unknown>;
    commitMessageModelIds?: string[];
    audioTranscriptionModelIds?: string[];
    experimentIds?: number[];
    tieredModelIds?: Record<string, string[]>;
    [key: string]: unknown;
}
/**
 * Fetches the list of available models for the current account under the specified project from the Agy server.
 */
export declare function fetchAvailableModels(accessToken: string, projectId: string, userAgentModel?: string): Promise<FetchAvailableModelsResponse>;
