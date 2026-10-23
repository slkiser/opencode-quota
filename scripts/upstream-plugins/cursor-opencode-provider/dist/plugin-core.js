import { CURSOR_API_HOST, CURSOR_PROVIDER_ID } from "./shared.js";
import { createCursorLanguageModel } from "./language-model.js";
export function createSdk(options) {
    const providerId = options.name || CURSOR_PROVIDER_ID;
    return {
        languageModel(modelId) {
            return createCursorLanguageModel(modelId, providerId, options);
        },
    };
}
/**
 * Whether an OpenCode `aisdk` package string refers to this provider.
 *
 * Matches on the provider id first (the common case once the catalog entry is
 * ours), then on the package specifier so a bare `cursor-opencode-provider`,
 * an `aisdk:`-prefixed form, or a resolved `dist/index.js` file URL all hit.
 */
export function isCursorPackage(pkg, providerID) {
    if (providerID === CURSOR_PROVIDER_ID)
        return true;
    return (pkg.includes("cursor-opencode-provider") ||
        /cursor-opencode-provider[/\\]dist[/\\]index\.js/.test(pkg));
}
/** API base for auth, model discovery, and GetServerConfig. */
export function cursorApiBaseURL() {
    return process.env.CURSOR_API_BASE_URL ?? `https://${CURSOR_API_HOST}`;
}
export function cursorGetServerConfigTelemetryEnabled() {
    return (process.env.CURSOR_GET_SERVER_CONFIG_TELEMETRY === "1" ||
        process.env.CURSOR_GET_SERVER_CONFIG_TELEMETRY === "true");
}
