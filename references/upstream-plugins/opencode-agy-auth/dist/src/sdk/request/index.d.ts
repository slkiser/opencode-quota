/**
 * NOTE: The request module here handles serialization, deserialization, and streaming data conversion between the standard OpenAI protocol and Agy's native Gemini protocol.
 * Though normally an app/adapter layer responsibility, it's highly coupled with Agy's exclusive SSE streaming deduplication and multi-turn signature caching,
 * so to ensure a simple and clean external interface, we package it as a built-in SDK capability, shielding the upper layer from all protocol conversion internal complexities.
 */
export { prepareAgyRequest } from "./prepare";
export type { ThinkingConfigDefaults } from "./prepare";
export { transformAgyResponse } from "./response";
export { isGenerativeLanguageRequest, parseGenerativeLanguageRequest } from "./shared";
export { initTurnStateTracker, getTurnStateTracker, shutdownTurnStateTracker, TurnStateTracker } from "./turn-state-tracker";
export type { TurnState } from "./turn-state-tracker";
