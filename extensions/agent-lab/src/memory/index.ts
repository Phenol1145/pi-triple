// Bucket export for the `memory` domain.
// Aggregates the externally-consumed public API (functions, classes, types,
// constants). Pure re-exports only — no new logic; deep imports remain
// fully compatible and are unaffected.
export { mountMemorySdk } from "./sdk.ts";
export type { CommsSdkPort, MemorySdkPort } from "./sdk.ts";

export { AXIOM_RULE_ID, createEntry } from "./entry.ts";
export type { MemoryEntry } from "./entry.ts";

export { MemoryPipeline } from "./pipeline.ts";
export type { PipelineTrace } from "./pipeline.ts";

export { MemoryStore } from "./store.ts";
export { DspBuilder } from "./dsp.ts";
export type { DspInput } from "./dsp.ts";
export { parseEbnf, validateAgainstGrammar } from "./ebnf.ts";
export { PublicDomainStore } from "./public-domain.ts";
export { RuleRegistry } from "./rules.ts";
export type { CompiledRule } from "./rules.ts";

export { CommsChannel, IdentityMap } from "./comms.ts";
export type { CommsMessage, CommsTransport } from "./comms.ts";

export { WatermarkManager } from "./watermark.ts";
export { parseDialect } from "./dialects.ts";
