import type { PluginClient } from "./types";
/**
 * Shows a Toast notification to the user when the server-side Agy model capacity is exhausted.
 */
export declare function maybeShowAgyCapacityToast(client: PluginClient, response: Response, projectId: string, requestedModel?: string): Promise<void>;
/**
 * Temporary smoke test Toast, only enabled when OPENCODE_AGY_TEST_TOAST=1.
 */
export declare function maybeShowAgyTestToast(client: PluginClient, projectId: string): Promise<void>;
