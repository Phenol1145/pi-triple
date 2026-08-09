import { randomUUID } from "node:crypto";
import type { AgentCreateSpec, AgentDefinition } from "./contracts.ts";
import type { ModelInfo } from "../types.ts";

// ── Helpers ────────────────────────────────────────────────────────

function providerPrefix(modelId: string): string {
  const slash = modelId.indexOf("/");
  return slash >= 0 ? modelId.slice(0, slash) : "unknown";
}

/**
 * Build the canonical `AgentDefinition` for a model candidate.
 * 跨域共享的纯转换（core 层——arena/schedulers 均可引用）。
 */
export function modelToAgentDefinition(model: ModelInfo): AgentDefinition {
  return {
    standard: {
      name: model.id,
      capabilities: [],
      executionKind: "model-candidate",
      labels: { provider: providerPrefix(model.id) },
    },
    workLoop: {
      id: "pi-default-loop",
      version: "1.0.0",
      config: {
        cwd: process.cwd(),
        contextMode: "fresh",
        model: model.id,
      },
    },
    custom: { model: structuredClone(model) },
  };
}

/**
 * Build an `AgentCreateSpec` for a model candidate (UUID id + definition).
 * 跨域共享的纯转换（core 层）。
 */
export function modelToAgentCreateSpec(
  model: ModelInfo,
  _idNamespace?: string,
): AgentCreateSpec {
  return {
    id: randomUUID(),
    definition: modelToAgentDefinition(model),
  };
}
