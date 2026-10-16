import { createCursorLanguageModel } from "./language-model.js";
import type { CreateCursorOptions } from "./index.js";
/**
 * Runtime-agnostic pieces shared by every plugin surface:
 *   • classic Hooks plugin      (`plugin.ts`)
 *   • OpenCode 1.18 v2 plugin   (`plugin-v2.ts`)
 *   • OpenCode 2.0 beta plugin  (`plugin-opencode2.ts`)
 *
 * Nothing here may import a host plugin API — the 1.18 and 2.0 APIs are
 * source-incompatible, so anything host-shaped belongs in the entrypoint.
 */
/** Minimal AI SDK provider surface OpenCode expects from an `aisdk` package. */
export type CursorSdk = {
    languageModel(modelId: string): ReturnType<typeof createCursorLanguageModel>;
};
export declare function createSdk(options: CreateCursorOptions): CursorSdk;
/**
 * Whether an OpenCode `aisdk` package string refers to this provider.
 *
 * Matches on the provider id first (the common case once the catalog entry is
 * ours), then on the package specifier so a bare `cursor-opencode-provider`,
 * an `aisdk:`-prefixed form, or a resolved `dist/index.js` file URL all hit.
 */
export declare function isCursorPackage(pkg: string, providerID: string): boolean;
/** API base for auth, model discovery, and GetServerConfig. */
export declare function cursorApiBaseURL(): string;
export declare function cursorGetServerConfigTelemetryEnabled(): boolean;
