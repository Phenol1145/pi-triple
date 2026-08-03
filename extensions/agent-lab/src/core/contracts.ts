export type JsonSchema = Readonly<Record<string, unknown>>;
export type DefinitionKind = "scheduler" | "workloop" | "optimizer";

export interface DefinitionRef {
  kind: DefinitionKind;
  id: string;
  version: string;
}

export interface ValidationIssue {
  path: string;
  code: string;
  message: string;
}

export interface ValidationReport {
  ok: boolean;
  issues: ValidationIssue[];
  validatedAt: number;
}

export type ValidationResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; issues: ValidationIssue[] };

interface DefinitionBase {
  kind: DefinitionKind;
  id: string;
  version: string;
  sdkVersionRange: string;
}

export interface SchedulerDefinition extends DefinitionBase {
  kind: "scheduler";
  parameterModelVersion: string;
  agentDefinitionSchemaVersion: string;
  parameterSchema: JsonSchema;
  agentDefinitionSchema: JsonSchema;
  schedulerStateSchema?: JsonSchema;
  defaultParameters: unknown;
  tunablePaths: string[];
  validateParameters(value: unknown): ValidationResult;
  validateAgentDefinition(value: unknown): ValidationResult;
  validateTransition?(current: unknown, proposed: unknown): ValidationResult;
}

export interface WorkLoopDefinition extends DefinitionBase {
  kind: "workloop";
  configSchema: JsonSchema;
  stateSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  errorSchema?: JsonSchema;
  traceSchema?: JsonSchema;
  requiredCapabilities: string[];
  cloneModes: string[];
}

export interface OptimizerDefinition extends DefinitionBase {
  kind: "optimizer";
  configurationSchema: JsonSchema;
  stateSchema?: JsonSchema;
  requiredMetrics: string[];
  compatibleSchedulers: Array<{ id: string; versionRange: string }>;
  parameterModelVersionRange: string;
}

export type LabDefinition = SchedulerDefinition | WorkLoopDefinition | OptimizerDefinition;

export interface DefinitionSummary extends DefinitionRef {
  sdkVersionRange: string;
}

export interface AgentDefinition {
  standard: {
    name: string;
    description?: string;
    capabilities: string[];
    executionKind: string;
    labels: Record<string, string>;
  };
  workLoop: { id: string; version: string; config: unknown };
  custom: unknown;
}

export type SchedulerInstanceStatus = "draft" | "active" | "inactive" | "migrating";
export type OptimizationRoundStatus = "initial" | "proposed" | "validated" | "canary" | "active" | "rejected" | "superseded" | "rolled-back";
export type AgentInstanceStatus = "ready" | "running" | "queued" | "inactive" | "failed";

export interface FallbackTargetScheduler { type: "scheduler-instance"; id: string }
export interface FallbackTargetOriginal { type: "original-request" }
export interface FallbackTargetFail { type: "fail"; errorCode: string }
export type FallbackTarget = FallbackTargetScheduler | FallbackTargetOriginal | FallbackTargetFail;

export interface AgentCreateSpec {
  id: string;
  definition: AgentDefinition;
  sourceAgentId?: string;
  cloneOperationId?: string;
}

export interface SchedulerInstanceDraftSpec {
  id: string;
  /** Logical instance name (mutable identity attribute; UUID id is the stable identity). */
  name?: string;
  schedulerDefinition: DefinitionRef;
  initialParameters?: unknown;
  agents: AgentCreateSpec[];
  fallbackChain: FallbackTarget[];
  routingBindings: Array<{
    id: string;
    /** Logical routing binding name (falls back to id when not specified). */
    name?: string;
    priority: number;
    match: { role?: string; taskCategory?: string; labels?: Record<string, string>; caller?: string };
  }>;
  metadata?: Record<string, string>;
}

export interface SchedulerInstanceRecord {
  id: string;
  name: string;
  definition: DefinitionRef;
  parameterModelVersion: string;
  agentDefinitionSchemaVersion: string;
  status: SchedulerInstanceStatus;
  currentRoundId: string;
  canaryRoundId?: string;
  canaryPercent?: number;
  fallbackChain: FallbackTarget[];
  createdAt: number;
}

export interface OptimizationRoundRecord {
  id: string;
  schedulerInstanceId: string;
  sequence: number;
  parentRoundId?: string;
  parameters: unknown;
  optimizer?: { instanceId: string; definitionId: string; definitionVersion: string };
  proposalId?: string;
  status: OptimizationRoundStatus;
  createdAt: number;
  activatedAt?: number;
}

/** 记忆规格（spec §2.3 MemorySpecSchema；装配注册持久化字段，结构与装配层 MemorySpec 一致）。 */
export interface MemorySpec {
  dialect?: "json" | "xml" | "markdown"; // markdown = draft-only 方言
  maxEntries?: number;
}

export interface AgentInstanceRecord {
  id: string;
  schedulerInstanceId: string;
  definition: AgentDefinition;
  model?: string;
  sourceTemplateId?: string;
  sourceAgentId?: string;
  cloneOperationId?: string;
  /** 装配注册持久化（spec §2.2 step 5 N-I9）：记忆规格（可空列 memory_spec）。 */
  memorySpec?: MemorySpec;
  /** 装配注册持久化（spec §2.2 step 5 N-I9）：初始资本（可空列 endowment）。 */
  endowment?: { K: number; initialFloor: number };
  /** elo（spec §3.2）：全局分（初始 1500，可空列 elo_global）。 */
  eloGlobal?: number;
  /** elo 分域分 JSON map（spec §3.2，可空列 elo_by_domain）；回退 byDomain[t] ?? global。 */
  eloByDomain?: Record<string, number>;
  /** 承接声明（spec §4.1）：该 agent 可承接的任务类型 id 数组（可空列 accepts，JSON array）。 */
  accepts?: string[];
  createdAtRoundId: string;
  status: AgentInstanceStatus;
  createdAt: number;
}

export interface LabEvent<TPayload = unknown> {
  eventId: string;
  eventType: string;
  schemaVersion: string;
  timestamp: number;
  sequence?: number;
  identity: {
    traceId: string;
    sessionId?: string;
    dispatchId?: string;
    executionId?: string;
    parentExecutionId?: string;
    schedulerInstanceId?: string;
    schedulerDefinitionId?: string;
    schedulerDefinitionVersion?: string;
    optimizationRoundId?: string;
    agentInstanceId?: string;
    workLoopId?: string;
    workLoopVersion?: string;
    /** 状态机转移序号（spec §7.2：状态级事件以 (traceId, transitionSeq) 关联来源转移）。 */
    transitionSeq?: number;
    checkpointId?: string;
    optimizerInstanceId?: string;
    proposalId?: string;
  };
  payload: TPayload;
  metrics?: Record<string, string | number | boolean | null>;
  artifactRefs?: string[];
}