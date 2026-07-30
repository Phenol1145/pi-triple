/**
 * 唯一名称来源 — 调度器 / 实例 / 优化器 / 路由绑定 的常量定义。
 *
 * Phase 1：常量名使用 MARKET_* 前缀表达未来语义意图，值暂保持现状。
 * Phase 2：将 market 相关常量值改为 "market" 系列后，调用方无需修改符号。
 */
// 调度器定义 id
export const MARKET_SCHEDULER_DEFINITION_ID = "arena"; // Phase 2 改值 → "market"
export const WEIGHTED_SCORER_DEFINITION_ID = "weighted-scorer";
// 默认实例 id
export const DEFAULT_MARKET_INSTANCE_ID = "default-arena"; // Phase 2 → "default-market"
export const DEFAULT_WEIGHTED_SCORER_INSTANCE_ID = "default-weighted-scorer";
// 优化器
export const WEIGHTED_TUNER_OPTIMIZER_ID = "weighted-tuner";
export const DEFAULT_WEIGHTED_TUNER_INSTANCE_ID = "default-weighted-tuner";
// 路由绑定
export const MARKET_DEFAULT_BINDING_ID = "arena-default"; // Phase 2 → "market-default"
export const WEIGHTED_SCORER_DEFAULT_BINDING_ID = "default";
