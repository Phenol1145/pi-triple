// Bucket export for the `core` domain.
// Aggregates the externally-consumed public API (functions, classes, types,
// constants). Pure re-exports only — no new logic; deep imports remain
// fully compatible and are unaffected.
export { createLabCore } from "./create-core.ts";
export type { LabCore } from "./create-core.ts";

export {
  modelToAgentCreateSpec,
  modelToAgentDefinition,
} from "./agent-spec.ts";

export type {
  AgentCreateSpec,
  AgentDefinition,
  AgentInstanceRecord,
  DefinitionRef,
  FallbackTarget,
  JsonSchema,
  LabEvent,
  OptimizationRoundRecord,
  OptimizerDefinition,
  SchedulerDefinition,
  WorkLoopDefinition,
} from "./contracts.ts";

export { withSharedTransaction } from "./tx-utils.ts";
export { diffLeafPaths } from "./parameter-diff.ts";
export { matchesVersionRange } from "./version-range.ts";
export { EventLog } from "./events/event-log.ts";

export {
  NamespacedStore,
  VersionConflictError,
} from "./storage/namespaced-store.ts";
export type { VersionedValue } from "./storage/namespaced-store.ts";

export { CoreRepository } from "./storage/repository.ts";
export type { OptimizerInstanceRecord } from "./storage/repository.ts";

export {
  DefinitionNotFoundError,
  DefinitionRegistry,
} from "./definitions/registry.ts";

export { ControlPlane } from "./control-plane/service.ts";
