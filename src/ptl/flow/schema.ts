/**
 * pit-flow 图定义 schema + validate
 */

import { parseExpr } from "./expr.js";
import { parseStateField, VALID_REDUCERS, type StateFieldDef } from "./reducers.js";

// ── Types ─────────────────────────────────────────────────────

export interface FlowDef {
  name: string;
  entry: string;
  maxSteps?: number;
  maxParallel?: number;
  state?: Record<string, unknown>;  // v2: may contain {initial,reducer} objects; v1 bare values also accepted
  nodes: NodeDef[];
  edges: EdgeDef[];
}

export interface NodeDef {
  id: string;
  type: "agent" | "human" | "code" | "effect";
  model?: string;
  template?: string;
  prompt?: string;
  message?: string;
  fn?: string;
  effect?: string;  // effect 节点：EffectRegistry 注册名
  args?: string[];
  metrics?: Record<string, Record<string, string>>;
  tools?: string[];
  cwd?: string;
  timeoutSec?: number;
  needs?: string[];  // v2: explicit AND-join predecessors
  writes?: Record<string, string>;
}

export interface EdgeDef {
  from: string;
  to: string;
  when?: string;
}

// ── Validate ──────────────────────────────────────────────────

export function validateFlow(
  raw: unknown,
): { ok: true; def: FlowDef; warnings: string[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["flow must be a JSON object"] };
  }
  const obj = raw as Record<string, unknown>;

  const name = requireString(obj, "name", errors);
  const entry = requireString(obj, "entry", errors);
  const nodes = requireArray(obj, "nodes", errors);
  const edges = requireArray(obj, "edges", errors);

  // maxSteps (optional, defaults to 100)
  let maxSteps = 100;
  if ("maxSteps" in obj && obj.maxSteps !== undefined) {
    if (typeof obj.maxSteps !== "number" || !Number.isInteger(obj.maxSteps) || obj.maxSteps < 1) {
      errors.push("maxSteps must be a positive integer");
    } else {
      maxSteps = obj.maxSteps as number;
    }
  }

  // maxParallel (v2, optional, defaults to 4)
  let maxParallel = 4;
  if ("maxParallel" in obj && obj.maxParallel !== undefined) {
    if (typeof obj.maxParallel !== "number" || !Number.isInteger(obj.maxParallel) || obj.maxParallel < 1) {
      errors.push("maxParallel must be a positive integer");
    } else {
      maxParallel = obj.maxParallel as number;
    }
  }

  // state (optional)
  let state: Record<string, unknown> = {};
  const parsedState: Record<string, StateFieldDef> = {};
  if ("state" in obj && obj.state !== undefined) {
    if (typeof obj.state !== "object" || obj.state === null || Array.isArray(obj.state)) {
      errors.push("state must be an object or null");
    } else {
      state = obj.state as Record<string, unknown>;
      // v2: parse each state field
      for (const [k, v] of Object.entries(state)) {
        const field = parseStateField(v);
        parsedState[k] = field;
        if (field.reducer === "append" && !Array.isArray(field.initial)) {
          errors.push(`state.${k}: reducer "append" requires initial to be an array`);
        }
      }
    }
  }

  // nodes validation
  const nodeDefs: NodeDef[] = [];
  const nodeIds = new Set<string>();

  if (Array.isArray(nodes)) {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (!n || typeof n !== "object") {
        errors.push(`nodes[${i}]: must be an object`);
        continue;
      }
      const nObj = n as Record<string, unknown>;
      const id = requireString(nObj, "id", errors, `nodes[${i}]`);
      const type = requireString(nObj, "type", errors, `nodes[${i}]`);

      if (id && nodeIds.has(id)) {
        errors.push(`nodes[${i}]: duplicate id "${id}"`);
      }
      if (id) nodeIds.add(id);

      if (type && type !== "agent" && type !== "human" && type !== "code" && type !== "effect") {
        errors.push(`nodes[${i}]: type must be "agent", "human", "code" or "effect", got "${type}"`);
      }

      const node: NodeDef = { id: id ?? `_invalid_${i}`, type: (type as "agent" | "human" | "code" | "effect") ?? "agent" };

      if (type === "agent") {
        if (!nObj.prompt) {
          errors.push(`nodes[${i}] (agent "${id || "?"}"): prompt is required`);
        } else if (typeof nObj.prompt !== "string") {
          errors.push(`nodes[${i}] (agent "${id || "?"}"): prompt must be a string`);
        } else {
          node.prompt = nObj.prompt as string;
        }

        if (nObj.model !== undefined) {
          if (typeof nObj.model !== "string") errors.push(`nodes[${i}] (agent "${id}"): model must be a string`);
          else node.model = nObj.model as string;
        }
        // N1: 旧字段 tenant 已重命名为 template，干净切断（不静默忽略）
        if (nObj.tenant !== undefined) {
          errors.push(`nodes[${i}] (agent "${id}"): 节点字段 'tenant' 已重命名为 'template'，请更新 flow 定义`);
        }
        if (nObj.template !== undefined) {
          if (typeof nObj.template !== "string") errors.push(`nodes[${i}] (agent "${id}"): template must be a string`);
          else node.template = nObj.template as string;
        }
        if (nObj.tools !== undefined) {
          if (!Array.isArray(nObj.tools) || !nObj.tools.every((t: unknown) => typeof t === "string")) {
            errors.push(`nodes[${i}] (agent "${id}"): tools must be a string array`);
          } else {
            node.tools = nObj.tools as string[];
          }
        }
        if (nObj.timeoutSec !== undefined) {
          if (typeof nObj.timeoutSec !== "number" || nObj.timeoutSec < 1) {
            errors.push(`nodes[${i}] (agent "${id}"): timeoutSec must be a positive number`);
          } else {
            node.timeoutSec = nObj.timeoutSec as number;
          }
        }
      }

      if (type === "human") {
        if (!nObj.message) {
          errors.push(`nodes[${i}] (human "${id || "?"}"): message is required`);
        } else if (typeof nObj.message !== "string") {
          errors.push(`nodes[${i}] (human "${id || "?"}"): message must be a string`);
        } else {
          node.message = nObj.message as string;
        }
      }

      if (type === "code") {
        if (nObj.fn === undefined || nObj.fn === null) {
          errors.push(`nodes[${i}] (code "${id || "?"}"): fn is required`);
        } else if (typeof nObj.fn !== "string") {
          errors.push(`nodes[${i}] (code "${id || "?"}"): fn must be a string`);
        } else {
          node.fn = nObj.fn as string;
        }

        if (nObj.args !== undefined) {
          if (!Array.isArray(nObj.args) || !nObj.args.every((a: unknown) => typeof a === "string")) {
            errors.push(`nodes[${i}] (code "${id}"): args must be a string array`);
          } else {
            node.args = nObj.args as string[];
          }
        }
      }

      if (type === "effect") {
        // effect 字段 = 注册名（EffectRegistry 白名单），缺省/非字符串 → 校验报错
        if (nObj.effect === undefined || nObj.effect === null) {
          errors.push(`nodes[${i}] (effect "${id || "?"}"): effect is required`);
        } else if (typeof nObj.effect !== "string") {
          errors.push(`nodes[${i}] (effect "${id || "?"}"): effect must be a string`);
        } else {
          node.effect = nObj.effect as string;
        }

        if (nObj.args !== undefined) {
          if (!Array.isArray(nObj.args) || !nObj.args.every((a: unknown) => typeof a === "string")) {
            errors.push(`nodes[${i}] (effect "${id}"): args must be a string array`);
          } else {
            node.args = nObj.args as string[];
          }
        }
      }

      // cwd validation
      if (nObj.cwd !== undefined) {
        if (typeof nObj.cwd !== "string") {
          errors.push(`nodes[${i}] ("${id}"): cwd must be a string`);
        } else {
          const cwd = nObj.cwd as string;
          if (cwd.includes("..")) {
            errors.push(`nodes[${i}] ("${id}"): cwd must not contain ".."`);
          } else {
            node.cwd = cwd;
          }
        }
      }

      // writes validation
      if (nObj.writes !== undefined) {
        if (typeof nObj.writes !== "object" || nObj.writes === null || Array.isArray(nObj.writes)) {
          errors.push(`nodes[${i}] ("${id}"): writes must be an object`);
        } else {
          node.writes = nObj.writes as Record<string, string>;
        }
      }

      // needs validation (v2)
      if (nObj.needs !== undefined) {
        if (!Array.isArray(nObj.needs) || !nObj.needs.every((n: unknown) => typeof n === "string")) {
          errors.push(`nodes[${i}] ("${id}"): needs must be a string array`);
        } else {
          node.needs = nObj.needs as string[];
        }
      }

      // metrics validation (all node types)
      if (nObj.metrics !== undefined) {
        if (typeof nObj.metrics !== "object" || nObj.metrics === null || Array.isArray(nObj.metrics)) {
          errors.push(`nodes[${i}] ("${id}"): metrics must be an object of string-string maps`);
        } else {
          const metrics = nObj.metrics as Record<string, unknown>;
          const parsedMetrics: Record<string, Record<string, string>> = {};
          for (const [domain, map] of Object.entries(metrics)) {
            if (typeof map !== "object" || map === null || Array.isArray(map)) {
              errors.push(`nodes[${i}] ("${id}"): metrics.${domain} must be an object`);
              continue;
            }
            const out: Record<string, string> = {};
            for (const [k, v] of Object.entries(map as Record<string, unknown>)) {
              if (typeof v !== "string") {
                errors.push(`nodes[${i}] ("${id}"): metrics.${domain}.${k} must be a string`);
              } else {
                out[k] = v;
              }
            }
            parsedMetrics[domain] = out;
          }
          node.metrics = parsedMetrics;
        }
      }

      nodeDefs.push(node);
    }
  }

  // edges validation
  const edgeDefs: EdgeDef[] = [];
  if (Array.isArray(edges)) {
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      if (!e || typeof e !== "object") {
        errors.push(`edges[${i}]: must be an object`);
        continue;
      }
      const eObj = e as Record<string, unknown>;
      const from = requireString(eObj, "from", errors, `edges[${i}]`);
      const to = requireString(eObj, "to", errors, `edges[${i}]`);

      const edge: EdgeDef = { from: from ?? `_invalid_from_${i}`, to: to ?? `_invalid_to_${i}` };

      if (eObj.when !== undefined) {
        if (typeof eObj.when !== "string") {
          errors.push(`edges[${i}]: when must be a string`);
        } else {
          edge.when = eObj.when as string;
          // 静态解析校验
          const parsed = parseExpr(edge.when);
          if (!parsed.ok) {
            errors.push(`edges[${i}]: when expression parse error — ${parsed.error}`);
          }
        }
      }

      edgeDefs.push(edge);
    }
  }

  // 引用完整性
  const allRefs = new Set(nodeDefs.map((n) => n.id));
  allRefs.add("end"); // "end" is a special valid target

  if (entry && !allRefs.has(entry)) {
    errors.push(`entry "${entry}" does not reference a valid node`);
  }

  for (let i = 0; i < edgeDefs.length; i++) {
    const e = edgeDefs[i];
    if (e.from && !allRefs.has(e.from)) {
      errors.push(`edges[${i}]: from "${e.from}" does not reference a valid node`);
    }
    if (e.to && !allRefs.has(e.to)) {
      errors.push(`edges[${i}]: to "${e.to}" does not reference a valid node`);
    }
  }

  // 不可达节点检测（仅 warning）
  if (errors.length === 0 && entry) {
    const reachable = new Set<string>();
    function walk(id: string) {
      if (reachable.has(id)) return;
      reachable.add(id);
      if (id === "end") return;
      for (const e of edgeDefs) {
        if (e.from === id) walk(e.to);
      }
    }
    walk(entry);
    for (const n of nodeDefs) {
      if (!reachable.has(n.id)) {
        warnings.push(`node "${n.id}" is not reachable from entry`);
      }
    }
  }

  // ── v2 validation (only when no structural errors) ───────────
  if (errors.length === 0) {
    // per-node: 多条无条件出边 → warning（fallback 时全部触发 fan-out，与 v1 最后一条生效不等价）
    for (const n of nodeDefs) {
      const unconditionalEdges = edgeDefs.filter((e) => e.from === n.id && !e.when);
      if (unconditionalEdges.length > 1) {
        warnings.push(`node "${n.id}" has ${unconditionalEdges.length} unconditional outgoing edges — all fire together when no when-edge matches (differs from v1 last-wins)`);
      }

      // fan-out detection: when edges that may all hit → warning
      if (n.type === "agent") {
        const whenEdges = edgeDefs.filter((e) => e.from === n.id && e.when);
        if (whenEdges.length >= 2) {
          warnings.push(`node "${n.id}" has ${whenEdges.length} when-conditioned edges — all matching conditions trigger fan-out in v2 (v1 would only follow the first match)`);
        }
      }
    }

    // needs validation
    for (const n of nodeDefs) {
      if (!n.needs || n.needs.length === 0) continue;

      // needs references must exist
      for (const need of n.needs) {
        if (!allRefs.has(need)) {
          errors.push(`node "${n.id}": needs references non-existent node "${need}"`);
        }
      }

      // needs 环检测
      if (n.needs.length > 0) {
        const color = new Map<string, 0 | 1 | 2>();
        function needsCycleCheck(nodeId: string): boolean {
          const c = color.get(nodeId) ?? 0;
          if (c === 1) return true;
          if (c === 2) return false;
          color.set(nodeId, 1);
          const node = nodeDefs.find((x) => x.id === nodeId);
          if (node?.needs) {
            for (const need of node.needs) {
              if (needsCycleCheck(need)) return true;
            }
          }
          color.set(nodeId, 2);
          return false;
        }
        if (needsCycleCheck(n.id)) {
          errors.push(`node "${n.id}": needs cycle detected — cannot start (needs relations cannot form cycles)`);
        }
      }

      // needs must equal all static incoming edges
      const staticPredecessors = new Set<string>();
      for (const e of edgeDefs) {
        if (e.to === n.id && e.from !== "end") {
          staticPredecessors.add(e.from);
        }
      }
      const needsSet = new Set(n.needs);
      const onlyInNeeds = [...needsSet].filter((x) => !staticPredecessors.has(x));
      const onlyInEdges = [...staticPredecessors].filter((x) => !needsSet.has(x));
      if (onlyInNeeds.length > 0 || onlyInEdges.length > 0) {
        errors.push(
          `node "${n.id}": needs must exactly match all static incoming edges. ` +
          (onlyInNeeds.length > 0 ? `Missing edges to: ${onlyInNeeds.join(", ")}. ` : "") +
          (onlyInEdges.length > 0 ? `needs missing: ${onlyInEdges.join(", ")}.` : "")
        );
      }
    }

    // last-wins multi-writer detection → warning
    for (const [stateKey, field] of Object.entries(parsedState)) {
      if (field.reducer === "last-wins") {
        const writers = nodeDefs.filter((n) => n.writes && stateKey in n.writes);
        if (writers.length > 1) {
          writers.sort((a, b) => a.id.localeCompare(b.id));
          warnings.push(
            `state.${stateKey}: reducer "last-wins" with ${writers.length} writers ` +
            `(${writers.map((w) => w.id).join(", ")}) — ` +
            `result is determined by nodeId dictionary order (${writers[writers.length - 1]!.id} wins)`
          );
        }
      }
    }

    // cycle detection on edges → warning
    {
      const color = new Map<string, 0 | 1 | 2>(); // 0=white 1=gray 2=black
      function edgeCycleCheck(nodeId: string): boolean {
        const c = color.get(nodeId) ?? 0;
        if (c === 1) return true;  // back edge
        if (c === 2) return false; // already fully explored
        color.set(nodeId, 1);
        for (const e of edgeDefs) {
          if (e.from === nodeId && e.to !== "end") {
            if (edgeCycleCheck(e.to)) return true;
          }
        }
        color.set(nodeId, 2);
        return false;
      }
      if (edgeCycleCheck(entry!)) {
        warnings.push("graph contains cycles — ensure maxSteps is set to prevent infinite loops");
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    def: { name: name!, entry: entry!, maxSteps, maxParallel, state, nodes: nodeDefs, edges: edgeDefs },
    warnings,
  };
}

// ── Helpers ───────────────────────────────────────────────────

function requireString(
  obj: Record<string, unknown>,
  key: string,
  errors: string[],
  prefix = "",
): string | null {
  const label = prefix ? `${prefix}.${key}` : key;
  if (!(key in obj) || obj[key] === undefined || obj[key] === null) {
    errors.push(`${label}: required`);
    return null;
  }
  if (typeof obj[key] !== "string") {
    errors.push(`${label}: must be a string, got ${typeof obj[key]}`);
    return null;
  }
  return obj[key] as string;
}

function requireArray(
  obj: Record<string, unknown>,
  key: string,
  errors: string[],
): unknown[] | null {
  if (!(key in obj) || obj[key] === undefined) {
    errors.push(`${key}: required`);
    return null;
  }
  if (!Array.isArray(obj[key])) {
    errors.push(`${key}: must be an array`);
    return null;
  }
  return obj[key] as unknown[];
}
