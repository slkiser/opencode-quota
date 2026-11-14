import { type CursorConversationTokenDetails } from "./protocol/token-details.js";
/** A confirmation policy, not an inferred model-call count or corrected token estimate. */
export type OccupancyObservation = {
    boundary?: string;
    model?: string;
    bypass?: boolean;
};
export type OccupancyGuard = {
    version: 1;
    model?: string;
    needsFreshBaseline?: true;
    pending?: {
        details: CursorConversationTokenDetails;
        boundary?: string;
    };
};
/** Match an unexplained conversation-only jump; missing evidence always admits the raw reading. */
export declare function isUnexplainedOccupancyJump(previous: CursorConversationTokenDetails, current: CursorConversationTokenDetails): boolean;
export declare function sameOccupancyReading(a: CursorConversationTokenDetails, b: CursorConversationTokenDetails): boolean;
export declare function selectCheckpointOccupancy(previous: CursorConversationTokenDetails | undefined, current: CursorConversationTokenDetails, guard: OccupancyGuard, observation?: OccupancyObservation): {
    hold: boolean;
    guard: OccupancyGuard;
};
/** Guard metadata is private cache data; reject malformed or unbounded records. */
export declare function parseOccupancyGuard(value: string | undefined): OccupancyGuard | undefined;
