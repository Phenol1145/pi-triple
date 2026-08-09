/**
 * Framework-layer definition id constants.
 *
 * ADR-0001/0002: "market" is the canonical term for the bidding-based scheduler.
 * Definition ids and binding ids use market terminology; UUID identity is stable.
 * Definition ids are registration keys the framework must know — hence they
 * live in the framework layer (scheduler/) rather than the plugin layer.
 */
export const MARKET_SCHEDULER_DEFINITION_ID = "market";
export const WEIGHTED_SCORER_DEFINITION_ID = "weighted-scorer";
