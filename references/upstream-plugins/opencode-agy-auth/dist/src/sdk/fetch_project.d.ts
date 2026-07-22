import { type LoadCodeAssistPayload } from '../plugin/project/types';
/**
 * Loads hosted project information for a given access token and optional project.
 */
export declare function loadManagedProject(accessToken: string, projectId?: string, userAgentModel?: string): Promise<LoadCodeAssistPayload | null>;
/**
 * Enables a hosted project for the user, optionally retrying until complete.
 */
export declare function onboardManagedProject(accessToken: string, tierId: string, projectId?: string, userAgentModel?: string, attempts?: number, delayMs?: number): Promise<string | undefined>;
