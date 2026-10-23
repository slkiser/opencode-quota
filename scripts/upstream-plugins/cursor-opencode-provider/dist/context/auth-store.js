import { readFile } from "node:fs/promises";
import path from "node:path";
import { hostGlobalDataDir } from "./paths.js";
function debugEnabled() {
    return process.env.CURSOR_PROVIDER_DEBUG === "1" || process.env.CURSOR_PROVIDER_DEBUG === "true";
}
function debugAuthStore(message) {
    if (!debugEnabled())
        return;
    console.debug(`[cursor-opencode-provider] auth-store: ${message}`);
}
/**
 * Read a provider's credentials from OpenCode's `auth.json` (XDG data dir).
 *
 * Honors `OPENCODE_AUTH_CONTENT` when set — same injection hook OpenCode core
 * uses in tests / embedded runs (not an SDK export).
 */
export async function readStoredAuth(providerId) {
    if (process.env.OPENCODE_AUTH_CONTENT) {
        try {
            const data = JSON.parse(process.env.OPENCODE_AUTH_CONTENT);
            return asStoredAuth(data[providerId]);
        }
        catch {
            debugAuthStore("OPENCODE_AUTH_CONTENT is not valid JSON");
            return undefined;
        }
    }
    const filePath = path.join(hostGlobalDataDir(), "auth.json");
    try {
        const raw = await readFile(filePath, "utf-8");
        try {
            const data = JSON.parse(raw);
            return asStoredAuth(data[providerId]);
        }
        catch {
            debugAuthStore("auth.json is not valid JSON");
            return undefined;
        }
    }
    catch (err) {
        const code = err?.code;
        if (code !== "ENOENT") {
            debugAuthStore(`failed to read auth.json (${code ?? "unknown"})`);
        }
        return undefined;
    }
}
export function asStoredAuth(value) {
    if (!value || typeof value !== "object")
        return undefined;
    const v = value;
    if (v.type === "oauth" &&
        typeof v.access === "string" &&
        typeof v.refresh === "string" &&
        typeof v.expires === "number") {
        return value;
    }
    if (v.type === "api" && typeof v.key === "string") {
        return value;
    }
    // wellknown is intentionally rejected until resolveAccessToken supports it
    return undefined;
}
