// Bucket export for the `arena` domain.
// Aggregates the externally-consumed public API (functions, classes, types).
// Pure re-exports only — no new logic; deep imports remain compatible.
export { findOrCreateAgentByModel } from "./agent-id.ts";
export { SqliteLedger } from "./ledger.ts";

export {
  CostModelV1,
  DEFAULT_BID_PROMPT,
  EndowmentPolicyV1,
  OddsPolicyV1,
  SettlementPolicyV1,
  parseBidResponse,
  renderBidPrompt,
} from "./policies.ts";

export type {
  AgentState,
  ArenaTask,
  EndowmentPolicy,
  Ledger,
  MarketTaskRow,
  ModelCaller,
  Outcome,
} from "./types.ts";
