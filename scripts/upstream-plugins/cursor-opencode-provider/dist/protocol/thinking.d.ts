export type EffortConfig = {
    reasoningEffort?: string;
    maxMode?: boolean;
};
/**
 * Build RequestedModel parameter list from a model's variant parameters
 * and optional overrides from providerOptions.
 */
export declare function buildRequestedModelParams(variantParameters: Array<{
    id: string;
    value: string;
}>, options?: EffortConfig): Array<{
    id: string;
    value: string;
}>;
