// Bucket export for the `assembly` domain.
// Aggregates the externally-consumed public API (functions, classes, types,
// constants). Pure re-exports only — no new logic; deep imports remain
// fully compatible and are unaffected.
export { AgentRuntime } from "./agent-runtime.ts";
export type { AgentRuntimeDeps } from "./agent-runtime.ts";

export { createAgentAssembler } from "./assembler.ts";
export type { AgentAssembler, AgentAssemblerDeps } from "./assembler.ts";

export { CommsBridge } from "./comms-bridge.ts";
export { validateAgainstSchema } from "./json-schema-min.ts";
export { SqliteLedgerAdapter } from "./ledger-port.ts";
export type { LedgerPort } from "./ledger-port.ts";
export { MemoryHost } from "./memory-host.ts";
export { PublicDomainBootstrap } from "./public-bootstrap.ts";
export { RuleBootstrap } from "./rule-bootstrap.ts";

export {
  ASSEMBLY_DIR,
  IDENTITY_DIR,
  PUBLIC_DOMAIN_DIR,
  ROUND_SENTINEL,
  validateMemorySpec,
} from "./types.ts";
export type { MemorySpec } from "./types.ts";
