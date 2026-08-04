// Bucket export for the `economy` domain.
// Aggregates the externally-consumed public API (functions, classes, types,
// constants). Pure re-exports only — no new logic; deep imports remain
// fully compatible and are unaffected.
export {
  CENTRAL_POOL_ID,
  RESERVED_IDS,
  ensureCentralPool,
  poolCredit,
  poolDebit,
} from "./central-pool.ts";

export {
  EloFormulaRegistry,
  SelectionFormulaRegistry,
  createStakeEloPower,
  simpleElo,
  stakeEloPower,
  taskRatingFromOdds,
} from "./elo.ts";
export type { EloFormula, SelectionFormula } from "./elo.ts";

export { SqliteVoucher, VOUCHER_PHYSICAL_ANCHOR } from "./voucher-port.ts";
export type { VoucherPort } from "./voucher-port.ts";

export { EconomyEventBus } from "./economy-events.ts";
export type { EconomyEvent } from "./economy-events.ts";

export { MarketStore } from "./market-store.ts";
export type { MarketTask } from "./market-store.ts";

export {
  CALIBRATION_EXECUTOR_ID,
  CalibrationPool,
  calibrationExecutorRun,
} from "./calibration.ts";
export type { CalibrationTask } from "./calibration.ts";

export { registerMarketCodeFns } from "./market-fns.ts";
export type { CodeRegistry, MarketFnsDeps } from "./market-fns.ts";

export { emitBurn, registerMarketEffectFns } from "./market-effects.ts";
export type { EffectRegistry, MarketEffectsDeps } from "./market-effects.ts";

export { SqliteTaskTypeRegistry } from "./task-types.ts";
export type { TaskType } from "./task-types.ts";

export {
  DEFAULT_TAX_RATE,
  computeConsensus,
  planSettlement,
} from "./settlement.ts";
export type { ReviewInput, SettlementPlan } from "./settlement.ts";

export {
  adjustEscrow,
  escrowActual,
  escrowMax,
  freezeBid,
  freezeEscrowMax,
  releaseBid,
} from "./escrow.ts";
export type { EscrowParams } from "./escrow.ts";

export {
  experiencesFromSettlement,
  orgDefaultExperiences,
  sedimentExperiences,
} from "./experience.ts";
export type { SettlementExperience } from "./experience.ts";

export {
  SqliteOrgMembership,
  executeOrgPayout,
  orgProfitAfterPayouts,
  planPayouts,
  voucherCostForTask,
} from "./org.ts";
export type { OrgPayoutDeps } from "./org.ts";

export { projectEconomy } from "./projections.ts";
export type { EconomyReport } from "./projections.ts";

export { MarketRunner } from "./market-runner.ts";
export type { MarketRunnerDeps } from "./market-runner.ts";

export { reviewShortlist, selectReviewers } from "./review-round.ts";
export type { ReviewRoundDeps, ReviewRoundResult } from "./review-round.ts";
