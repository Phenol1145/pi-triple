import type { ModelInfo } from "../types.ts";
import type { LabCore } from "../core/contracts.ts";
import { modelToAgentCreateSpec } from "../schedulers/weighted-scorer.ts";

/**
 * 按 model 查找或创建 AgentInstance（按 model 幂等，返回稳定 UUID）。
 * UNIQUE 索引 (scheduler_instance_id, model) + INSERT OR IGNORE 防并发重复（I4）。
 */
export function findOrCreateAgentByModel(
  core: LabCore,
  schedulerInstanceId: string,
  model: ModelInfo,
  sourceTemplateId?: string,
): string {
  const existing = core.repository.findAgentByModel(schedulerInstanceId, model.id);
  if (existing) return existing.id;

  const spec = modelToAgentCreateSpec(model);
  const instance = core.repository.getInstance(schedulerInstanceId);
  const roundId = instance?.currentRoundId ?? "";  // 内部取，不闭包（N2）

  // INSERT：并发时 UNIQUE 索引可能触发约束冲突 → catch 后重查
  try {
    core.repository.insertAgent({
      id: spec.id,
      schedulerInstanceId,
      definition: spec.definition,
      model: model.id,
      sourceTemplateId,
      createdAtRoundId: roundId,
      status: "ready",
      createdAt: Date.now(),
    });
  } catch {
    // UNIQUE 约束冲突：另一条执行路径已创建同 model agent，重查
  }

  const created = core.repository.findAgentByModel(schedulerInstanceId, model.id);
  return created?.id ?? spec.id;
}

/**
 * 会话启动时确保 agent 实例存在（pit 设 PI_AGENT_INSTANCE_ID，agent-lab 拥有表——C2）。
 * 幂等：若该 model 已有 agent（UNIQUE scheduler_instance_id+model），复用其 id；
 * 否则用 pit 给的 agentInstanceId 创建。返回实际用的 agent id。
 */
export function ensureSessionAgent(
  core: LabCore,
  agentInstanceId: string,
  schedulerInstanceId: string,
  model: ModelInfo,
  sourceTemplateId?: string,
): string {
  // 若 model 已有 agent（bootstrap 建的），复用（避免 UNIQUE model 冲突）
  const existingByModel = core.repository.findAgentByModel(schedulerInstanceId, model.id);
  if (existingByModel) return existingByModel.id;

  const spec = modelToAgentCreateSpec(model);
  const instance = core.repository.getInstance(schedulerInstanceId);
  const roundId = instance?.currentRoundId ?? "";

  try {
    core.repository.insertAgent({
      id: agentInstanceId,   // pit 给的 UUID
      schedulerInstanceId,
      definition: spec.definition,
      model: model.id,
      sourceTemplateId,
      createdAtRoundId: roundId,
      status: "ready",
      createdAt: Date.now(),
    });
    return agentInstanceId;
  } catch {
    // UNIQUE 冲突（并发或 model 已有 agent）：重查
    const created = core.repository.findAgentByModel(schedulerInstanceId, model.id);
    return created?.id ?? agentInstanceId;
  }
}
