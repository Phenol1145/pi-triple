/**
 * Canonical name constants — scheduler / instance / optimizer / routing binding.
 *
 * ADR-0001/0002: "market" is the canonical term for the bidding-based scheduler.
 * Definition ids and binding ids use market terminology; UUID identity is stable.
 */
// 调度器定义 id
export const MARKET_SCHEDULER_DEFINITION_ID = "market";
export const WEIGHTED_SCORER_DEFINITION_ID = "weighted-scorer";
// 优化器
export const WEIGHTED_TUNER_OPTIMIZER_ID = "weighted-tuner";
export const DEFAULT_WEIGHTED_TUNER_INSTANCE_ID = "default-weighted-tuner";
// 路由绑定
export const MARKET_DEFAULT_BINDING_ID = "market-default";
export const WEIGHTED_SCORER_DEFAULT_BINDING_ID = "default";

// ── Logical instance names (ADR-0002 UUID identity) ──────────────────
// These are the mutable name attribute; the stable identity is UUID.
export const DEFAULT_MARKET_NAME = "default-market";
export const DEFAULT_WEIGHTED_SCORER_NAME = "default-weighted-scorer";
export const DEFAULT_WEIGHTED_TUNER_NAME = "default-weighted-tuner";
export const MARKET_DEFAULT_BINDING_NAME = "market-default";
