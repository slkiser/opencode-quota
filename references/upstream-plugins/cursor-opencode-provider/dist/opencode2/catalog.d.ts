import { type ModelInfo } from "../models.js";
import { type OpenCode2ModelCost } from "../pricing.js";
import type { ConnectionInfo, ModelVariantInfo, ProviderEditor } from "./types.js";
/**
 * In-memory provider registration for the OpenCode 2.0 plugin — the replacement
 * for the classic plugin's `config` hook.
 *
 * Model naming, thinking suffixes, and long-context tiering are NOT reimplemented
 * here: we run the shared `modelsToConfig` and translate its output into the 2.0
 * `Model.Info` shape, so every surface exposes an identical model list.
 */
/** Integration id owning Cursor credentials. Matches the provider id. */
export declare const CURSOR_INTEGRATION_ID = "cursor";
/**
 * `aisdk:` selects OpenCode 2.0's AI SDK path, which is what surfaces the
 * `aisdk.hook("sdk")` / `("language")` extension points we supply the provider
 * through. The suffix is this package's npm name so the host's built-in
 * fallback can still resolve it if our own hook is ever bypassed — that
 * fallback runs `npm.add(pkg)` against the *published* registry into
 * `<host-cache>/packages/<pkg>/node_modules/<pkg>`, ignoring any local
 * `file://` plugin path this process was loaded from.
 *
 * `CURSOR_OPENCODE2_DEV_ENTRY` overrides the suffix with an `aisdk:file://…`
 * spec instead, pointed at a local built entry file (e.g. `dist/index.js`,
 * which exports `createCursor`). The host's fallback recognizes `file://`
 * specs and imports them directly, skipping `npm.add` — the only way to
 * exercise a local build through that fallback path short of publishing.
 * Unset in production; only meant for local `opencode2 run` testing.
 */
export declare const CURSOR_AISDK_PACKAGE: string;
/**
 * Plain-object `Model.Info` equivalent used by `ctx.provider.transform`.
 */
export type CatalogModelInfo = {
    id: string;
    modelID: string;
    providerID: string;
    name: string;
    family?: string;
    capabilities: {
        tools: boolean;
        input: string[];
        output: string[];
    };
    limit: {
        context: number;
        output: number;
    };
    variants: ModelVariantInfo[];
    status: "active";
    enabled: true;
    time: {
        released: number;
    };
    cost: OpenCode2ModelCost[];
    settings?: Record<string, unknown>;
};
/** Translate one `modelsToConfig` entry into the 2.0 `Model.Info` shape. */
export declare function modelConfigEntryToInfo(id: string, entry: Record<string, any>): CatalogModelInfo;
/** Full model map for the in-memory provider inventory. */
export declare function modelsToCatalogModelMap(models: ModelInfo[]): Record<string, CatalogModelInfo>;
/**
 * Publish discovered Cursor models into the live provider inventory.
 *
 * Skip while empty (keeps the last successful inventory through a no-op
 * transform on first register), replace the definition with `editor.add`,
 * then `ctx.provider.reload()`.
 */
export declare function applyCursorProviderInventory(editor: ProviderEditor, models: ModelInfo[], sourceConnection?: ConnectionInfo): void;
