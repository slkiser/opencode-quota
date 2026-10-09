import { type ModelInfo, type ModelVariant } from "./models.js";
/**
 * Display names shared by both a thinking and a non-thinking model. A thinking
 * model with such a name needs a "Thinking" tag to disambiguate it from its
 * non-thinking twin (Cursor's Claude/Fable/Sonnet families). Models whose names
 * are already unique — including Cursor's GPT family, where the reasoning tier
 * ("None"/"Low"/"High"…) is baked into the name — are excluded, so they aren't
 * tagged redundantly.
 */
export declare function thinkingSuffixBaseNames(models: ModelInfo[]): Set<string>;
/**
 * models.dev-style family for a Cursor model id: the id without its version
 * segments and context/speed suffixes (`claude-haiku-4-5` → `claude-haiku`,
 * `gemini-3.8-flash` → `gemini-flash`, `gpt-5.6-luna` → `gpt-luna`).
 * Kimi keeps its major generation (`kimi-k2.7-code` → `kimi-k2`). OpenCode
 * picks its small title model by family and falls back to the session model when
 * no entry has one. Cursor Auto (`default`) is not a model family.
 */
export declare function cursorModelFamily(id: string): string | undefined;
export declare function modelInfoToConfig(mi: ModelInfo, options?: {
    thinkingSuffix?: boolean;
    contextTier?: "base" | "long";
    variants?: ModelVariant[];
    fast?: boolean;
}): Record<string, any>;
export declare function modelsToConfig(models: ModelInfo[]): Record<string, any>;
