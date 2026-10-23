import type { ProviderModel } from './types';
/**
 * Mutates the STATIC_MODELS object by injecting dynamic costs from models.dev
 */
export declare function updateStaticModelsWithPricing(staticModels: Record<string, ProviderModel>): void;
