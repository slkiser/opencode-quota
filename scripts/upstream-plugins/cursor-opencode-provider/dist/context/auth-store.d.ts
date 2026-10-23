/** Mirrors OpenCode / SDK OAuth + API auth used for Cursor. `wellknown` is not wired yet. */
export type StoredAuth = {
    type: "oauth";
    access: string;
    refresh: string;
    expires: number;
    accountId?: string;
    enterpriseUrl?: string;
} | {
    type: "api";
    key: string;
    metadata?: Record<string, string>;
};
/**
 * Read a provider's credentials from OpenCode's `auth.json` (XDG data dir).
 *
 * Honors `OPENCODE_AUTH_CONTENT` when set — same injection hook OpenCode core
 * uses in tests / embedded runs (not an SDK export).
 */
export declare function readStoredAuth(providerId: string): Promise<StoredAuth | undefined>;
export declare function asStoredAuth(value: unknown): StoredAuth | undefined;
